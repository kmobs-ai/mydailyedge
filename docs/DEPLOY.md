# Deploying My DailyEdge

The repo ships with a GitHub Actions workflow at `.github/workflows/deploy.yml`
that auto-deploys every push to `main` to your cPanel host via FTPS.

## One-time setup

1. In GitHub, open the repo's **Settings → Secrets and variables → Actions**.
2. Click **New repository secret** and add each of the following:

   | Secret              | Value                                                  |
   |---------------------|--------------------------------------------------------|
   | `FTP_SERVER`        | Your cPanel hostname, e.g. `ftp.mydailyedge.io`        |
   | `FTP_USERNAME`      | A cPanel FTP user (NOT your account password user)    |
   | `FTP_PASSWORD`      | The FTP password for that user                         |
   | `FTP_SERVER_DIR`    | Remote path, typically `/public_html/`                |

   **Tip**: in cPanel, open **FTP Accounts** and create a dedicated
   `deploy@mydailyedge.io` user scoped to `/public_html/` so the deploy
   only has access to the public folder, not the whole hosting account.

3. Push any commit to `main`. Watch the run under the repo's **Actions** tab.

## What gets deployed

Everything in the repo *except*:

- `docs/`, `tests/`, `database/` (dev-only)
- `.github/`, `.git/`, `.gitignore`, `.cpanel.yml`
- Master-image sources (`MyDailyEdge-icon.png`, `My DailyEdge.png`, `wordmark.png`)
- The `README.md`
- `api/config.php` (your local secrets must NEVER be in the repo)

## Testing locally before push

Run `node --check app.js` from the repo root. The same check runs in CI.

## Manual deploy

If you ever want to redeploy without committing, go to the **Actions** tab
in GitHub and click **Run workflow** on the latest "Deploy My DailyEdge to
cPanel" run. The workflow has `workflow_dispatch:` enabled.

## Falling back to cPanel Git Version Control

If FTPS isn't an option, the legacy `.cpanel.yml` script still works — log
into cPanel, open **Git Version Control → Manage**, click **Update from
Remote**, then **Deploy HEAD Commit**.
