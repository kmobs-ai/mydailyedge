<?php
declare(strict_types=1);

/**
 * Daily portfolio snapshot worker. Runs once a day at 22:00 UTC (post-close
 * for US equities, well after the West Coast). For each user with portfolio
 * data in user_state.assets, fetches current Yahoo Finance quotes for every
 * symbol once (across all users), computes value/cost/P&L, and upserts a
 * snapshot row keyed on (user_id, snapshot_date).
 *
 * Suggested cron entry:
 *   0 22 * * * /usr/bin/php /home/<user>/public_html/api/cron/daily-snapshot.php >> /home/<user>/cron-snapshots.log 2>&1
 *
 * Or via HTTP (with cron_secret query param):
 *   curl "https://mydailyedge.io/api/cron/daily-snapshot.php?secret=<cron_secret>"
 */

declare(ticks=1);
ini_set('display_errors', '0');
ini_set('log_errors', '1');

if (PHP_SAPI !== 'cli' && empty($_GET['secret'])) {
    http_response_code(403); echo "forbidden\n"; exit;
}

$root = realpath(__DIR__ . '/..');
$configPath = $root . '/config.php';
if (!is_file($configPath)) {
    fwrite(STDERR, "[snapshot] api/config.php missing\n"); exit(1);
}
$config = require $configPath;

if (PHP_SAPI !== 'cli') {
    $expected = (string) ($config['cron_secret'] ?? '');
    if ($expected === '' || !hash_equals($expected, (string) ($_GET['secret'] ?? ''))) {
        http_response_code(403); echo "forbidden\n"; exit;
    }
    header('Content-Type: text/plain; charset=utf-8');
}

try {
    $pdo = new PDO(
        sprintf('mysql:host=%s;dbname=%s;charset=utf8mb4', $config['db_host'], $config['db_name']),
        $config['db_user'], $config['db_pass'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
    );
} catch (PDOException $e) {
    fwrite(STDERR, "[snapshot] db connect failed: " . $e->getMessage() . "\n"); exit(1);
}

// Pull every user_state row.
$rows = $pdo->query('SELECT user_id, state_json FROM user_state')->fetchAll();
if (!$rows) {
    echo "[snapshot] no users to snapshot\n"; exit(0);
}

// Collect every unique symbol across users so we batch quote requests.
$cryptoSet = ['BTC','ETH','SOL','ADA','XRP','DOGE','AVAX','LINK','LTC','BCH'];
$allSymbols = [];
$userBundles = [];
foreach ($rows as $row) {
    $state = json_decode((string) $row['state_json'], true);
    if (!is_array($state)) continue;
    $assets = $state['assets'] ?? [];
    if (!is_array($assets) || !$assets) continue;
    $userBundles[(int) $row['user_id']] = $state;
    foreach ($assets as $a) {
        $sym = strtoupper((string) ($a['symbol'] ?? ''));
        if ($sym !== '' && ($a['type'] ?? '') !== 'cash' && ($a['type'] ?? '') !== 'other') {
            $allSymbols[$sym] = true;
        }
    }
}
$allSymbols = array_keys($allSymbols);
echo "[snapshot] " . count($userBundles) . " user(s), " . count($allSymbols) . " unique symbol(s)\n";

// Fetch quotes once per symbol.
$quotes = [];
foreach ($allSymbols as $symbol) {
    $yahooSymbol = in_array($symbol, $cryptoSet, true) ? $symbol . '-USD' : $symbol;
    $url = 'https://query1.finance.yahoo.com/v8/finance/chart/' . rawurlencode($yahooSymbol) . '?range=1d&interval=1d';
    $raw = false;
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_TIMEOUT => 8,
            CURLOPT_HTTPHEADER => ['Accept: application/json', 'User-Agent: MyDailyEdge-Cron/1.0'],
        ]);
        $raw = curl_exec($ch);
        curl_close($ch);
    } else {
        $ctx = stream_context_create(['http' => ['timeout' => 8, 'header' => "Accept: application/json\r\nUser-Agent: MyDailyEdge-Cron/1.0\r\n"]]);
        $raw = @file_get_contents($url, false, $ctx);
    }
    if ($raw === false) continue;
    $decoded = json_decode($raw, true);
    $meta = $decoded['chart']['result'][0]['meta'] ?? null;
    if (!is_array($meta)) continue;
    $price = (float) ($meta['regularMarketPrice'] ?? 0);
    $previousClose = (float) ($meta['chartPreviousClose'] ?? $meta['previousClose'] ?? $price);
    if ($price > 0) {
        $quotes[$symbol] = ['price' => $price, 'previousClose' => $previousClose];
    }
}

