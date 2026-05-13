<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';

require_user();

// Frontend asks for the last N days. We support a small range whitelist mirroring the
// overview chart options. Anything beyond 1y triggers a longer Yahoo fetch.
$rangeMap = [
    '7d'  => 7,
    '30d' => 30,
    '90d' => 90,
    'ytd' => 365,
    'all' => 1095, // 3 years
];
$rangeKey = (string) ($_GET['range'] ?? '90d');
$days = $rangeMap[$rangeKey] ?? 90;

$symbolsParam = trim((string) ($_GET['symbols'] ?? 'SPY,BTC'));
$requested = array_unique(array_filter(array_map(static function (string $s): string {
    return strtoupper(trim($s));
}, explode(',', $symbolsParam))));
if (!$requested) {
    respond(['ok' => true, 'series' => []]);
}

// Yahoo symbol mapping (BTC is a crypto on Yahoo: "BTC-USD")
function yahoo_benchmark_symbol(string $s): string {
    if ($s === 'BTC')  return 'BTC-USD';
    if ($s === 'ETH')  return 'ETH-USD';
    if ($s === 'SOL')  return 'SOL-USD';
    return $s;
}

function yahoo_chart_url(string $yahooSymbol, int $days): string {
    // Pick a range param that covers $days
    $range = '3mo';
    if ($days <= 7)       $range = '5d';
    elseif ($days <= 30)  $range = '1mo';
    elseif ($days <= 90)  $range = '3mo';
    elseif ($days <= 365) $range = '1y';
    else                   $range = '5y';
    $q = http_build_query(['range' => $range, 'interval' => '1d']);
    return 'https://query1.finance.yahoo.com/v8/finance/chart/' . rawurlencode($yahooSymbol) . '?' . $q;
}

function fetch_benchmark_history(string $yahooSymbol, int $days): array {
    $url = yahoo_chart_url($yahooSymbol, $days);
    $raw = false;
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => 10,
            CURLOPT_HTTPHEADER => ['Accept: application/json', 'User-Agent: MyDailyEdge/1.0'],
        ]);
        $raw = curl_exec($ch);
        curl_close($ch);
    } else {
        $ctx = stream_context_create(['http' => ['timeout' => 10, 'header' => "Accept: application/json\r\nUser-Agent: MyDailyEdge/1.0\r\n"]]);
        $raw = @file_get_contents($url, false, $ctx);
    }
    if ($raw === false) return [];
    $decoded = json_decode($raw, true);
    $result = $decoded['chart']['result'][0] ?? null;
    if (!is_array($result)) return [];
    $timestamps = $result['timestamp'] ?? [];
    $closes = $result['indicators']['quote'][0]['close'] ?? [];
    $points = [];
    foreach ($timestamps as $i => $ts) {
        $c = isset($closes[$i]) ? (float) $closes[$i] : 0;
        if ($c <= 0) continue;
        $points[date('Y-m-d', (int) $ts)] = $c;
    }
    return $points;
}

// Cache-aware fetch. Returns array[symbol] = [['date' => 'YYYY-MM-DD', 'close' => float], ...]
$pdo = db();
$response = [];
$now = time();
$cutoffDate = date('Y-m-d', $now - $days * 86400);

foreach ($requested as $symbol) {
    // Try cache first
    $stmt = $pdo->prepare('SELECT snapshot_date, close FROM benchmarks WHERE symbol = ? AND snapshot_date >= ? ORDER BY snapshot_date ASC');
    $stmt->execute([$symbol, $cutoffDate]);
    $rows = $stmt->fetchAll();

    // If the cache has < days/2 rows, or the latest row is more than 36 hours old,
    // refresh from Yahoo (covers weekends).
    $needsRefresh = count($rows) < max(2, intval($days / 4));
    if (!$needsRefresh && $rows) {
        $latest = strtotime((string) end($rows)['snapshot_date']);
        if (($now - $latest) > 36 * 3600) $needsRefresh = true;
    }

    if ($needsRefresh) {
        $yahooSymbol = yahoo_benchmark_symbol($symbol);
        $points = fetch_benchmark_history($yahooSymbol, $days);
        if ($points) {
            $upsert = $pdo->prepare(
                'INSERT INTO benchmarks (symbol, snapshot_date, close) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE close = VALUES(close), updated_at = CURRENT_TIMESTAMP'
            );
            foreach ($points as $date => $close) {
                $upsert->execute([$symbol, $date, $close]);
            }
            // Re-read for the response (filtered to range)
            $stmt->execute([$symbol, $cutoffDate]);
            $rows = $stmt->fetchAll();
        }
    }

    $response[$symbol] = array_map(static function (array $r): array {
        return ['date' => (string) $r['snapshot_date'], 'close' => (float) $r['close']];
    }, $rows);
}

respond(['ok' => true, 'range' => $rangeKey, 'series' => $response]);
