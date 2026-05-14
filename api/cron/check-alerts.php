<?php
declare(strict_types=1);

// Cron worker: evaluates active alerts against current market prices.
// Suggested cPanel cron: */15 * * * * /usr/bin/php /home/<user>/public_html/api/cron/check-alerts.php
//
// This script:
//   1. Loads all active alerts grouped by symbol.
//   2. Fetches the current Yahoo Finance quote for each unique symbol once.
//   3. Evaluates each alert's direction + threshold against the latest price.
//   4. Marks triggered alerts and stamps triggered_at + triggered_price.
//   5. Stubs notify_email / notify_push dispatch — wired by phase-2 work.

declare(ticks=1);
ini_set('display_errors', '0');
ini_set('log_errors', '1');

if (PHP_SAPI !== 'cli' && empty($_GET['secret'])) {
    // Allow CLI invocation freely; require a shared-secret query param if hit over HTTP.
    http_response_code(403);
    echo "forbidden\n";
    exit;
}

$root = realpath(__DIR__ . '/..');
$configPath = $root . '/config.php';
if (!is_file($configPath)) {
    fwrite(STDERR, "[alerts] missing api/config.php — refusing to run\n");
    exit(1);
}
$config = require $configPath;
require_once $root . '/email.php';
require_once $root . '/web-push.php';
require_once __DIR__ . '/_cron-lib.php';

if (PHP_SAPI !== 'cli') {
    $expected = (string) ($config['cron_secret'] ?? '');
    if ($expected === '' || !hash_equals($expected, (string) ($_GET['secret'] ?? ''))) {
        http_response_code(403);
        echo "forbidden\n";
        exit;
    }
}