// FIFO lots helper, matching the frontend implementation in app.js.
function build_lots(array $trades, string $symbol): array {
    $lots = [];
    $relevant = array_values(array_filter($trades, static fn($t) => strtoupper((string) ($t['symbol'] ?? '')) === $symbol));
    usort($relevant, static fn($a, $b) => strcmp((string) ($a['date'] ?? ''), (string) ($b['date'] ?? '')));
    foreach ($relevant as $trade) {
        $action = (string) ($trade['action'] ?? '');
        $qty = (float) ($trade['quantity'] ?? 0);
        $price = (float) ($trade['price'] ?? 0);
        $fees = (float) ($trade['fees'] ?? 0);
        if ($action === 'buy' || $action === 'deposit') {
            $lots[] = ['remaining' => $qty, 'unitCost' => $qty ? ($qty * $price + $fees) / $qty : 0, 'date' => $trade['date'] ?? ''];
        } elseif ($action === 'sell' || $action === 'withdraw') {
            $remainingSale = $qty;
            foreach ($lots as &$lot) {
                if ($remainingSale <= 0) break;
                $used = min($lot['remaining'], $remainingSale);
                $lot['remaining'] -= $used;
                $remainingSale -= $used;
            }
            unset($lot);
        }
    }
    return array_values(array_filter($lots, static fn($l) => $l['remaining'] > 0.0000001));
}

$today = date('Y-m-d');
$upsert = $pdo->prepare(
    'INSERT INTO snapshots
      (user_id, snapshot_date, portfolio_value, portfolio_cost, day_pnl, day_pct, total_gain, total_gain_pct, open_tasks, due_tasks, positions_json, report, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "cron")
     ON DUPLICATE KEY UPDATE
      portfolio_value = VALUES(portfolio_value),
      portfolio_cost  = VALUES(portfolio_cost),
      day_pnl         = VALUES(day_pnl),
      day_pct         = VALUES(day_pct),
      total_gain      = VALUES(total_gain),
      total_gain_pct  = VALUES(total_gain_pct),
      open_tasks      = VALUES(open_tasks),
      due_tasks       = VALUES(due_tasks),
      positions_json  = VALUES(positions_json),
      report          = VALUES(report)'
);

$totalSnaps = 0;
foreach ($userBundles as $userId => $state) {
    $assets = $state['assets'] ?? [];
    $trades = $state['trades'] ?? [];
    $tasks = $state['tasks'] ?? [];
    $portfolioValue = 0; $portfolioCost = 0; $previousValue = 0;
    $positions = [];
    foreach ($assets as $a) {
        $sym = strtoupper((string) ($a['symbol'] ?? ''));
        if ($sym === '') continue;
        $type = (string) ($a['type'] ?? 'stock');
        $lots = build_lots($trades, $sym);
        $qty = array_sum(array_column($lots, 'remaining'));
        $cost = 0;
        foreach ($lots as $l) $cost += $l['remaining'] * $l['unitCost'];
        $price = ($quotes[$sym]['price'] ?? null) ?: (float) ($a['price'] ?? 0);
        $prevClose = ($quotes[$sym]['previousClose'] ?? null) ?: (float) ($a['previousClose'] ?? $price);
        $value = $qty * $price;
        $dayChangePct = $prevClose > 0 ? (($price - $prevClose) / $prevClose) * 100 : 0;
        $portfolioValue += $value;
        $portfolioCost  += $cost;
        $previousValue  += $qty * $prevClose;
        $positions[] = [
            'symbol' => $sym,
            'value' => $value,
            'cost' => $cost,
            'dayChangePct' => $dayChangePct,
            'gain' => $value - $cost,
        ];
    }
    $dayPnl = $portfolioValue - $previousValue;
    $dayPct = $previousValue > 0 ? ($dayPnl / $previousValue) * 100 : 0;
    $gain = $portfolioValue - $portfolioCost;
    $gainPct = $portfolioCost > 0 ? ($gain / $portfolioCost) * 100 : 0;

    $openTasks = 0; $dueTasks = 0;
    if (is_array($tasks)) {
        foreach ($tasks as $t) {
            if (empty($t['done'])) {
                $openTasks++;
                if (!empty($t['due']) && (string) $t['due'] <= $today) $dueTasks++;
            }
        }
    }

    usort($positions, static fn($a, $b) => $b['value'] <=> $a['value']);
    $topNames = array_slice(array_column($positions, 'symbol'), 0, 3);
    $report = sprintf(
        "Auto-snapshot for %s. Portfolio %s with day movement %s (%.2f%%). Total unrealized %s. Top positions: %s.",
        $today,
        '$' . number_format($portfolioValue, 0),
        ($dayPnl >= 0 ? '+' : '') . '$' . number_format($dayPnl, 0),
        $dayPct,
        ($gain >= 0 ? '+' : '') . '$' . number_format($gain, 0),
        $topNames ? implode(', ', $topNames) : 'none'
    );

    $upsert->execute([
        $userId, $today,
        $portfolioValue, $portfolioCost, $dayPnl, $dayPct, $gain, $gainPct,
        $openTasks, $dueTasks,
        json_encode($positions, JSON_UNESCAPED_SLASHES),
        $report,
    ]);
    $totalSnaps++;
    echo sprintf("[snapshot] user=%d value=%s pnl=%s positions=%d\n",
        $userId,
        '$' . number_format($portfolioValue, 0),
        ($dayPnl >= 0 ? '+' : '') . '$' . number_format($dayPnl, 0),
        count($positions));
}

echo "[snapshot] done. $totalSnaps snapshot(s) upserted.\n";
