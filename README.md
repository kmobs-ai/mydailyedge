# My DailyEdge

My DailyEdge is a dark, minimal personal operating app for investments, tasks, investment news, ideas, and daily snapshots.

## What is built

- Portfolio positions with assets, prices, target weights, trade history, open lots, cost basis, allocation, and P&L.
- Asset lookup from the Portfolio form that links new stock, ETF, fund, and supported crypto holdings to server-side market data.
- Interactive price charts powered by TradingView Lightweight Charts — Area, Line, and Candle styles with hover crosshair, mobile pinch/zoom, and a smooth dark theme.
- Multi-source investment intel: The Block, CoinDesk, Cointelegraph, Yahoo Finance RSS, plus per-ticker Alpha Vantage / Yahoo headlines, all merged with filters (All, Portfolio, Crypto, Markets, Research).
- Buy/sell/deposit/withdraw activity stored locally in the browser.
- FIFO tax impact estimator for potential sales with configurable short-term and long-term rates.
- Tasks and ideas with filters, detail panels, and local persistence.
- History snapshots that store daily portfolio value, P&L, tasks, ideas, positions, and a generated daily report.
- Import/export JSON backup.
- Optional PHP/MySQL login and server sync for private data storage.
- Mobile-first responsive layout — slide-down nav drawer, iOS safe-area insets, bottom-sheet modals, 44px touch targets, PWA manifest for "Add to Home Screen" on iOS and Android.

## Logo and favicon assets

Drop these PNGs into the project root next to `index.html`. The app references them by these exact filenames:

- `logo.png` — header logo (recommended ~256×256, transparent background)
- `favicon.png` — browser tab icon (recommended 192×192, transparent background)
- `favicon.ico` — legacy fallback (16×16 + 32×32 multi-size .ico)
- `apple-touch-icon.png` — iOS home screen (180×180, opaque background, no rounded corners — iOS adds them)
- `icon-512.png` — Android home screen / PWA splash (512×512, opaque)

If `logo.png` is missing, the header gracefully falls back to a small accent-colored dot.

## Live data

The app supports Alpha Vantage quote and news refresh from the Intel tab. In production, store the key in `public_html/api/config.php` so it stays server-side and is never exposed to the browser.

```php
'alpha_vantage_api_key' => 'YOUR_ALPHA_VANTAGE_KEY',
```

The server endpoint uses Alpha Vantage `GLOBAL_QUOTE` for stock/ETF quotes and `NEWS_SENTIMENT` for investment news. Crypto prices remain manual for now, while crypto-related news can still appear through the news endpoint.

When adding a portfolio position, enter a ticker and click **Lookup**. The app will use the server-side key to fill the asset name, type, and current price. Enter your shares/units, average cost, purchase date, and fees; saving creates the asset plus its first tax lot and keeps the holding linked for future Refresh actions.

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


## Price alerts cron setup

The alerts evaluator runs as a cron job. In cPanel:

1. Open **Cron Jobs**.
2. Add a new entry:
   - **Common settings**: Every 15 minutes (`*/15 * * * *`)
   - **Command**: `/usr/bin/php /home/<your-cpanel-user>/public_html/api/cron/check-alerts.php >> /home/<your-cpanel-user>/cron-alerts.log 2>&1`
3. Replace `<your-cpanel-user>` with your actual cPanel username (the same one in `.cpanel.yml`'s `DEPLOYPATH`).

Active alerts are evaluated against the latest Yahoo Finance quote on each run.
Triggered alerts show as a banner inside the app on next refresh.

If you can't add a cron job for some reason, the script also accepts an HTTP
trigger: set `'cron_secret' => 'a-long-random-string'` in `api/config.php`,
then have any external scheduler (cron-job.org, GitHub Actions schedule, etc.)
hit `https://mydailyedge.io/api/cron/check-alerts.php?secret=a-long-random-string`
every 15 minutes.



## Daily snapshot cron setup

A second cron writes one portfolio snapshot per user per day at 22:00 UTC
(post-close for US equities, well after the West Coast):

1. Open **Cron Jobs** in cPanel.
2. Add a new entry:
   - Schedule: `0 22 * * *`
   - Command: `/usr/bin/php /home/<your-cpanel-user>/public_html/api/cron/daily-snapshot.php >> /home/<your-cpanel-user>/cron-snapshots.log 2>&1`
3. The History tab reads from these snapshots automatically.

Manual snapshots from the **Capture Today** button on the History page also
write to the same `snapshots` table and overwrite the day's auto-snapshot if
one already exists for that date.

## MySQL login setup on cPanel

The frontend works in local browser mode until the backend is configured. To enable login and MySQL sync:

1. In cPanel, open **MySQL Databases**.
2. Create a database, for example `bjirekar6ity_mydailyedge`.
3. Create a MySQL user and password.
4. Add the user to the database with **All Privileges**.
5. Open **phpMyAdmin**, select the new database, and run `database/schema.sql`.
6. In File Manager, go to `/home/bjirekar6ity/public_html/api/`.
7. Copy `config.sample.php` to `config.php`.
8. Edit `config.php` with your database name, user, password, and Alpha Vantage API key.
9. The edited values should look like this:

```php
'db_host' => 'localhost',
'db_name' => 'bjirekar6ity_mydailyedge',
'db_user' => 'bjirekar6ity_mydailyedge',
'db_pass' => 'YOUR_DATABASE_PASSWORD_HERE',
'alpha_vantage_api_key' => 'YOUR_ALPHA_VANTAGE_KEY',
'allow_registration' => true,
```

10. Visit `https://mydailyedge.io`, create your first account, then edit `config.php` and set:

```php
'allow_registration' => false,
```

The app stores one JSON state document per user in MySQL. That keeps this phase simple while still giving you login, private server storage, and cross-device sync.
