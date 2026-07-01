import hashlib
import hmac
import json
import logging
import os
import re
import secrets
from datetime import datetime, timezone
from urllib.parse import parse_qsl, quote, urlencode, urlparse, urlunparse

import psycopg
from flask import Flask, jsonify, redirect, request
from flask_cors import CORS
from psycopg.rows import dict_row


slug_pattern = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
allowed_modules = {"Leads", "Contacts"}
module_aliases = {
    "Lead": "Leads",
    "Leads": "Leads",
    "Contact": "Contacts",
    "Contacts": "Contacts",
}
deluge_body_field_pattern = re.compile(
    r"[\"']?(module_api_name|crm_record_id|crm_record_name|days|records|status|error_message|url_slug|google_review_link|review_open_sync_url|default_module_api_name)[\"']?\s*[:=]\s*[\"']?([^,\"'}&]+)",
    re.IGNORECASE,
)
logger = logging.getLogger("google-review-api")


class AppError(Exception):
    def __init__(self, status_code, code):
        super().__init__(code)
        self.status_code = status_code
        self.code = code


class Store:
    def __init__(self, database_url):
        if not database_url:
            raise RuntimeError("DATABASE_URL is required")
        self.database_url = normalize_database_url(database_url)

    def connect(self):
        return psycopg.connect(self.database_url, row_factory=dict_row)

    def health(self):
        with self.connect() as conn:
            conn.execute("select 1")

    def get_org_by_id(self, crm_org_id, api_key):
        org = self.get_org("crm_org_id", crm_org_id)
        if not verify_api_key(api_key, org["api_key_hash"]):
            raise AppError(401, "invalid_credentials")
        return org

    def get_org_by_slug(self, slug):
        return self.get_org("url_slug", slug)

    def get_org(self, column, value):
        if column not in {"crm_org_id", "url_slug"}:
            raise ValueError("unsupported lookup")
        with self.connect() as conn:
            row = conn.execute(
                f"""
                select crm_org_id, api_key_hash, url_slug, google_review_link,
                       review_open_sync_url, default_module_api_name, created_at, updated_at
                from org_settings
                where {column} = %s
                limit 1
                """,
                (value,),
            ).fetchone()
        if not row:
            raise AppError(401, "invalid_credentials" if column == "crm_org_id" else "unknown_org_slug")
        return row

    def save_org_settings(self, crm_org_id, api_key, url_slug, google_review_link, default_module, review_open_sync_url):
        with self.connect() as conn:
            slug_owner = conn.execute(
                "select crm_org_id from org_settings where url_slug = %s limit 1",
                (url_slug,),
            ).fetchone()
            if slug_owner and slug_owner["crm_org_id"] != crm_org_id:
                raise AppError(409, "url_slug_already_taken")

            existing = conn.execute(
                "select * from org_settings where crm_org_id = %s limit 1",
                (crm_org_id,),
            ).fetchone()
            created = existing is None
            if existing and not verify_api_key(api_key, existing["api_key_hash"]):
                raise AppError(401, "invalid_credentials")

            api_key_hash = hash_api_key(api_key) if created else existing["api_key_hash"]
            if not review_open_sync_url and existing:
                review_open_sync_url = existing["review_open_sync_url"]

            row = conn.execute(
                """
                insert into org_settings (
                    crm_org_id, api_key_hash, url_slug, google_review_link,
                    review_open_sync_url, default_module_api_name, updated_at
                )
                values (%s, %s, %s, %s, %s, %s, now())
                on conflict (crm_org_id) do update set
                    url_slug = excluded.url_slug,
                    google_review_link = excluded.google_review_link,
                    review_open_sync_url = excluded.review_open_sync_url,
                    default_module_api_name = excluded.default_module_api_name,
                    updated_at = now()
                returning crm_org_id, api_key_hash, url_slug, google_review_link,
                          review_open_sync_url, default_module_api_name, created_at, updated_at
                """,
                (crm_org_id, api_key_hash, url_slug, google_review_link, review_open_sync_url, default_module),
            ).fetchone()
            return row, created

    def save_generated_link(self, org, module_api_name, crm_record_id, crm_record_name, review_link):
        with self.connect() as conn:
            existed = conn.execute(
                """
                select true from sent_review_links
                where crm_org_id = %s and module_api_name = %s and crm_record_id = %s
                """,
                (org["crm_org_id"], module_api_name, crm_record_id),
            ).fetchone() is not None
            has_existing_visit = conn.execute(
                """
                select true from review_page_visits
                where crm_org_id = %s and module_api_name = %s and crm_record_id = %s and open_count > 0
                """,
                (org["crm_org_id"], module_api_name, crm_record_id),
            ).fetchone() is not None
            row = conn.execute(
                """
                insert into sent_review_links (crm_org_id, module_api_name, crm_record_id, crm_record_name, review_link)
                values (%s, %s, %s, nullif(%s, ''), %s)
                on conflict (crm_org_id, module_api_name, crm_record_id) do update set
                    crm_record_name = coalesce(excluded.crm_record_name, sent_review_links.crm_record_name),
                    review_link = excluded.review_link,
                    last_generated_at = now()
                returning crm_org_id, module_api_name, crm_record_id, crm_record_name, review_link,
                          created_at, last_generated_at, first_opened_at, follow_up_task_created_at
                """,
                (org["crm_org_id"], module_api_name, crm_record_id, crm_record_name, review_link),
            ).fetchone()
            conn.execute(
                """
                insert into crm_sync_logs (crm_org_id, module_api_name, crm_record_id, event_type, status, review_link)
                values (%s, %s, %s, 'review_link_generated', 'queued', %s)
                """,
                (org["crm_org_id"], module_api_name, crm_record_id, review_link),
            )
            row["is_new"] = not existed
            row["has_existing_visit"] = has_existing_visit
            return row

    def track_open(self, org, module_api_name, crm_record_id, review_link):
        with self.connect() as conn:
            visit = conn.execute(
                """
                insert into review_page_visits (
                    crm_org_id, module_api_name, crm_record_id, open_count, first_opened_at, last_opened_at
                )
                values (%s, %s, %s, 1, now(), now())
                on conflict (crm_org_id, module_api_name, crm_record_id) do update set
                    open_count = review_page_visits.open_count + 1,
                    last_opened_at = now()
                returning open_count, last_opened_at
                """,
                (org["crm_org_id"], module_api_name, crm_record_id),
            ).fetchone()
            conn.execute(
                """
                update sent_review_links
                set first_opened_at = coalesce(first_opened_at, %s)
                where crm_org_id = %s and module_api_name = %s and crm_record_id = %s
                """,
                (visit["last_opened_at"], org["crm_org_id"], module_api_name, crm_record_id),
            )
            status = status_for_open_count(visit["open_count"])
            conn.execute(
                """
                insert into crm_sync_logs (
                    crm_org_id, module_api_name, crm_record_id, event_type, status, review_page_open_status
                )
                values (%s, %s, %s, 'review_page_opened', 'queued', %s)
                """,
                (org["crm_org_id"], module_api_name, crm_record_id, status),
            )
            return {
                "crm_org_id": org["crm_org_id"],
                "module_api_name": module_api_name,
                "crm_record_id": crm_record_id,
                "review_link": review_link,
                "open_count": visit["open_count"],
                "opened_at": visit["last_opened_at"],
                "review_page_open_status": status,
            }

    def find_unopened(self, org, days):
        with self.connect() as conn:
            rows = conn.execute(
                """
                select s.crm_org_id, s.module_api_name, s.crm_record_id, s.review_link,
                       s.created_at, s.last_generated_at, s.first_opened_at, s.follow_up_task_created_at
                from sent_review_links s
                left join review_page_visits v on v.crm_org_id = s.crm_org_id
                    and v.module_api_name = s.module_api_name
                    and v.crm_record_id = s.crm_record_id
                where s.crm_org_id = %s
                  and s.follow_up_task_created_at is null
                  and s.last_generated_at <= now() - (%s * interval '1 day')
                  and coalesce(v.open_count, 0) = 0
                order by s.last_generated_at asc
                """,
                (org["crm_org_id"], days),
            ).fetchall()
        return rows

    def mark_followups_created(self, crm_org_id, records):
        with self.connect() as conn:
            for record in records:
                status = record.get("status") or "created"
                conn.execute(
                    """
                    insert into crm_sync_logs (crm_org_id, module_api_name, crm_record_id, event_type, status, error_message)
                    values (%s, %s, %s, 'follow_up_task_created', %s, %s)
                    """,
                    (
                        crm_org_id,
                        record.get("module_api_name"),
                        record.get("crm_record_id"),
                        status,
                        record.get("error") or None,
                    ),
                )
                if status == "created":
                    conn.execute(
                        """
                        update sent_review_links
                        set follow_up_task_created_at = now()
                        where crm_org_id = %s and module_api_name = %s and crm_record_id = %s
                        """,
                        (crm_org_id, record.get("module_api_name"), record.get("crm_record_id")),
                    )

    def pending_crm_updates(self, org, limit):
        limit = max(1, min(limit or 50, 100))
        with self.connect() as conn:
            rows = conn.execute(
                """
                select l.id, l.event_type, l.module_api_name, l.crm_record_id,
                       coalesce(l.review_link, s.review_link) as review_link,
                       l.review_page_open_status,
                       v.open_count,
                       v.last_opened_at as opened_at,
                       l.created_at
                from crm_sync_logs l
                left join sent_review_links s on s.crm_org_id = l.crm_org_id
                    and s.module_api_name = l.module_api_name
                    and s.crm_record_id = l.crm_record_id
                left join review_page_visits v on v.crm_org_id = l.crm_org_id
                    and v.module_api_name = l.module_api_name
                    and v.crm_record_id = l.crm_record_id
                where l.crm_org_id = %s
                  and l.status = 'queued'
                  and l.event_type in ('review_link_generated', 'review_page_opened')
                order by l.created_at asc, l.id asc
                limit %s
                """,
                (org["crm_org_id"], limit),
            ).fetchall()
        return rows

    def mark_crm_update(self, org, log_id, status, error_message):
        with self.connect() as conn:
            conn.execute(
                """
                update crm_sync_logs
                set status = %s, error_message = nullif(%s, ''), updated_at = now()
                where id = %s and crm_org_id = %s
                """,
                (status, error_message or "", log_id, org["crm_org_id"]),
            )

    def mark_latest_open_synced(self, sync, status, error_message=""):
        with self.connect() as conn:
            conn.execute(
                """
                update crm_sync_logs
                set status = %s, error_message = nullif(%s, ''), updated_at = now()
                where id = (
                    select id
                    from crm_sync_logs
                    where crm_org_id = %s and module_api_name = %s and crm_record_id = %s
                      and event_type = 'review_page_opened'
                    order by created_at desc, id desc
                    limit 1
                )
                """,
                (status, error_message, sync["crm_org_id"], sync["module_api_name"], sync["crm_record_id"]),
            )

    def dashboard_stats(self, org):
        with self.connect() as conn:
            totals = conn.execute(
                """
                select
                  count(*)::int as generated_links,
                  count(*) filter (where s.first_opened_at is not null)::int as opened_links,
                  count(*) filter (where s.first_opened_at is null)::int as unopened_links,
                  count(*) filter (where s.follow_up_task_created_at is not null)::int as follow_up_tasks,
                  coalesce(sum(v.open_count), 0)::int as total_opens,
                  coalesce(max(v.last_opened_at), null) as last_opened_at
                from sent_review_links s
                left join review_page_visits v on v.crm_org_id = s.crm_org_id
                  and v.module_api_name = s.module_api_name
                  and v.crm_record_id = s.crm_record_id
                where s.crm_org_id = %s
                """,
                (org["crm_org_id"],),
            ).fetchone()
            by_module = conn.execute(
                """
                select s.module_api_name,
                       count(*)::int as generated_links,
                       count(*) filter (where s.first_opened_at is not null)::int as opened_links,
                       coalesce(sum(v.open_count), 0)::int as total_opens
                from sent_review_links s
                left join review_page_visits v on v.crm_org_id = s.crm_org_id
                  and v.module_api_name = s.module_api_name
                  and v.crm_record_id = s.crm_record_id
                where s.crm_org_id = %s
                group by s.module_api_name
                order by s.module_api_name
                """,
                (org["crm_org_id"],),
            ).fetchall()
            recent = conn.execute(
                """
                select s.module_api_name, s.crm_record_id, s.crm_record_name, s.review_link, s.last_generated_at,
                       v.open_count, v.last_opened_at
                from sent_review_links s
                left join review_page_visits v on v.crm_org_id = s.crm_org_id
                  and v.module_api_name = s.module_api_name
                  and v.crm_record_id = s.crm_record_id
                where s.crm_org_id = %s
                order by s.last_generated_at desc
                limit 8
                """,
                (org["crm_org_id"],),
            ).fetchall()
        return {"totals": totals, "by_module": by_module, "recent_links": recent}


