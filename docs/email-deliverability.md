# Email deliverability — SPF, DKIM, DMARC

My DailyEdge sends transactional email (price-alert notifications, invitations)
with PHP's `mail()` from `alerts@mydailyedge.io`. Without authentication records,
mailbox providers — Gmail especially — will route those messages straight to
spam or reject them outright.

This is **DNS configuration you apply yourself** at GoDaddy. None of it is code,
and Claude cannot make DNS changes on your behalf. Work through the three
sections below in order. Budget 5–10 minutes, plus up to 48 hours for DNS to
propagate (usually much faster).

> Throughout, replace `mydailyedge.io` with your actual domain if it differs,
> and `<cpanel-server-ip>` with the IPv4 address shown in cPanel under
> **Server Information**.

---

## 1. SPF — authorize who may send for your domain

SPF is a single TXT record listing the servers allowed to send mail as
`@mydailyedge.io`. Since the app sends through your cPanel host, you authorize
that host.

In **GoDaddy → Domain → DNS → Manage Zones**, add (or edit the existing SPF
record — you must have **only one** SPF record):

| Type | Name | Value                                          | TTL    |
|------|------|------------------------------------------------|--------|
| TXT  | `@`  | `v=spf1 +a +mx +ip4:<cpanel-server-ip> ~all`   | 1 hour |

Notes:

- If GoDaddy already created an SPF record when you set up email, edit that one
  instead of adding a second. Two SPF records is an automatic fail.
- `+a +mx` authorizes the hosts your domain's A and MX records point at;
  `+ip4:` pins the cPanel server explicitly. Keeping all three is belt-and-suspenders.
- `~all` is a "soft fail" — unauthorized mail is accepted but marked suspicious.
  Move to `-all` (hard fail) only once you've confirmed everything legitimate passes.

---

## 2. DKIM — cryptographically sign outgoing mail

cPanel can generate and manage the DKIM key pair for you. This is the easiest
of the three.

1. In **cPanel → Email → Email Deliverability**.
2. Find `mydailyedge.io` in the list. If DKIM shows a problem, click
   **Manage**, then **Generate Local DKIM Key** (if not already present).
3. cPanel displays the exact TXT record it needs — typically:
   - **Name:** `default._domainkey`
   - **Value:** `v=DKIM1; k=rsa; p=<long-public-key>`
4. Add that TXT record in GoDaddy DNS exactly as cPanel shows it. The value is
   long; copy it verbatim, no added spaces or line breaks.
5. Back in **Email Deliverability**, click **Repair** / re-check until DKIM
   shows a green checkmark.

> If your domain's DNS were hosted *at* cPanel, it would add this automatically.
> Because DNS lives at GoDaddy, you copy the record across by hand.

---

## 3. DMARC — tell receivers what to do with failures, and get reports

DMARC ties SPF and DKIM together and asks receiving servers to email you
aggregate reports about who's sending as your domain.

Add one more TXT record in GoDaddy DNS:

| Type | Name      | Value                                                                 | TTL    |
|------|-----------|-----------------------------------------------------------------------|--------|
| TXT  | `_dmarc`  | `v=DMARC1; p=none; rua=mailto:lsenges.it@gmail.com; fo=1; adkim=s; aspf=s` | 1 hour |

- Start with `p=none` — **monitor only**. You'll still receive the `rua` reports
  but nothing gets blocked while you confirm SPF and DKIM are passing.
- After a week or two of clean reports, tighten to `p=quarantine`, and
  eventually `p=reject`, for real protection against spoofing.
- `rua=` is where the daily XML aggregate reports go. Point it at an inbox you
  actually read.

---

## Verifying it worked

After DNS has propagated:

1. **Send yourself a test.** Trigger a price alert (or use the invitation flow)
   so the app sends a real message to a Gmail address you control.
2. In Gmail, open the message → **⋮ → Show original**. You want to see:
   - **SPF: PASS**
   - **DKIM: PASS**
   - **DMARC: PASS**
3. Or paste the three records into a checker like
   [MXToolbox](https://mxtoolbox.com/SuperTool.aspx) — run `spf:mydailyedge.io`,
   `dkim:mydailyedge.io` (selector `default`), and `dmarc:mydailyedge.io`.

If SPF fails, the most common cause is two SPF records or a wrong server IP.
If DKIM fails, re-copy the cPanel value — a truncated key is the usual culprit.

---

## If deliverability is still poor

PHP `mail()` over a shared cPanel IP has a low ceiling no matter how clean your
DNS is — shared IPs accumulate reputation damage from other tenants. If alert
emails still land in spam after SPF/DKIM/DMARC all pass, the durable fix is to
send through a dedicated provider (e.g. an SMTP relay with its own authenticated
IP). That's a future enhancement, not part of this DNS setup — note it and move on.