// --- DB connection ---
try {
    $pdo = new PDO(
        sprintf('mysql:host=%s;dbname=%s;charset=utf8mb4', $config['db_host'], $config['db_name']),
        $config['db_user'],
        $config['db_pass'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
    );
} catch (PDOException $e) {
    fwrite(STDERR, "[alerts] db connect failed: " . $e->getMessage() . "\n");
    exit(1);
}

// --- Load active alerts ---
$rows = $pdo->query('SELECT a.*, u.email AS user_email FROM alerts a INNER JOIN users u ON u.id = a.user_id WHERE a.status = "active"')->fetchAll();
if (!$rows) {
    echo "[alerts] no active alerts to check\n";
    exit(0);
}

// --- Fetch quotes per unique symbol (Yahoo Finance, Alpha Vantage fallback) ---
$symbols = array_unique(array_map(static fn($r) => strtoupper($r['symbol']), $rows));
$quotes = [];
foreach ($symbols as $symbol) {
    $quote = cron_fetch_quote($config, $symbol);
    if ($quote !== null) $quotes[$symbol] = $quote['price'];
}

echo "[alerts] checking " . count($rows) . " alert(s) across " . count($quotes) . " quote(s)\n";

// --- Evaluate ---
$markTriggered = $pdo->prepare(
    'UPDATE alerts SET status = "triggered", triggered_at = CURRENT_TIMESTAMP, triggered_price = ? WHERE id = ? AND status = "active"'
);
$dispatchQueue = [];

foreach ($rows as $row) {
    $symbol = strtoupper($row['symbol']);
    $price = $quotes[$symbol] ?? null;
    if ($price === null) continue;

    $direction = (string) $row['direction'];
    $threshold = (float) $row['threshold'];
    $baseline  = $row['baseline'] !== null ? (float) $row['baseline'] : null;

    $triggered = false;
    if ($direction === 'above') {
        $triggered = $price >= $threshold;
    } elseif ($direction === 'below') {
        $triggered = $price <= $threshold;
    } elseif ($direction === 'pct_up' && $baseline !== null && $baseline > 0) {
        $triggered = (($price - $baseline) / $baseline * 100) >= $threshold;
    } elseif ($direction === 'pct_down' && $baseline !== null && $baseline > 0) {
        $triggered = (($baseline - $price) / $baseline * 100) >= $threshold;
    }

    if (!$triggered) continue;

    $markTriggered->execute([$price, (int) $row['id']]);
    if ($markTriggered->rowCount() === 0) continue; // race-lost or already triggered

    echo sprintf("[alerts] TRIGGERED #%d %s %s %s @ %s (price %s)\n",
        $row['id'], $symbol, $direction, $threshold, date('c'), $price);

    $dispatchQueue[] = [
        'alert_id' => (int) $row['id'],
        'user_id' => (int) $row['user_id'],
        'user_email' => (string) $row['user_email'],
        'symbol' => $symbol,
        'direction' => $direction,
        'threshold' => $threshold,
        'price' => $price,
        'note' => $row['note'],
        'notify_email' => (bool) $row['notify_email'],
        'notify_push' => (bool) $row['notify_push'],
    ];
}


function describe_push_body(array $item): string
{
    $symbol = (string) $item['symbol'];
    $direction = (string) $item['direction'];
    $threshold = (float) $item['threshold'];
    $price = (float) $item['price'];
    $thresholdLabel = ($direction === 'pct_up' || $direction === 'pct_down')
        ? rtrim(rtrim(number_format($threshold, 2), '0'), '.') . '%'
        : '$' . number_format($threshold, 2);
    $directionLabel = [
        'above'    => 'rose above',
        'below'    => 'fell below',
        'pct_up'   => 'gained more than',
        'pct_down' => 'dropped more than',
    ][$direction] ?? $direction;
    return $symbol . ' ' . $directionLabel . ' ' . $thresholdLabel . ' (now $' . number_format($price, 2) . ')';
}

// --- Notification dispatch (stubbed for now; phase 2 wires SMTP, phase 3 wires Web Push) ---
foreach ($dispatchQueue as $item) {
    if ($item['notify_email']) {
        $alertForEmail = [
            'symbol'        => $item['symbol'],
            'direction'     => $item['direction'],
            'threshold'     => $item['threshold'],
            'price'         => $item['price'],
            'note'          => $item['note'],
            'triggered_at'  => date('Y-m-d H:i T'),
        ];
        [$subject, $html, $text] = build_alert_email($alertForEmail, $config);
        $sent = send_email($config, $item['user_email'], '', $subject, $html, $text);
        echo $sent
            ? "[alerts]   email sent to {$item['user_email']} re {$item['symbol']}\n"
            : "[alerts]   email FAILED to {$item['user_email']} re {$item['symbol']} (see stderr)\n";
    }
    if ($item['notify_push']) {
        $vapidConfigured = !empty($config['vapid_public_key']) && !empty($config['vapid_private_key']);
        if (!$vapidConfigured) {
            echo "[alerts]   push SKIPPED for user {$item['user_id']} (VAPID keys not configured)\n";
        } else {
            $stmt = $pdo->prepare('SELECT id, endpoint, p256dh_key, auth_key FROM push_subscriptions WHERE user_id = ?');
            $stmt->execute([(int) $item['user_id']]);
            $subs = $stmt->fetchAll();
            if (!$subs) {
                echo "[alerts]   push SKIPPED for user {$item['user_id']} (no subscriptions on file)\n";
            } else {
                $pushPayload = json_encode([
                    'title' => "{$item['symbol']} alert",
                    'body'  => describe_push_body($item),
                    'tag'   => 'alert-' . $item['alert_id'],
                    'url'   => rtrim((string) ($config['app_url'] ?? 'https://mydailyedge.io'), '/') . '/?tab=alerts',
                ]);
                foreach ($subs as $sub) {
                    try {
                        $result = web_push_send($config, [
                            'endpoint' => $sub['endpoint'],
                            'p256dh'   => $sub['p256dh_key'],
                            'auth'     => $sub['auth_key'],
                        ], $pushPayload);
                        $code = $result['statusCode'];
                        if ($code === 410 || $code === 404) {
                            // Subscription expired — clean up.
                            $del = $pdo->prepare('DELETE FROM push_subscriptions WHERE id = ?');
                            $del->execute([(int) $sub['id']]);
                            echo "[alerts]   push subscription #{$sub['id']} pruned (HTTP $code)\n";
                        } elseif ($code >= 200 && $code < 300) {
                            echo "[alerts]   push sent to subscription #{$sub['id']}\n";
                        } else {
                            echo "[alerts]   push FAILED to subscription #{$sub['id']} (HTTP $code: " . substr((string) $result['body'], 0, 200) . ")\n";
                        }
                    } catch (Throwable $err) {
                        echo "[alerts]   push ERROR for subscription #{$sub['id']}: " . $err->getMessage() . "\n";
                    }
                }
            }
        }
    }
}

echo "[alerts] done. " . count($dispatchQueue) . " new trigger(s).\n";