def create_app():
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
    app = Flask(__name__)
    CORS(app, resources={r"/*": {"origins": "*"}})
    app.config["PUBLIC_BASE_URL"] = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
    app.store = Store(os.getenv("DATABASE_URL"))

    @app.before_request
    def log_request():
        logger.info("[request] %s %s", request.method, request.full_path.rstrip("?"))

    @app.errorhandler(AppError)
    def handle_app_error(error):
        logger.warning("[app_error] %s status=%s path=%s", error.code, error.status_code, request.path)
        return jsonify({"error": error.code}), error.status_code

    @app.errorhandler(Exception)
    def handle_unexpected(error):
        logger.exception("unexpected error")
        return jsonify({"error": "internal_server_error"}), 500

    @app.get("/health")
    def health():
        return jsonify({"ok": True})

    @app.get("/db-health")
    def db_health():
        app.store.health()
        return jsonify({"postgres_status": 200})

    @app.get("/supabase-health")
    def supabase_compat_health():
        app.store.health()
        return jsonify({"postgres_status": 200})

    @app.get("/org_settings")
    def get_org_settings():
        auth = get_auth()
        org = app.store.get_org_by_id(auth["crm_org_id"], auth["api_key"])
        return jsonify(public_org(org))

    @app.put("/org_settings")
    def put_org_settings():
        auth = get_auth()
        body = get_request_body()
        url_slug = (body.get("url_slug") or "").strip().lower()
        google_review_link = (body.get("google_review_link") or "").strip()
        review_open_sync_url = (body.get("review_open_sync_url") or "").strip()
        default_module = normalize_module_api_name(body.get("default_module_api_name") or "Leads")
        validate_org_settings(url_slug, google_review_link, default_module, review_open_sync_url)
        org, created = app.store.save_org_settings(
            auth["crm_org_id"], auth["api_key"], url_slug, google_review_link, default_module, review_open_sync_url
        )
        payload = public_org(org)
        payload["example_review_link"] = build_review_link(public_base_url(), org["url_slug"], org["default_module_api_name"], "CRM_RECORD_ID")
        return jsonify(payload), 201 if created else 200

    @app.post("/review_links")
    def create_review_link():
        auth = get_auth()
        body = get_request_body()
        module_api_name = normalize_module_api_name(body.get("module_api_name") or "")
        crm_record_id = (body.get("crm_record_id") or "").strip()
        crm_record_name = (body.get("crm_record_name") or "").strip()
        validate_module_and_record(module_api_name, crm_record_id)
        org = app.store.get_org_by_id(auth["crm_org_id"], auth["api_key"])
        review_link = build_review_link(public_base_url(), org["url_slug"], module_api_name, crm_record_id)
        sync = app.store.save_generated_link(org, module_api_name, crm_record_id, crm_record_name, review_link)
        logger.info("[review-link] generated module=%s record=%s", module_api_name, crm_record_id)
        return jsonify({
            "review_link": review_link,
            "fields": {
                "Google_Review_Link": sync["review_link"],
                "Review_Page_Open_Status": generated_link_status(sync),
                "Review_Page_Open_Count": generated_link_open_count(sync),
                "Last_Review_Page_Opened_At": None,
            },
        })

    @app.get("/review_links/unopened")
    def get_unopened():
        auth = get_auth()
        days = parse_non_negative_int(request.args.get("days"), 7, "days_must_be_a_positive_number")
        org = app.store.get_org_by_id(auth["crm_org_id"], auth["api_key"])
        records = app.store.find_unopened(org, days)
        return jsonify({"days": days, "count": len(records), "records": serialize(records)})

    @app.post("/review_links/followups")
    def create_followups():
        auth = get_auth()
        body = get_request_body()
        days = int(body.get("days") or 7)
        if days < 0:
            raise AppError(400, "days_must_be_a_positive_number")
        org = app.store.get_org_by_id(auth["crm_org_id"], auth["api_key"])
        links = app.store.find_unopened(org, days)
        records = [
            {
                "module_api_name": link["module_api_name"],
                "crm_record_id": link["crm_record_id"],
                "status": "pending_zoho_task",
            }
            for link in links
        ]
        return jsonify({
            "days": days,
            "count": len(records),
            "records": records,
            "message": "Create Zoho Tasks from the scheduled Deluge function, then call /review_links/followups/mark_created.",
        })

    @app.post("/review_links/followups/mark_created")
    def mark_followups_created():
        auth = get_auth()
        org = app.store.get_org_by_id(auth["crm_org_id"], auth["api_key"])
        body = get_request_body()
        records = body.get("records") or []
        app.store.mark_followups_created(org["crm_org_id"], records)
        return jsonify({"ok": True, "count": len(records)})

    @app.get("/crm_updates/pending")
    def pending_updates():
        auth = get_auth()
        limit = parse_limit(request.args.get("limit"), 50)
        org = app.store.get_org_by_id(auth["crm_org_id"], auth["api_key"])
        records = app.store.pending_crm_updates(org, limit)
        return jsonify({"count": len(records), "records": serialize(records)})

    @app.post("/crm_updates/<int:update_id>/status")
    def mark_update(update_id):
        auth = get_auth()
        org = app.store.get_org_by_id(auth["crm_org_id"], auth["api_key"])
        body = get_request_body()
        status = (body.get("status") or "synced").strip()
        if status not in {"synced", "failed", "skipped"}:
            raise AppError(400, "invalid_status")
        app.store.mark_crm_update(org, update_id, status, body.get("error_message") or "")
        return jsonify({"ok": True})

    @app.get("/dashboard/stats")
    def dashboard_stats():
        auth = get_auth()
        org = app.store.get_org_by_id(auth["crm_org_id"], auth["api_key"])
        stats = app.store.dashboard_stats(org)
        return jsonify({
            "crm_org_id": org["crm_org_id"],
            "url_slug": org["url_slug"],
            "google_review_link": org["google_review_link"],
            "review_link_format": build_review_link(public_base_url(), org["url_slug"], org["default_module_api_name"], "CRM_RECORD_ID"),
            "default_module_api_name": org["default_module_api_name"],
            **serialize(stats),
        })

    @app.get("/<slug>/<path:tracking_path>")
    def tracking_redirect(slug, tracking_path):
        parts = [part for part in tracking_path.strip("/").split("/") if part]
        if len(parts) == 1:
            module_api_name = None
            crm_record_id = parts[0]
        elif len(parts) == 2:
            module_api_name, crm_record_id = parts
        else:
            raise AppError(404, "not_found")
        module_api_name = normalize_module_api_name(module_api_name) if module_api_name else None
        if module_api_name and module_api_name not in allowed_modules:
            raise AppError(400, "module_api_name_must_be_Leads_or_Contacts")
        if not is_valid_record_id(crm_record_id):
            raise AppError(400, "invalid_crm_record_id")
        org = app.store.get_org_by_slug(slug)
        module_api_name = module_api_name or org["default_module_api_name"] or "Leads"
        review_link = build_review_link(public_base_url(), org["url_slug"], module_api_name, crm_record_id)
        sync = app.store.track_open(org, module_api_name, crm_record_id, review_link)
        logger.info(
            '[tracking] open org=%s module=%s record=%s count=%s status="%s"',
            sync["crm_org_id"], sync["module_api_name"], sync["crm_record_id"], sync["open_count"], sync["review_page_open_status"],
        )
        if org.get("review_open_sync_url"):
            sync_open_through_zoho_function(app.store, org, sync)
        return redirect(org["google_review_link"], code=302)

    return app


