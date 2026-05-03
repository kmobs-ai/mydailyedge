<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';

require_user();

$apiKey = trim((string) ($config['alpha_vantage_api_key'] ?? ''));
if ($apiKey === '') {
    respond(['ok' => false, 'error' => 'Market data API key is not configured.'], 503);
}

function alpha_request(array $params): array
{
    global $apiKey;

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
        respond(['ok' => false, 'error' => $decoded['Note'] ?? $decoded['Information']], 429);
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

if ($type === 'quotes') {
    $symbols = parse_symbols((string) ($_GET['symbols'] ?? ''));
    if (!$symbols) {
        respond(['ok' => false, 'error' => 'At least one symbol is required.'], 400);
    }

    $quotes = [];
    foreach ($symbols as $symbol) {
        $data = alpha_request([
            'function' => 'GLOBAL_QUOTE',
            'symbol' => $symbol,
        ]);
        $quote = $data['Global Quote'] ?? [];
        $price = (float) ($quote['05. price'] ?? 0);
        if ($price <= 0) {
            continue;
        }

        $quotes[] = [
            'symbol' => $symbol,
            'price' => $price,
            'previousClose' => (float) ($quote['08. previous close'] ?? 0),
            'change' => (float) ($quote['09. change'] ?? 0),
            'changePercent' => (float) str_replace('%', '', (string) ($quote['10. change percent'] ?? '0')),
            'latestTradingDay' => $quote['07. latest trading day'] ?? null,
        ];
    }

    respond(['ok' => true, 'quotes' => $quotes]);
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
