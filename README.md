# My DailyEdge

My DailyEdge is a dark, minimal personal operating app for investments, tasks, investment news, ideas, and daily snapshots.

## What is built

- Portfolio positions with assets, prices, target weights, trade history, open lots, cost basis, allocation, and P&L.
- Buy/sell/deposit/withdraw activity stored locally in the browser.
- FIFO tax impact estimator for potential sales with configurable short-term and long-term rates.
- Investment intel tied to held symbols.
- Tasks and ideas with filters, detail panels, and local persistence.
- History snapshots that store daily portfolio value, P&L, tasks, ideas, positions, and a generated daily report.
- Import/export JSON backup.
- Optional PHP/MySQL login and server sync for private data storage.

## Live data

The static version supports Alpha Vantage quote and news refresh from the Intel tab. Save an API key there, then use Refresh. Because this is a static cPanel-friendly build, the key is stored in your browser localStorage. For production-grade use, move quote/news calls behind a backend endpoint so keys are not exposed to the browser.

## Local use

Open `index.html` directly in a browser, or serve the folder with any static server.

## GoDaddy cPanel deployment

For the simplest deployment to `mydailyedge.io`, upload these files into the domain document root in cPanel File Manager:

- `index.html`
- `styles.css`
- `app.js`
- `.htaccess`

Future-friendly options:

1. Static cPanel upload: easiest today, least moving parts, but live data keys live in the browser.
2. GitHub Actions to cPanel FTP: keep working in GitHub and auto-upload the static files on every push to `main`.
3. PHP plus MySQL on cPanel: keeps the GoDaddy hosting plan and allows private API keys, login, server-side snapshots, and scheduled daily reports.
4. Vercel, Netlify, or Cloudflare Pages plus GoDaddy DNS: easiest long-term developer workflow for Git-based deployments and serverless API routes. Point `mydailyedge.io` DNS to the platform while keeping the domain at GoDaddy.

My recommended path: start with option 2 for quick static deployment, then move to option 4 or option 3 once you want authenticated accounts, private API keys, automated daily reports, and durable database storage.

## Suggested deployment workflow

### Fastest first launch

Use cPanel File Manager or FTP and upload the four public files. This is the fastest path because the app has no build step.

### Best GitHub workflow while staying on GoDaddy

Use either cPanel Git Version Control or GitHub Actions with FTP credentials stored as repository secrets:

- `FTP_SERVER`
- `FTP_USERNAME`
- `FTP_PASSWORD`
- `FTP_SERVER_DIR`

For cPanel Git Version Control, this repo includes a root `.cpanel.yml` that copies the public files and PHP API into `/home/bjirekar6ity/public_html/`. If your `mydailyedge.io` document root changes, update `DEPLOYPATH` in `.cpanel.yml` before deploying.

The GitHub Actions example uploads `index.html`, `styles.css`, `app.js`, and `.htaccess` after every push to `main`. This keeps GitHub as the source of truth and avoids manual cPanel uploads.

### Better production app

When you want real accounts, private market-data keys, scheduled daily reports, and server-side history, add a backend. On GoDaddy Web Hosting (cPanel), PHP plus MySQL is the most natural fit because cPanel supports PHP, MySQL, cron jobs, and `mod_rewrite`. If you prefer a modern Git-first workflow, host the app on Vercel, Netlify, or Cloudflare Pages and point GoDaddy DNS for `mydailyedge.io` there.

## MySQL login setup on cPanel

The frontend works in local browser mode until the backend is configured. To enable login and MySQL sync:

1. In cPanel, open **MySQL Databases**.
2. Create a database, for example `bjirekar6ity_mydailyedge`.
3. Create a MySQL user and password.
4. Add the user to the database with **All Privileges**.
5. Open **phpMyAdmin**, select the new database, and run `database/schema.sql`.
6. In File Manager, go to `/home/bjirekar6ity/public_html/api/`.
7. Copy `config.sample.php` to `config.php`.
8. Edit `config.php` with your database name, user, and password.
9. Visit `https://mydailyedge.io`, create your first account, then edit `config.php` and set:

```php
'allow_registration' => false,
```

The app stores one JSON state document per user in MySQL. That keeps this phase simple while still giving you login, private server storage, and cross-device sync.