def get_auth():
    crm_org_id = (request.headers.get("x-crm-org-id") or "").strip()
    api_key = (request.headers.get("x-api-key") or "").strip()
    if not crm_org_id:
        raise AppError(401, "missing_x_crm_org_id")
    if not api_key:
        raise AppError(401, "missing_x_api_key")
    return {"crm_org_id": crm_org_id, "api_key": api_key}


def get_request_body():
    json_body = request.get_json(silent=True)
    if isinstance(json_body, dict):
        return json_body

    if request.form:
        form_body = request.form.to_dict(flat=True)
        if len(form_body) == 1:
            only_key = next(iter(form_body.keys()))
            if only_key != str(request.get_data(as_text=True)).strip():
                parsed = parse_request_body_text(only_key)
                if parsed:
                    return parsed
        return form_body

    raw_body = request.get_data(as_text=True).strip()
    return parse_request_body_text(raw_body)


def parse_request_body_text(raw_body):
    if not raw_body:
        return {}

    try:
        parsed = json.loads(raw_body)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    form_pairs = dict(parse_qsl(raw_body, keep_blank_values=True))
    if form_pairs:
        if len(form_pairs) == 1:
            only_key = next(iter(form_pairs.keys()))
            if only_key != raw_body:
                parsed = parse_request_body_text(only_key)
                if parsed:
                    return parsed
        return form_pairs

    return {match.group(1): match.group(2) for match in deluge_body_field_pattern.finditer(raw_body)}


