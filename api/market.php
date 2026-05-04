<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';

require_user();

$apiKey = trim((string) ($config['alpha_vantage_api_key'] ?? ''));

function alpha_request(array $params): array
{
    global $apiKey;

    if ($apiKey === '') {
        respond(['ok' => false, 'error' => 'Alpha Vantage is not configured for this request. Quotes still use the Yahoo Finance fallback.'], 503);
    }

    $params['apikey'] = $apiKey;
    $url = 'https://www.alphavantage.co/query?' . http_build_query($params);

    $raw = false;
    if (function_exists('curl_init')) {
        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => 12,
            CURLOPT_HTTPHEADER => ['Accept: application/json'],
        ]);
        $raw = curl_exec($curl);
        curl_close($curl);
    } elseif (ini_get('allow_url_fopen')) {
        $context = stream_context_create([
            'http' => [
                'method' => 'GET',
                'timeout' => 12,
                'header' => "Accept: application/json\r\n",
            ],
        ]);
        $raw = @file_get_contents($url, false, $context);
    }

    if ($raw === false) {
        respond(['ok' => false, 'error' => 'Market data provider request failed.'], 502);
    }

    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        respond(['ok' => false, 'error' => 'Market data provider returned invalid JSON.'], 502);
    }

    if (!empty($decoded['Note']) || !empty($decoded['Information'])) {
        respond(['ok' => false, 'error' => alpha_error_message($decoded['Note'] ?? $decoded['Information'])], 429);
    }

    return $decoded;
}

function alpha_error_message(string $message): string
{
    $lower = strtolower($message);
    if (strpos($lower, 'rate limit') !== false || strpos($lower, 'requests per day') !== false || strpos($lower, 'requests per minute') !== false) {
        return 'Alpha Vantage free limit reached. You can still enter this position manually; live lookup will work again after the provider resets your quota.';
    }

    if (strpos($lower, 'invalid') !== false) {
        return 'Alpha Vantage rejected that symbol. Check the ticker, or enter the position manually and mark it as a stock/ETF/crypto.';
    }

    return 'Alpha Vantage could not complete this lookup. Enter the position manually or try again later.';
}

function yahoo_quote(string $symbol, ?string $displaySymbol = null, string $assetType = 'stock'): ?array
{
    $url = 'https://query1.finance.yahoo.com/v8/finance/chart/' . rawurlencode($symbol) . '?range=1d&interval=1d';
    $raw = false;

    if (function_exists('curl_init')) {
        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => 8,
            CURLOPT_HTTPHEADER => ['Accept: application/json', 'User-Agent: MyDailyEdge/1.0'],
        ]);
        $raw = curl_exec($curl);
        curl_close($curl);
    } elseif (ini_get('allow_url_fopen')) {
        $context = stream_context_create([
            'http' => [
                'method' => 'GET',
                'timeout' => 8,
                'header' => "Accept: application/json\r\nUser-Agent: MyDailyEdge/1.0\r\n",
            ],
        ]);
        $raw = @file_get_contents($url, false, $context);
    }

    if ($raw === false) {
        return null;
    }

    $decoded = json_decode($raw, true);
    $meta = $decoded['chart']['result'][0]['meta'] ?? null;
    if (!is_array($meta)) {
        return null;
    }

    $price = (float) ($meta['regularMarketPrice'] ?? 0);
    if ($price <= 0) {
        return null;
    }

    $previousClose = (float) ($meta['chartPreviousClose'] ?? $meta['previousClose'] ?? $price);

    return [
        'symbol' => $displaySymbol ?? strtoupper($symbol),
        'price' => $price,
        'previousClose' => $previousClose,
        'change' => $price - $previousClose,
        'changePercent' => $previousClose ? (($price - $previousClose) / $previousClose) * 100 : 0,
        'latestTradingDay' => isset($meta['regularMarketTime']) ? date('Y-m-d', (int) $meta['regularMarketTime']) : date('Y-m-d'),
        'assetType' => $assetType,
        'name' => $meta['shortName'] ?? $meta['longName'] ?? ($displaySymbol ?? strtoupper($symbol)),
        'currency' => $meta['currency'] ?? 'USD',
        'provider' => 'yahoo',
    ];
}

