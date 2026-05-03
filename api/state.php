<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';

$user = require_user();
$userId = (int) $user['id'];

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $stmt = db()->prepare('SELECT state_json, updated_at FROM user_state WHERE user_id = ?');
    $stmt->execute([$userId]);
    $row = $stmt->fetch();

    respond([
        'ok' => true,
        'state' => $row ? json_decode($row['state_json'], true) : null,
        'updatedAt' => $row['updated_at'] ?? null,
    ]);
}

if ($_SERVER['REQUEST_METHOD'] === 'PUT' || $_SERVER['REQUEST_METHOD'] === 'POST') {
    $body = read_json();
    $state = $body['state'] ?? null;
    if (!is_array($state)) {
        respond(['ok' => false, 'error' => 'State payload is required.'], 400);
    }

    $stateJson = json_encode($state, JSON_UNESCAPED_SLASHES);
    if ($stateJson === false || strlen($stateJson) > 16777215) {
        respond(['ok' => false, 'error' => 'State payload is too large or invalid.'], 400);
    }

    $stmt = db()->prepare(
        'INSERT INTO user_state (user_id, state_json) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE state_json = VALUES(state_json), updated_at = CURRENT_TIMESTAMP'
    );
    $stmt->execute([$userId, $stateJson]);

    respond(['ok' => true]);
}

respond(['ok' => false, 'error' => 'Unsupported method.'], 405);
