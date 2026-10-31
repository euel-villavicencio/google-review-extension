# GitHub container publishing

The workflow publishes the Python backend to:

`ghcr.io/euel-villavicencio/google-review-extension`

On `container-publishing`, it publishes `staging` and the full commit SHA.
On `main`, it publishes `latest` and the full commit SHA. Prefer a commit tag or
digest for deployment so the deployed version is explicit.

This branch does not contain a Koyeb deployment step. Keep it separate from main
until the existing Koyeb Git deployment has been migrated, since main currently
triggers that service automatically.

GitHub Actions uses its built-in GITHUB_TOKEN with contents:read and packages:write;
no personal access token is required for publishing. New GHCR packages default to
private. After the first successful run, check the package settings and confirm
that this package is Private before relying on it for private source distribution.

Do not make the repository private until the existing public-repository Koyeb
integration has been replaced or authenticated; doing so may break future builds.

A future private-image deployment will need a registry credential with read:packages
access. Do not commit that token or application secrets. Configure DATABASE_URL,
PUBLIC_BASE_URL, and PORT at runtime. This image listens on PORT (default 3000),
provides /health and /db-health, and does not contain the separately uploaded Zoho
widget UI.
