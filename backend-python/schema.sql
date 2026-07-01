create table if not exists org_settings (
  crm_org_id text primary key,
  api_key_hash text not null,
  url_slug text not null unique,
  google_review_link text not null,
  review_open_sync_url text,
  default_module_api_name text not null default 'Leads',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table org_settings
  add column if not exists review_open_sync_url text;

create table if not exists sent_review_links (
  crm_org_id text not null references org_settings(crm_org_id) on delete cascade,
  module_api_name text not null,
  crm_record_id text not null,
  crm_record_name text,
  review_link text not null,
  created_at timestamptz not null default now(),
  last_generated_at timestamptz not null default now(),
  first_opened_at timestamptz,
  follow_up_task_created_at timestamptz,
  primary key (crm_org_id, module_api_name, crm_record_id)
);

alter table sent_review_links
  add column if not exists crm_record_name text;

create table if not exists review_page_visits (
  crm_org_id text not null references org_settings(crm_org_id) on delete cascade,
  module_api_name text not null,
  crm_record_id text not null,
  open_count integer not null default 0,
  first_opened_at timestamptz not null,
  last_opened_at timestamptz not null,
  primary key (crm_org_id, module_api_name, crm_record_id)
);

create table if not exists crm_sync_logs (
  id bigserial primary key,
  crm_org_id text not null,
  module_api_name text,
  crm_record_id text,
  event_type text not null,
  status text not null,
  review_link text,
  review_page_open_status text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create index if not exists idx_sent_review_links_unopened
  on sent_review_links (crm_org_id, last_generated_at)
  where first_opened_at is null and follow_up_task_created_at is null;
