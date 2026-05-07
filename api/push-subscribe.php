<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';

$user = require_user();
$userId = (int) $user['id'];

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $stmt = db()->prepare('SELECT id, endpoint, user_agent, created_at, last_seen_at FROM push_subscriptions WHERE user_id = ? ORDER BY last_seen_at DESC');
    $stmt->execute([$userId]);
    respond([
        'ok' => true,
        'subscriptions' => array_map(static function (array $r): array {
            return [
                'id' => (int) $r['id'],
                'endpoint' => $r['endpoint'],
                'userAgent' => $r['user_agent'],
                'createdAt' => $r['created_at'],
                'lastSeenAt' => $r['last_seen_at'],
            ];
        }, $stmt->fetchAll()),
        'vapidPublicKey' => app_config()['vapid_public_key'] ?? '',
    ]);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    require_csrf();
    $body = read_json();
    $action = (string) ($body['action'] ?? 'subscribe');

    if ($action === 'subscribe') {
        $endpoint = (string) ($body['endpoint'] ?? '');
        $p256dh = (string) ($body['p256dh'] ?? '');
        $auth = (string) ($body['auth'] ?? '');
        $userAgent = mb_substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255);

        if (!filter_var($endpoint, FILTER_VALIDATE_URL) || $p256dh === '' || $auth === '') {
            respond(['ok' => false, 'error' => 'Subscription is missing required fields.'], 400);
        }

        $stmt = db()->prepare(
            'INSERT INTO push_subscriptions (user_id, endpoint, p256dh_key, auth_key, user_agent)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               user_id = VALUES(user_id),
               p256dh_key = VALUES(p256dh_key),
               auth_key = VALUES(auth_key),
               user_agent = VALUES(user_agent),
               last_seen_at = CURRENT_TIMESTAMP'
        );
        $stmt->execute([$userId, $endpoint, $p256dh, $auth, $userAgent]);
        respond(['ok' => true]);
    }

    if ($action === 'unsubscribe') {
        $endpoint = (string) ($body['endpoint'] ?? '');
        if ($endpoint === '') respond(['ok' => false, 'error' => 'endpoint required.'], 400);
        $stmt = db()->prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?');
        $stmt->execute([$userId, $endpoint]);
        respond(['ok' => true]);
    }

    respond(['ok' => false, 'error' => 'Unsupported action.'], 400);
}

respond(['ok' => false, 'error' => 'Unsupported method.'], 405);