function yahoo_history(string $symbol, ?string $displaySymbol = null, string $assetType = 'stock', string $rangeKey = '1m'): ?array
{
    $rangeMap = [
        '24h' => ['range' => '1d', 'interval' => '5m'],
        '7d' => ['range' => '5d', 'interval' => '15m'],
        '1m' => ['range' => '1mo', 'interval' => '1d'],
        '6m' => ['range' => '6mo', 'interval' => '1d'],
        'ytd' => ['range' => 'ytd', 'interval' => '1d'],
        'all' => ['range' => 'max', 'interval' => '1mo'],
    ];
    $choice = $rangeMap[$rangeKey] ?? $rangeMap['1m'];
    $url = 'https://query1.finance.yahoo.com/v8/finance/chart/' . rawurlencode($symbol) . '?' . http_build_query($choice);
    $raw = false;

    if (function_exists('curl_init')) {
        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => 10,
            CURLOPT_HTTPHEADER => ['Accept: application/json', 'User-Agent: MyDailyEdge/1.0'],
        ]);
        $raw = curl_exec($curl);
        curl_close($curl);
    } elseif (ini_get('allow_url_fopen')) {
        $context = stream_context_create([
            'http' => [
                'method' => 'GET',
                'timeout' => 10,
                'header' => "Accept: application/json\r\nUser-Agent: MyDailyEdge/1.0\r\n",
            ],
        ]);
        $raw = @file_get_contents($url, false, $context);
    }

    if ($raw === false) {
        return null;
    }

    $decoded = json_decode($raw, true);
    $result = $decoded['chart']['result'][0] ?? null;
    if (!is_array($result)) {
        return null;
    }

    $timestamps = $result['timestamp'] ?? [];
    $quotes = $result['indicators']['quote'][0]['close'] ?? [];
    if (!is_array($timestamps) || !is_array($quotes) || count($timestamps) === 0) {
        return null;
    }

    $points = [];
    foreach ($timestamps as $index => $timestamp) {
        $price = isset($quotes[$index]) ? (float) $quotes[$index] : 0;
        if ($price <= 0) {
            continue;
        }
        $points[] = [
            'date' => date($choice['interval'] === '1d' || $choice['interval'] === '1mo' ? 'Y-m-d' : 'Y-m-d H:i', (int) $timestamp),
            'timestamp' => (int) $timestamp,
            'price' => $price,
        ];
    }

    if (!$points) {
        return null;
    }

    $meta = $result['meta'] ?? [];

    return [
        'symbol' => $displaySymbol ?? strtoupper($symbol),
        'assetType' => $assetType,
        'range' => $rangeKey,
        'provider' => 'yahoo',
        'currency' => $meta['currency'] ?? 'USD',
        'points' => $points,
    ];
}

function alpha_soft_request(array $params): ?array
{
    global $apiKey;

    if ($apiKey === '') {
        return null;
    }

    $params['apikey'] = $apiKey;
    $url = 'https://www.alphavantage.co/query?' . http_build_query($params);
    $raw = false;

    if (function_exists('curl_init')) {
        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => 12,
            CURLOPT_HTTPHEADER => ['Accept: application/json'],
        ]);
        $raw = curl_exec($curl);
        curl_close($curl);
    } elseif (ini_get('allow_url_fopen')) {
        $context = stream_context_create([
            'http' => [
                'method' => 'GET',
                'timeout' => 12,
                'header' => "Accept: application/json\r\n",
            ],
        ]);
        $raw = @file_get_contents($url, false, $context);
    }

    if ($raw === false) {
        return null;
    }

    $decoded = json_decode($raw, true);
    if (!is_array($decoded) || !empty($decoded['Note']) || !empty($decoded['Information'])) {
        return null;
    }

    return $decoded;
}