def validate_org_settings(url_slug, google_review_link, default_module, review_open_sync_url):
    if not slug_pattern.match(url_slug):
        raise AppError(400, "url_slug_must_use_lowercase_letters_numbers_and_hyphens")
    if not is_allowed_google_url(google_review_link):
        raise AppError(400, "google_review_link_must_be_a_google_https_url")
    if default_module not in allowed_modules:
        raise AppError(400, "default_module_api_name_must_be_Leads_or_Contacts")
    if review_open_sync_url and not is_allowed_zoho_function_url(review_open_sync_url):
        raise AppError(400, "review_open_sync_url_must_be_a_zoho_https_function_url")


def normalize_module_api_name(value):
    return module_aliases.get(str(value or "").strip(), str(value or "").strip())


def validate_module_and_record(module_api_name, crm_record_id):
    if module_api_name not in allowed_modules:
        raise AppError(400, "module_api_name_must_be_Leads_or_Contacts")
    if not is_valid_record_id(crm_record_id):
        raise AppError(400, "invalid_crm_record_id")


def is_valid_record_id(value):
    return bool(value) and len(value) <= 128


def is_allowed_google_url(value):
    parsed = urlparse(value)
    return parsed.scheme == "https" and (parsed.netloc == "google.com" or ".google." in parsed.netloc)


