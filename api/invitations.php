<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';
require_once __DIR__ . '/email.php';

function require_admin(): array
{
    $user = require_user();
    if (empty($user) || empty($user['is_admin'] ?? null)) {
        // require_user() returns columns id, email, created_at — no is_admin
        // re-fetch to verify
        $stmt = db()->prepare('SELECT id, email, is_admin FROM users WHERE id = ?');
        $stmt->execute([(int) $user['id']]);
        $row = $stmt->fetch();
        if (!$row || empty($row['is_admin'])) {
            respond(['ok' => false, 'error' => 'Admin access required.'], 403);
        }
        return $row;
    }
    return $user;
}

function invite_to_payload(array $row): array
{
    $now = time();
    $expires = strtotime((string) $row['expires_at']) ?: 0;
    $status = 'pending';
    if (!empty($row['revoked_at'])) $status = 'revoked';
    elseif (!empty($row['accepted_at'])) $status = 'accepted';
    elseif ($expires < $now) $status = 'expired';

    return [
        'id' => (int) $row['id'],
        'email' => (string) $row['email'],
        'note' => $row['note'] !== null ? (string) $row['note'] : null,
        'status' => $status,
        'invitedAt' => $row['invited_at'],
        'expiresAt' => $row['expires_at'],
        'acceptedAt' => $row['accepted_at'],
        'revokedAt' => $row['revoked_at'],
    ];
}