function parse_symbols(string $raw): array
{
    $symbols = array_filter(array_map(static function (string $symbol): string {
        return strtoupper(trim($symbol));
    }, explode(',', $raw)));

    return array_values(array_unique(array_slice($symbols, 0, 25)));
}

$type = (string) ($_GET['type'] ?? '');

function crypto_quote(string $symbol): ?array
{
    global $apiKey;

    $cryptoSymbols = ['BTC', 'ETH', 'SOL', 'ADA', 'XRP', 'DOGE', 'AVAX', 'LINK', 'LTC', 'BCH'];
    if (!in_array($symbol, $cryptoSymbols, true)) {
        return null;
    }

    $yahoo = yahoo_quote($symbol . '-USD', $symbol, 'crypto');
    if ($yahoo) {
        return $yahoo;
    }
    if ($apiKey === '') {
        return null;
    }

    $data = alpha_request([
        'function' => 'CURRENCY_EXCHANGE_RATE',
        'from_currency' => $symbol,
        'to_currency' => 'USD',
    ]);
    $rate = $data['Realtime Currency Exchange Rate'] ?? [];
    $price = (float) ($rate['5. Exchange Rate'] ?? 0);
    if ($price <= 0) {
        return null;
    }

    return [
        'symbol' => $symbol,
        'price' => $price,
        'previousClose' => $price,
        'change' => 0,
        'changePercent' => 0,
        'latestTradingDay' => date('Y-m-d'),
        'assetType' => 'crypto',
        'name' => $rate['2. From_Currency Name'] ?? $symbol,
        'currency' => 'USD',
        'provider' => 'alpha_vantage',
    ];
}

function crypto_history(string $symbol, string $rangeKey): ?array
{
    $cryptoSymbols = ['BTC', 'ETH', 'SOL', 'ADA', 'XRP', 'DOGE', 'AVAX', 'LINK', 'LTC', 'BCH'];
    if (!in_array($symbol, $cryptoSymbols, true)) {
        return null;
    }

    return yahoo_history($symbol . '-USD', $symbol, 'crypto', $rangeKey);
}

function equity_quote(string $symbol): ?array
{
    global $apiKey;

    $yahoo = yahoo_quote($symbol, $symbol, 'stock');
    if ($yahoo) {
        return $yahoo;
    }
    if ($apiKey === '') {
        return null;
    }

    $data = alpha_request([
        'function' => 'GLOBAL_QUOTE',
        'symbol' => $symbol,
    ]);
    $quote = $data['Global Quote'] ?? [];
    $price = (float) ($quote['05. price'] ?? 0);
    if ($price <= 0) {
        return null;
    }

    return [
        'symbol' => $symbol,
        'price' => $price,
        'previousClose' => (float) ($quote['08. previous close'] ?? 0),
        'change' => (float) ($quote['09. change'] ?? 0),
        'changePercent' => (float) str_replace('%', '', (string) ($quote['10. change percent'] ?? '0')),
        'latestTradingDay' => $quote['07. latest trading day'] ?? null,
        'assetType' => 'stock',
        'provider' => 'alpha_vantage',
    ];
}

function equity_history(string $symbol, string $rangeKey): ?array
{
    return yahoo_history($symbol, $symbol, 'stock', $rangeKey);
}