def is_allowed_zoho_function_url(value):
    parsed = urlparse(value)
    return (
        parsed.scheme == "https"
        and (parsed.netloc.endswith("zohoapis.com") or parsed.netloc.endswith("zohosandbox.com"))
        and "/functions/" in parsed.path
        and "/actions/execute" in parsed.path
    )


def normalize_database_url(database_url):
    parsed = urlparse(database_url)
    if parsed.scheme not in {"postgres", "postgresql"}:
        return database_url
    if parsed.hostname in {"localhost", "127.0.0.1"}:
        return database_url
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query.setdefault("sslmode", "require")
    return urlunparse(parsed._replace(query=urlencode(query)))


def public_base_url():
    host = request.headers.get("x-forwarded-host") or request.host
    if host:
        proto = request.headers.get("x-forwarded-proto")
        if not proto:
            proto = "http" if "localhost" in host or host.startswith("127.0.0.1") else "https"
        return f"{proto}://{host}"
    return current_app_base_url()


def current_app_base_url():
    return os.getenv("PUBLIC_BASE_URL", "").rstrip("/")


def build_review_link(base_url, slug, module_api_name, record_id):
    return f"{base_url.rstrip('/')}/{quote(slug)}/{quote(module_api_name)}/{quote(record_id)}"


def hash_api_key(api_key):
    salt = secrets.token_hex(16)
    digest = hashlib.scrypt(api_key.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=32)
    return f"scrypt:{salt}:{digest.hex()}"


