<?php
declare(strict_types=1);

/**
 * Send a transactional email using PHP's mail() routed through cPanel's
 * local mail server. No SMTP credentials needed; deliverability depends on
 * the domain's SPF/DKIM/DMARC records pointing at the cPanel mail server.
 *
 * Returns true on accept-for-delivery, false otherwise. Logs failures to
 * stderr so cron jobs capture the reason in their log file.
 *
 * Required config keys (in api/config.php):
 *   'mail_from_email'  => 'alerts@mydailyedge.io'
 *   'mail_from_name'   => 'My DailyEdge Alerts'   (optional, defaults to "My DailyEdge")
 *   'mail_reply_to'    => 'alerts@mydailyedge.io' (optional, defaults to mail_from_email)
 *   'app_url'          => 'https://mydailyedge.io' (optional, used to build deep links)
 */
function send_email(array $config, string $toEmail, string $toName, string $subject, string $bodyHtml, string $bodyText = ''): bool
{
    $fromEmail = trim((string) ($config['mail_from_email'] ?? ''));
    $fromName  = trim((string) ($config['mail_from_name']  ?? 'My DailyEdge'));
    $replyTo   = trim((string) ($config['mail_reply_to']   ?? $fromEmail));

    if (!filter_var($fromEmail, FILTER_VALIDATE_EMAIL)) {
        fwrite(STDERR, "[email] mail_from_email is missing or invalid in config.php\n");
        return false;
    }
    if (!filter_var($toEmail, FILTER_VALIDATE_EMAIL)) {
        fwrite(STDERR, "[email] recipient is invalid: $toEmail\n");
        return false;
    }

    if ($bodyText === '') {
        // Strip HTML for the plain-text part. Keep links visible.
        $tmp = preg_replace('/<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/i', "$2 ($1)", $bodyHtml);
        $tmp = strip_tags($tmp);
        $bodyText = trim(html_entity_decode($tmp, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
    }

    $boundary = 'mde-' . bin2hex(random_bytes(8));

    $fromHeader = sprintf('%s <%s>', encode_header_value($fromName), $fromEmail);
    $headers = [
        'From: ' . $fromHeader,
        'Reply-To: ' . $replyTo,
        'Return-Path: ' . $fromEmail,
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="' . $boundary . '"',
        'X-Mailer: MyDailyEdge/1.0',
        'Date: ' . date(DATE_RFC2822),
    ];

    $body  = "--{$boundary}\r\n";
    $body .= "Content-Type: text/plain; charset=UTF-8\r\n";
    $body .= "Content-Transfer-Encoding: 8bit\r\n\r\n";
    $body .= $bodyText . "\r\n\r\n";
    $body .= "--{$boundary}\r\n";
    $body .= "Content-Type: text/html; charset=UTF-8\r\n";
    $body .= "Content-Transfer-Encoding: 8bit\r\n\r\n";
    $body .= $bodyHtml . "\r\n\r\n";
    $body .= "--{$boundary}--\r\n";

    $encodedSubject = encode_header_value($subject);

    // Use the -f parameter to set the envelope sender. cPanel's mail() honours this.
    $additionalParams = '-f ' . escapeshellarg($fromEmail);

    $ok = @mail($toEmail, $encodedSubject, $body, implode("\r\n", $headers), $additionalParams);
    if (!$ok) {
        fwrite(STDERR, "[email] mail() returned false for $toEmail re: $subject\n");
        return false;
    }

    return true;
}

/**
 * RFC 2047 "encoded-word" encoding for non-ASCII characters in headers.
 * Keeps subject lines and display names safe through any mail relay.
 */
function encode_header_value(string $value): string
{
    if (preg_match('/^[\x20-\x7E]*$/', $value)) {
        return $value;
    }
    return '=?UTF-8?B?' . base64_encode($value) . '?=';
}

/**
 * Build the price-alert email body. Returns [subject, html, text].
 */
function build_alert_email(array $alert, array $config): array
{
    $appUrl = rtrim((string) ($config['app_url'] ?? 'https://mydailyedge.io'), '/');
    $symbol = htmlspecialchars((string) $alert['symbol'], ENT_QUOTES, 'UTF-8');
    $direction = (string) $alert['direction'];
    $threshold = number_format((float) $alert['threshold'], 2);
    $price = number_format((float) $alert['price'], 2);
    $note = isset($alert['note']) && $alert['note'] !== null ? (string) $alert['note'] : '';

    $directionLabels = [
        'above'    => 'rose above',
        'below'    => 'fell below',
        'pct_up'   => 'gained more than',
        'pct_down' => 'dropped more than',
    ];
    $directionLabel = $directionLabels[$direction] ?? $direction;
    $thresholdLabel = ($direction === 'pct_up' || $direction === 'pct_down')
        ? $threshold . '%'
        : '$' . $threshold;

    $subject = "Alert: {$symbol} {$directionLabel} {$thresholdLabel}";

    $css = 'font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0a0a0b;color:#dedee7;padding:0;margin:0;';
    $cardCss = 'max-width:560px;margin:0 auto;padding:32px 24px;background:#111114;border:1px solid #28282f;border-radius:6px;';
    $headlineCss = 'font-size:22px;font-weight:600;margin:0 0 12px;color:#f1f1f5;';
    $detailCss = 'font-family:Menlo,monospace;font-size:13px;line-height:1.7;color:#9b9baa;';
    $accentCss = 'color:#e8d5b0;';
    $btnCss = 'display:inline-block;background:#e8d5b0;color:#0a0a0b;text-decoration:none;padding:10px 22px;border-radius:3px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;font-size:11px;font-family:Menlo,monospace;';
    $footerCss = 'color:#6b6b7b;font-size:11px;line-height:1.5;margin-top:24px;text-align:center;';

    $noteHtml = $note !== '' ? '<p style="' . $detailCss . 'margin:14px 0 0;color:#dedee7">"' . htmlspecialchars($note, ENT_QUOTES, 'UTF-8') . '"</p>' : '';

    $html = <<<HTML
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="{$css}">
  <div style="padding:40px 16px;">
    <div style="{$cardCss}">
      <div style="font-family:Menlo,monospace;font-size:10px;letter-spacing:.18em;color:#e8d5b0;text-transform:uppercase;margin-bottom:8px;">Price alert</div>
      <h1 style="{$headlineCss}">{$symbol} {$directionLabel} {$thresholdLabel}</h1>
      <div style="{$detailCss}">
        Current price: <span style="{$accentCss}">\${$price}</span><br>
        Triggered at:  <span style="{$accentCss}">{$alert['triggered_at']}</span>
      </div>
      {$noteHtml}
      <div style="margin-top:28px;">
        <a href="{$appUrl}/?tab=alerts" style="{$btnCss}">View in app</a>
      </div>
      <p style="{$footerCss}">Sent by My DailyEdge. You can pause or delete this alert from the Alerts tab.</p>
    </div>
  </div>
</body>
</html>
HTML;

    $text = "Price alert: {$symbol} {$directionLabel} {$thresholdLabel}\n\n"
          . "Current price: \${$price}\n"
          . "Triggered at:  {$alert['triggered_at']}\n"
          . ($note !== '' ? "\nNote: {$note}\n" : "")
          . "\nView in app: {$appUrl}/?tab=alerts\n\n"
          . "Sent by My DailyEdge. Pause or delete the alert from the Alerts tab.";

    return [$subject, $html, $text];
}