function build_invite_email(array $invite, array $config): array
{
    $appUrl = rtrim((string) ($config['app_url'] ?? 'https://mydailyedge.io'), '/');
    $link = $appUrl . '/?invite=' . urlencode((string) $invite['token']);
    $expires = date('M j, Y', strtotime((string) $invite['expires_at']));
    $note = isset($invite['note']) && $invite['note'] !== null ? (string) $invite['note'] : '';

    $subject = "You're invited to My DailyEdge";

    $css = 'font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0a0a0b;color:#dedee7;padding:0;margin:0;';
    $cardCss = 'max-width:560px;margin:0 auto;padding:36px 28px;background:#111114;border:1px solid #28282f;border-radius:6px;';
    $eyebrowCss = 'font-family:Menlo,monospace;font-size:10px;letter-spacing:.2em;color:#e8d5b0;text-transform:uppercase;margin-bottom:10px;';
    $headlineCss = 'font-family:Georgia,serif;font-size:28px;font-weight:400;margin:0 0 14px;color:#f1f1f5;line-height:1.2;';
    $bodyCss = 'color:#9b9baa;line-height:1.65;font-size:14px;';
    $btnCss = 'display:inline-block;background:#e8d5b0;color:#0a0a0b;text-decoration:none;padding:12px 28px;border-radius:3px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;font-size:11px;font-family:Menlo,monospace;';
    $footerCss = 'color:#6b6b7b;font-size:11px;line-height:1.5;margin-top:28px;';
    $linkCss = 'color:#e8d5b0;word-break:break-all;font-size:12px;font-family:Menlo,monospace;';

    $noteHtml = $note !== '' ? '<p style="' . $bodyCss . 'margin:18px 0 0;color:#dedee7;border-left:2px solid #e8d5b0;padding-left:12px;">' . htmlspecialchars($note, ENT_QUOTES, 'UTF-8') . '</p>' : '';

    $html = <<<HTML
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="{$css}">
  <div style="padding:48px 16px;">
    <div style="{$cardCss}">
      <div style="{$eyebrowCss}">Private beta invitation</div>
      <h1 style="{$headlineCss}">You're invited to My DailyEdge</h1>
      <p style="{$bodyCss}">My DailyEdge is a personal portfolio operating app — track positions, get news tied to your holdings, set price alerts, and snapshot your portfolio every market close. It's currently in private beta and access is invite-only.</p>
      {$noteHtml}
      <div style="margin:32px 0;">
        <a href="{$link}" style="{$btnCss}">Accept invitation</a>
      </div>
      <p style="{$bodyCss}font-size:12px;">Or copy this link into your browser:<br><span style="{$linkCss}">{$link}</span></p>
      <p style="{$footerCss}">This invitation expires on <strong style="color:#dedee7;">{$expires}</strong>. If you weren't expecting this, you can safely ignore the email.</p>
    </div>
  </div>
</body>
</html>
HTML;

    $text = "You're invited to My DailyEdge\n\n"
          . "My DailyEdge is a personal portfolio operating app — track positions, get news tied to your holdings, set price alerts, and snapshot your portfolio every market close.\n\n"
          . ($note !== '' ? "Note: {$note}\n\n" : "")
          . "Accept your invitation: {$link}\n\n"
          . "This invitation expires on {$expires}.";

    return [$subject, $html, $text];
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    // Public lookup by token (lets the frontend pre-fill email on the redeem form)
    $token = trim((string) ($_GET['token'] ?? ''));
    if ($token !== '') {
        $stmt = db()->prepare('SELECT email, expires_at, accepted_at, revoked_at FROM invitations WHERE token = ?');
        $stmt->execute([$token]);
        $row = $stmt->fetch();
        if (!$row) respond(['ok' => false, 'error' => 'Invitation not found.'], 404);
        $now = time();
        $expires = strtotime((string) $row['expires_at']) ?: 0;
        if (!empty($row['revoked_at'])) respond(['ok' => false, 'error' => 'This invitation has been revoked.'], 410);
        if (!empty($row['accepted_at'])) respond(['ok' => false, 'error' => 'This invitation has already been accepted.'], 410);
        if ($expires < $now) respond(['ok' => false, 'error' => 'This invitation has expired.'], 410);
        respond(['ok' => true, 'email' => $row['email'], 'expiresAt' => $row['expires_at']]);
    }

    // Otherwise list — admin only
    require_admin();
    $stmt = db()->query('SELECT * FROM invitations ORDER BY invited_at DESC LIMIT 200');
    respond(['ok' => true, 'invitations' => array_map('invite_to_payload', $stmt->fetchAll())]);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $body = read_json();
    $action = (string) ($body['action'] ?? '');

    // Public redeem path — no auth required, the token IS the auth
    if ($action === 'redeem') {
        $token = trim((string) ($body['token'] ?? ''));
        $password = (string) ($body['password'] ?? '');
        if ($token === '') respond(['ok' => false, 'error' => 'Invitation token is required.'], 400);
        if (strlen($password) < 10) respond(['ok' => false, 'error' => 'Use a password with at least 10 characters.'], 400);

        $stmt = db()->prepare('SELECT * FROM invitations WHERE token = ?');
        $stmt->execute([$token]);
        $invite = $stmt->fetch();
        if (!$invite) respond(['ok' => false, 'error' => 'Invitation not found.'], 404);
        $now = time();
        $expires = strtotime((string) $invite['expires_at']) ?: 0;
        if (!empty($invite['revoked_at'])) respond(['ok' => false, 'error' => 'This invitation has been revoked.'], 410);
        if (!empty($invite['accepted_at'])) respond(['ok' => false, 'error' => 'This invitation has already been accepted.'], 410);
        if ($expires < $now) respond(['ok' => false, 'error' => 'This invitation has expired.'], 410);

        $email = strtolower((string) $invite['email']);

        // Check if user already exists for this email; if so, link the invite but don't create a duplicate
        $stmt = db()->prepare('SELECT id FROM users WHERE email = ?');
        $stmt->execute([$email]);
        $existing = $stmt->fetch();
        if ($existing) {
            respond(['ok' => false, 'error' => 'An account already exists for that email. Please sign in instead.'], 409);
        }

        $stmt = db()->prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)');
        $stmt->execute([$email, password_hash($password, PASSWORD_DEFAULT)]);
        $newUserId = (int) db()->lastInsertId();

        // Mark the invitation accepted
        $stmt = db()->prepare('UPDATE invitations SET accepted_at = CURRENT_TIMESTAMP, accepted_user_id = ? WHERE id = ?');
        $stmt->execute([$newUserId, (int) $invite['id']]);

        // Auto-login: rotate session, issue CSRF token
        session_regenerate_id(true);
        unset($_SESSION['csrf_token']);
        $_SESSION['user_id'] = $newUserId;

        respond(['ok' => true, 'user' => current_user(), 'csrfToken' => csrf_token()]);
    }

    // Everything below requires admin auth + CSRF
    require_csrf();
    $admin = require_admin();
    $adminId = (int) $admin['id'];

    if ($action === 'create') {
        $email = strtolower(trim((string) ($body['email'] ?? '')));
        $note = isset($body['note']) ? mb_substr((string) $body['note'], 0, 500) : null;
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            respond(['ok' => false, 'error' => 'Enter a valid email address.'], 400);
        }

        // If a non-revoked, non-accepted, non-expired invite already exists for this email, return it instead of creating dupe
        $stmt = db()->prepare('SELECT id FROM users WHERE email = ?');
        $stmt->execute([$email]);
        if ($stmt->fetch()) {
            respond(['ok' => false, 'error' => 'An account already exists for that email.'], 409);
        }

        $token = bin2hex(random_bytes(32));
        $expiresAt = date('Y-m-d H:i:s', time() + 14 * 86400);

        $stmt = db()->prepare(
            'INSERT INTO invitations (email, token, invited_by, expires_at, note)
             VALUES (?, ?, ?, ?, ?)'
        );
        $stmt->execute([$email, $token, $adminId, $expiresAt, $note]);
        $newId = (int) db()->lastInsertId();

        // Send the invitation email
        $invitePayload = ['email' => $email, 'token' => $token, 'expires_at' => $expiresAt, 'note' => $note];
        [$subject, $html, $text] = build_invite_email($invitePayload, $config);
        $emailOk = send_email($config, $email, '', $subject, $html, $text);

        $stmt = db()->prepare('SELECT * FROM invitations WHERE id = ?');
        $stmt->execute([$newId]);
        $row = $stmt->fetch();
        respond([
            'ok' => true,
            'invitation' => invite_to_payload($row),
            'emailSent' => $emailOk,
            'message' => $emailOk
                ? "Invitation sent to {$email}."
                : "Invitation created but email delivery failed. Share the link manually: " . rtrim((string) ($config['app_url'] ?? 'https://mydailyedge.io'), '/') . '/?invite=' . $token,
        ]);
    }

    if ($action === 'revoke') {
        $id = (int) ($body['id'] ?? 0);
        if ($id <= 0) respond(['ok' => false, 'error' => 'id required'], 400);
        $stmt = db()->prepare('UPDATE invitations SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL');
        $stmt->execute([$id]);
        respond(['ok' => true]);
    }

    if ($action === 'resend') {
        $id = (int) ($body['id'] ?? 0);
        if ($id <= 0) respond(['ok' => false, 'error' => 'id required'], 400);
        $stmt = db()->prepare('SELECT * FROM invitations WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL');
        $stmt->execute([$id]);
        $invite = $stmt->fetch();
        if (!$invite) respond(['ok' => false, 'error' => 'Invitation not found or already used.'], 404);
        // If expired, push the expiry forward another 14 days
        $now = time();
        $expires = strtotime((string) $invite['expires_at']) ?: 0;
        if ($expires < $now) {
            $newExpires = date('Y-m-d H:i:s', $now + 14 * 86400);
            $stmt = db()->prepare('UPDATE invitations SET expires_at = ? WHERE id = ?');
            $stmt->execute([$newExpires, $id]);
            $invite['expires_at'] = $newExpires;
        }
        [$subject, $html, $text] = build_invite_email($invite, $config);
        $emailOk = send_email($config, (string) $invite['email'], '', $subject, $html, $text);
        respond(['ok' => $emailOk, 'emailSent' => $emailOk]);
    }

    respond(['ok' => false, 'error' => 'Unsupported action.'], 400);
}

respond(['ok' => false, 'error' => 'Unsupported method.'], 405);
