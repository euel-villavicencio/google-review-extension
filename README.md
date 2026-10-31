# Google Review Link Extension

Zoho CRM extension for generating unique Google review tracking links, redirecting customers to the configured Google review page, updating Lead/Contact fields, and showing basic review request statistics.

This version is aligned with the requested stack:

- Python REST API backend.
- Heroku Postgres-compatible database through `DATABASE_URL`.
- React Zoho settings/dashboard widget.

## Project Layout

```text
backend-python/       Python Flask REST API
widget-src/           React/Vite Zoho widget source
zoho-widget-package/  Built widget package contents
zoho-functions/       Deluge button, install, sync, and follow-up functions
scripts/              Widget packaging script
```

## Python REST API

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

Run the schema once in Heroku Postgres or any compatible PostgreSQL database:

```text
backend-python/schema.sql
```

Health checks:

```powershell
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/health"
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/db-health"
```

## Widget Build

```powershell
cd "C:\Users\USER\Desktop\google-review-extension"
npm install
npm run build
```

The build creates the Zoho widget ZIP:

```text
google-review-settings-widget.zip
```

## Main API Endpoints

- `PUT /org_settings` saves one Zoho organisation's slug and Google review page.
- `GET /org_settings` loads that organisation's settings.
- `POST /review_links` generates the current Lead/Contact tracking link.
- `GET /<slug>/<module>/<record_id>` tracks an open and redirects to Google.
- `GET /dashboard/stats` returns the unique URL format and basic statistics for the React dashboard.
- `GET /review_links/unopened?days=7` returns generated links that have not been opened.
- `GET /crm_updates/pending` lets Zoho pull queued CRM updates as a fallback.

## Dashboard

The React widget now includes a Google Review Dashboard section showing:

- Unique tracking URL format.
- Total generated links.
- Opened and unopened links.
- Total opens.
- Follow-up task count.
- Per-module summary.
- Recent generated links.

## Important Behavior

- Regenerating a link does not reset an existing open count.
- `Review Left` is preserved and is not overwritten by later link opens.
- Each Zoho organisation has its own server connection key and unique slug.
- The backend stores only a hash of the server connection key.

## Koyeb deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for replacing the existing Koyeb service, environment variables, and Zoho widget upload. The configured API URL is `https://greview.koyeb.app` and the Zoho namespace is `googlereviewlink`.