if ($type === 'lookup') {
    $symbol = strtoupper(trim((string) ($_GET['symbol'] ?? '')));
    if ($symbol === '') {
        respond(['ok' => false, 'error' => 'Symbol is required.'], 400);
    }

    $crypto = crypto_quote($symbol);
    if ($crypto) {
        respond(['ok' => true, 'asset' => $crypto]);
    }

    $quote = equity_quote($symbol);
    if (!$quote) {
        respond(['ok' => false, 'error' => 'No live quote was found for this symbol.'], 404);
    }

    $search = alpha_soft_request([
        'function' => 'SYMBOL_SEARCH',
        'keywords' => $symbol,
    ]) ?? [];
    $matches = $search['bestMatches'] ?? [];
    $best = null;
    foreach ($matches as $match) {
        if (strtoupper((string) ($match['1. symbol'] ?? '')) === $symbol) {
            $best = $match;
            break;
        }
    }
    if (!$best && !empty($matches[0])) {
        $best = $matches[0];
    }

    $resolvedSymbol = strtoupper((string) ($best['1. symbol'] ?? $symbol));
    if ($resolvedSymbol !== $symbol) {
        $resolvedQuote = equity_quote($resolvedSymbol);
        if ($resolvedQuote) {
            $quote = $resolvedQuote;
        } else {
            $resolvedSymbol = $symbol;
        }
    }

    $alphaType = strtolower((string) ($best['3. type'] ?? ''));
    $assetType = strpos($alphaType, 'etf') !== false ? 'etf' : (strpos($alphaType, 'fund') !== false ? 'fund' : 'stock');

    respond([
        'ok' => true,
        'asset' => array_merge($quote, [
            'symbol' => $resolvedSymbol,
            'name' => $best['2. name'] ?? $quote['name'] ?? $resolvedSymbol,
            'assetType' => $assetType,
            'region' => $best['4. region'] ?? null,
            'currency' => $best['8. currency'] ?? $quote['currency'] ?? 'USD',
        ]),
    ]);
}

if ($type === 'quotes') {
    $symbols = parse_symbols((string) ($_GET['symbols'] ?? ''));
    if (!$symbols) {
        respond(['ok' => false, 'error' => 'At least one symbol is required.'], 400);
    }

    $quotes = [];
    foreach ($symbols as $symbol) {
        $quote = crypto_quote($symbol) ?? equity_quote($symbol);
        if ($quote) {
            $quotes[] = $quote;
        }
    }

    respond(['ok' => true, 'quotes' => $quotes]);
}

if ($type === 'history') {
    $symbols = parse_symbols((string) ($_GET['symbols'] ?? ''));
    $range = strtolower(trim((string) ($_GET['range'] ?? '1m')));
    if (!$symbols) {
        respond(['ok' => false, 'error' => 'At least one symbol is required.'], 400);
    }

    $history = [];
    foreach ($symbols as $symbol) {
        $series = crypto_history($symbol, $range) ?? equity_history($symbol, $range);
        if ($series) {
            $history[] = $series;
        }
    }

    respond(['ok' => true, 'range' => $range, 'history' => $history]);
}

if ($type === 'news') {
    $tickers = parse_symbols((string) ($_GET['symbols'] ?? ''));
    $formattedTickers = array_map(static function (string $symbol): string {
        return $symbol === 'BTC' ? 'CRYPTO:BTC' : $symbol;
    }, $tickers);

    $data = alpha_request([
        'function' => 'NEWS_SENTIMENT',
        'tickers' => implode(',', array_slice($formattedTickers, 0, 10)),
        'sort' => 'LATEST',
        'limit' => '50',
    ]);

    $feed = $data['feed'] ?? [];
    $news = array_map(static function (array $item): array {
        $ticker = 'MKT';
        if (!empty($item['ticker_sentiment'][0]['ticker'])) {
            $ticker = str_replace('CRYPTO:', '', (string) $item['ticker_sentiment'][0]['ticker']);
        }

        $published = (string) ($item['time_published'] ?? '');
        $date = $published ? preg_replace('/^(\d{4})(\d{2})(\d{2}).*/', '$1-$2-$3', $published) : date('Y-m-d');

        return [
            'id' => bin2hex(random_bytes(5)),
            'symbol' => $ticker,
            'title' => (string) ($item['title'] ?? 'Untitled'),
            'source' => (string) ($item['source'] ?? 'Alpha Vantage'),
            'url' => (string) ($item['url'] ?? ''),
            'date' => $date,
            'sentiment' => (string) ($item['overall_sentiment_label'] ?? 'Neutral'),
        ];
    }, is_array($feed) ? array_slice($feed, 0, 25) : []);

    respond(['ok' => true, 'news' => $news]);
}

respond(['ok' => false, 'error' => 'Unsupported market data request.'], 400);
