# Python REST API

This is the production-aligned backend requested for the Google Review Link extension.

- Python REST API using Flask.
- Heroku Postgres-compatible storage through `DATABASE_URL`.
- Generates unique Zoho CRM review links.
- Records review page opens before redirecting to the configured Google Review page.
- Exposes dashboard statistics for the React Zoho widget.

## Local Run

```powershell
cd backend-python
Copy-Item .env.example .env
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

Required environment:

```text
PORT=3000
PUBLIC_BASE_URL=https://greview.koyeb.app
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DATABASE
```

For Heroku, set `DATABASE_URL` from the Heroku Postgres add-on and deploy this folder.

## Endpoints

- `GET /health`
- `GET /db-health`
- `GET /org_settings`
- `PUT /org_settings`
- `POST /review_links`
- `GET /review_links/unopened`
- `GET /dashboard/stats`
- `POST /review_links/followups`
- `POST /review_links/followups/mark_created`
- `GET /crm_updates/pending`
- `POST /crm_updates/<id>/status`
- `GET /<slug>/<module>/<record_id>`
