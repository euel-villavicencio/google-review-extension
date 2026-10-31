# Koyeb replacement deployment

This project uses https://greview.koyeb.app for the API and generated review links.
The Zoho extension namespace is `googlereviewlink`, matching Google_Review_Extension.

## Replace the existing service

Keep the existing Koyeb service/domain and PostgreSQL database when replacing the source.

For a Git deployment, select Dockerfile builder with repository root as the build
context/work directory and `backend-python/Dockerfile` as the Dockerfile path.
Set the exposed HTTP port to 3000 and health check path to `/health`.
The Dockerfile includes the Gunicorn start command and supports the PORT variable.

Environment variables:

- `PORT=3000`
- `PUBLIC_BASE_URL=https://greview.koyeb.app`
- `DATABASE_URL`: retain the existing PostgreSQL connection string unchanged.

The Python backend uses the same schema as the uppercase project. An existing
initialized database needs no replacement or reset. For a new database only,
run `python backend-python/init_db.py` from the repository root with DATABASE_URL set.

After deployment, check `/health` and `/db-health` on the public domain, then
verify link generation, opening a link, dashboard statistics, and task creation
inside Zoho CRM. Existing review links must keep their original hostname working;
if links were issued on another hostname, retain that domain mapping too.

## Update the Zoho widget and functions

Run `npm ci` and `npm run build` from the repository root.
Upload `google-review-settings-widget.zip` to the existing Zoho connected app.
The source keeps the lowercase project's dashboard and Create Tasks feature.
All widget and Deluge variables/fields use the existing `googlereviewlink__` prefix.
Update installed Deluge functions from `zoho-functions/` if they still use the old
backend URL. Keep existing Backend Access Key and Review Open Sync URL values;
do not regenerate keys or reinstall the extension for this source replacement.

If the existing extension uses a different namespace or the Koyeb service uses a
different public hostname, align these settings before deploying this project.