def verify_api_key(api_key, stored_hash):
    parts = (stored_hash or "").split(":")
    if len(parts) != 3 or parts[0] != "scrypt" or not parts[1] or not parts[2]:
        return False
    try:
        expected = bytes.fromhex(parts[2])
        actual = hashlib.scrypt(api_key.encode(), salt=parts[1].encode(), n=16384, r=8, p=1, dklen=32)
        return hmac.compare_digest(actual, expected)
    except ValueError:
        return False


def status_for_open_count(open_count):
    if open_count <= 0:
        return "Not Opened"
    if open_count == 1:
        return "Opened Once"
    return "Opened Multiple Times"


def generated_link_status(sync):
    if sync.get("has_existing_visit"):
        return ""
    return "Not Opened" if sync.get("is_new") else ""


def generated_link_open_count(sync):
    if sync.get("has_existing_visit"):
        return None
    return 0 if sync.get("is_new") else None


def public_org(org):
    return {
        "crm_org_id": org["crm_org_id"],
        "url_slug": org["url_slug"],
        "google_review_link": org["google_review_link"],
        "review_open_sync_url": org.get("review_open_sync_url"),
        "default_module_api_name": org["default_module_api_name"],
    }


def parse_non_negative_int(value, fallback, error_code):
    if value is None or str(value).strip() == "":
        return fallback
    try:
        parsed = int(value)
    except ValueError:
        raise AppError(400, error_code)
    if parsed < 0:
        raise AppError(400, error_code)
    return parsed


