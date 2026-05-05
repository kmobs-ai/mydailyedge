<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';

$user = require_user();
$userId = (int) $user['id'];

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $stmt = db()->prepare('SELECT state_json, version, updated_at FROM user_state WHERE user_id = ?');
    $stmt->execute([$userId]);
    $row = $stmt->fetch();

    respond([
        'ok' => true,
        'state' => $row ? json_decode($row['state_json'], true) : null,
        'version' => $row ? (int) $row['version'] : 0,
        'updatedAt' => $row['updated_at'] ?? null,
    ]);
}

if ($_SERVER['REQUEST_METHOD'] === 'PUT' || $_SERVER['REQUEST_METHOD'] === 'POST') {
    require_csrf();

    $body = read_json();
    $state = $body['state'] ?? null;
    if (!is_array($state)) {
        respond(['ok' => false, 'error' => 'State payload is required.'], 400);
    }

    $stateJson = json_encode($state, JSON_UNESCAPED_SLASHES);
    if ($stateJson === false || strlen($stateJson) > 16777215) {
        respond(['ok' => false, 'error' => 'State payload is too large or invalid.'], 400);
    }

    // Optimistic concurrency: caller passes the version they last read.
    // Special values:
    //   - missing/null   → first write, only succeed if no row exists yet
    //   - "force"        → blow past the check (used after the 409 banner's
    //                      "save anyway" button)
    $clientVersionRaw = $body['version'] ?? null;
    $force = $clientVersionRaw === 'force';
    $clientVersion = is_numeric($clientVersionRaw) ? (int) $clientVersionRaw : null;

    $existing = null;
    $stmt = db()->prepare('SELECT version FROM user_state WHERE user_id = ?');
    $stmt->execute([$userId]);
    $existing = $stmt->fetch();
    $currentVersion = $existing ? (int) $existing['version'] : 0;

    if (!$force) {
        if ($existing === false) {
            // First write — only allowed if client also didn't have a version
            if ($clientVersion !== null && $clientVersion !== 0) {
                respond([
                    'ok' => false,
                    'error' => 'State was reset on the server. Reload the app to recover.',
                    'serverVersion' => 0,
                    'clientVersion' => $clientVersion,
                ], 409);
            }
        } else {
            if ($clientVersion === null || $clientVersion !== $currentVersion) {
                respond([
                    'ok' => false,
                    'error' => 'Your data was changed on another device. Reload to see the latest, or push your changes anyway.',
                    'serverVersion' => $currentVersion,
                    'clientVersion' => $clientVersion,
                ], 409);
            }
        }
    }

    $newVersion = $currentVersion + 1;
    $stmt = db()->prepare(
        'INSERT INTO user_state (user_id, state_json, version) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE state_json = VALUES(state_json), version = VALUES(version), updated_at = CURRENT_TIMESTAMP'
    );
    $stmt->execute([$userId, $stateJson, $newVersion]);

    respond(['ok' => true, 'version' => $newVersion]);
}

respond(['ok' => false, 'error' => 'Unsupported method.'], 405);
