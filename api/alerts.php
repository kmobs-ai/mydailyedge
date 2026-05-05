<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';

$user = require_user();
$userId = (int) $user['id'];

function fetch_alert(int $userId, int $alertId): ?array
{
    $stmt = db()->prepare('SELECT * FROM alerts WHERE id = ? AND user_id = ?');
    $stmt->execute([$alertId, $userId]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function normalize_direction(string $d): string
{
    $d = strtolower(trim($d));
    if (!in_array($d, ['above', 'below', 'pct_up', 'pct_down'], true)) {
        respond(['ok' => false, 'error' => 'direction must be one of: above, below, pct_up, pct_down.'], 400);
    }
    return $d;
}

function alert_to_payload(array $row): array
{
    return [
        'id' => (int) $row['id'],
        'symbol' => (string) $row['symbol'],
        'direction' => (string) $row['direction'],
        'threshold' => (float) $row['threshold'],
        'baseline' => $row['baseline'] !== null ? (float) $row['baseline'] : null,
        'note' => $row['note'] !== null ? (string) $row['note'] : null,
        'status' => (string) $row['status'],
        'triggeredAt' => $row['triggered_at'],
        'triggeredPrice' => $row['triggered_price'] !== null ? (float) $row['triggered_price'] : null,
        'acknowledgedAt' => $row['acknowledged_at'],
        'notifyEmail' => (bool) $row['notify_email'],
        'notifyPush' => (bool) $row['notify_push'],
        'createdAt' => $row['created_at'],
        'updatedAt' => $row['updated_at'],
    ];
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $stmt = db()->prepare('SELECT * FROM alerts WHERE user_id = ? ORDER BY status = "triggered" DESC, created_at DESC');
    $stmt->execute([$userId]);
    $rows = $stmt->fetchAll();
    respond(['ok' => true, 'alerts' => array_map('alert_to_payload', $rows)]);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    require_csrf();
    $body = read_json();
    $action = (string) ($body['action'] ?? 'create');

    if ($action === 'create') {
        $symbol = strtoupper(trim((string) ($body['symbol'] ?? '')));
        if ($symbol === '' || !preg_match('/^[A-Z0-9.\-]{1,20}$/', $symbol)) {
            respond(['ok' => false, 'error' => 'Symbol is required (1-20 chars, A-Z/0-9/./-).'], 400);
        }
        $direction = normalize_direction((string) ($body['direction'] ?? ''));
        $threshold = (float) ($body['threshold'] ?? 0);
        if ($threshold <= 0) {
            respond(['ok' => false, 'error' => 'threshold must be a positive number.'], 400);
        }
        $baseline = isset($body['baseline']) ? (float) $body['baseline'] : null;
        $note = isset($body['note']) ? mb_substr((string) $body['note'], 0, 500) : null;
        $notifyEmail = !isset($body['notifyEmail']) || (bool) $body['notifyEmail'];
        $notifyPush = !empty($body['notifyPush']);

        $stmt = db()->prepare(
            'INSERT INTO alerts (user_id, symbol, direction, threshold, baseline, note, notify_email, notify_push)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([$userId, $symbol, $direction, $threshold, $baseline, $note, (int) $notifyEmail, (int) $notifyPush]);
        $newId = (int) db()->lastInsertId();
        $row = fetch_alert($userId, $newId);
        respond(['ok' => true, 'alert' => alert_to_payload($row)]);
    }

    $alertId = (int) ($body['id'] ?? 0);
    if ($alertId <= 0) respond(['ok' => false, 'error' => 'alert id is required.'], 400);
    $existing = fetch_alert($userId, $alertId);
    if (!$existing) respond(['ok' => false, 'error' => 'alert not found.'], 404);

    if ($action === 'delete') {
        $stmt = db()->prepare('DELETE FROM alerts WHERE id = ? AND user_id = ?');
        $stmt->execute([$alertId, $userId]);
        respond(['ok' => true]);
    }

    if ($action === 'pause' || $action === 'resume') {
        $newStatus = $action === 'pause' ? 'paused' : 'active';
        $stmt = db()->prepare('UPDATE alerts SET status = ? WHERE id = ? AND user_id = ?');
        $stmt->execute([$newStatus, $alertId, $userId]);
        respond(['ok' => true, 'alert' => alert_to_payload(fetch_alert($userId, $alertId))]);
    }

    if ($action === 'acknowledge') {
        // Mark as dismissed so it stops surfacing in the banner; keeps history visible.
        $stmt = db()->prepare(
            'UPDATE alerts SET status = "dismissed", acknowledged_at = CURRENT_TIMESTAMP
             WHERE id = ? AND user_id = ? AND status = "triggered"'
        );
        $stmt->execute([$alertId, $userId]);
        respond(['ok' => true, 'alert' => alert_to_payload(fetch_alert($userId, $alertId))]);
    }

    if ($action === 'reset') {
        // Move a triggered/dismissed alert back to active so it can fire again.
        $stmt = db()->prepare(
            'UPDATE alerts SET status = "active", triggered_at = NULL, triggered_price = NULL, acknowledged_at = NULL
             WHERE id = ? AND user_id = ?'
        );
        $stmt->execute([$alertId, $userId]);
        respond(['ok' => true, 'alert' => alert_to_payload(fetch_alert($userId, $alertId))]);
    }

    respond(['ok' => false, 'error' => 'Unsupported alert action.'], 400);
}

respond(['ok' => false, 'error' => 'Unsupported method.'], 405);