def parse_limit(value, fallback):
    if value is None or str(value).strip() == "":
        return fallback
    try:
        parsed = int(value)
    except ValueError:
        raise AppError(400, "limit_must_be_between_1_and_100")
    if parsed <= 0 or parsed > 100:
        raise AppError(400, "limit_must_be_between_1_and_100")
    return parsed


def serialize(value):
    if isinstance(value, list):
        return [serialize(item) for item in value]
    if isinstance(value, dict):
        return {key: serialize(item) for key, item in value.items()}
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat().replace("+00:00", "Z")
    return value


def zoho_datetime(value):
    if not isinstance(value, datetime):
        return value
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    value = value.astimezone(timezone.utc).replace(microsecond=0)
    return value.isoformat()


def sync_open_through_zoho_function(store, org, sync):
    import requests

    payload = {
        "module_api_name": sync["module_api_name"],
        "crm_record_id": sync["crm_record_id"],
        "review_link": sync["review_link"],
        "open_count": sync["open_count"],
        "opened_at": zoho_datetime(sync["opened_at"]),
        "review_page_open_status": sync["review_page_open_status"],
    }
    try:
        response = requests.post(org["review_open_sync_url"], json=payload, timeout=12)
    except Exception as error:
        logger.warning("[zoho-rest-function] call failed org=%s error=%s", org["crm_org_id"], error)
        store.mark_latest_open_synced(sync, "failed", str(error))
        return
    response_body = response.text[:4000].strip()
    if response.status_code < 200 or response.status_code >= 300:
        logger.warning(
            "[zoho-rest-function] non-2xx org=%s module=%s record=%s status=%s body=%s",
            org["crm_org_id"], sync["module_api_name"], sync["crm_record_id"], response.status_code, response_body,
        )
        store.mark_latest_open_synced(sync, "failed", response_body)
        return
    response_body_lower = response_body.lower()
    if (
        "synced" not in response_body_lower
        or "failed" in response_body_lower
        or "missing_" in response_body_lower
        or "invalid" in response_body_lower
        or "error" in response_body_lower
    ):
        logger.warning(
            "[zoho-rest-function] rejected update org=%s module=%s record=%s status=%s body=%s",
            org["crm_org_id"], sync["module_api_name"], sync["crm_record_id"], response.status_code, response_body,
        )
        store.mark_latest_open_synced(sync, "failed", response_body)
        return
    store.mark_latest_open_synced(sync, "synced")
    logger.info(
        "[zoho-rest-function] synced open org=%s module=%s record=%s body=%s",
        org["crm_org_id"], sync["module_api_name"], sync["crm_record_id"], response_body,
    )


if __name__ == "__main__":
    app = create_app()
    port = int(os.getenv("PORT", "3000"))
    app.run(host="0.0.0.0", port=port)
