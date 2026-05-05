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
        curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_TIMEOUT => 12, CURLOPT_HTTPHEADER => ['Accept: application/json']]);
        $raw = curl_exec($curl);
        curl_close($curl);
    } elseif (ini_get('allow_url_fopen')) {
        $context = stream_context_create(['http' => ['method' => 'GET', 'timeout' => 12, 'header' => "Accept: application/json\r\n"]]);
        $raw = @file_get_contents($url, false, $context);
    }
    if ($raw === false) respond(['ok' => false, 'error' => 'Market data provider request failed.'], 502);
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) respond(['ok' => false, 'error' => 'Market data provider returned invalid JSON.'], 502);
    if (!empty($decoded['Note']) || !empty($decoded['Information'])) {
        respond(['ok' => false, 'error' => alpha_error_message($decoded['Note'] ?? $decoded['Information'])], 429);
    }
    return $decoded;
}

function alpha_error_message(string $message): string
{
    $lower = strtolower($message);
    if (strpos($lower, 'rate limit') !== false || strpos($lower, 'requests per day') !== false || strpos($lower, 'requests per minute') !== false) return 'Alpha Vantage free limit reached. You can still enter this position manually; live lookup will work again after the provider resets your quota.';
    if (strpos($lower, 'invalid') !== false) return 'Alpha Vantage rejected that symbol. Check the ticker, or enter the position manually and mark it as a stock/ETF/crypto.';
    return 'Alpha Vantage could not complete this lookup. Enter the position manually or try again later.';
}

function http_get(string $url, int $timeout = 8, array $headers = ['Accept: application/json', 'User-Agent: MyDailyEdge/1.0']): ?string
{
    $raw = false;
    if (function_exists('curl_init')) {
        $curl = curl_init($url);
        curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_TIMEOUT => $timeout, CURLOPT_CONNECTTIMEOUT => max(3, intdiv($timeout, 2)), CURLOPT_HTTPHEADER => $headers]);
        $raw = curl_exec($curl);
        curl_close($curl);
    } elseif (ini_get('allow_url_fopen')) {
        $headerStr = implode("\r\n", $headers) . "\r\n";
        $context = stream_context_create(['http' => ['method' => 'GET', 'timeout' => $timeout, 'header' => $headerStr]]);
        $raw = @file_get_contents($url, false, $context);
    }
    return $raw === false ? null : $raw;
}

function yahoo_quote(string $symbol, ?string $displaySymbol = null, string $assetType = 'stock'): ?array
{
    $url = 'https://query1.finance.yahoo.com/v8/finance/chart/' . rawurlencode($symbol) . '?range=1d&interval=1d';
    $raw = http_get($url, 8);
    if ($raw === null) return null;
    $decoded = json_decode($raw, true);
    $meta = $decoded['chart']['result'][0]['meta'] ?? null;
    if (!is_array($meta)) return null;
    $price = (float) ($meta['regularMarketPrice'] ?? 0);
    if ($price <= 0) return null;
    $previousClose = (float) ($meta['chartPreviousClose'] ?? $meta['previousClose'] ?? $price);
    return ['symbol' => $displaySymbol ?? strtoupper($symbol), 'price' => $price, 'previousClose' => $previousClose, 'change' => $price - $previousClose, 'changePercent' => $previousClose ? (($price - $previousClose) / $previousClose) * 100 : 0, 'latestTradingDay' => isset($meta['regularMarketTime']) ? date('Y-m-d', (int) $meta['regularMarketTime']) : date('Y-m-d'), 'assetType' => $assetType, 'name' => $meta['shortName'] ?? $meta['longName'] ?? ($displaySymbol ?? strtoupper($symbol)), 'currency' => $meta['currency'] ?? 'USD', 'provider' => 'yahoo'];
}

function yahoo_history(string $symbol, ?string $displaySymbol = null, string $assetType = 'stock', string $rangeKey = '1m'): ?array
{
    $rangeMap = ['24h' => ['range' => '1d', 'interval' => '5m'], '7d' => ['range' => '5d', 'interval' => '15m'], '1m' => ['range' => '1mo', 'interval' => '1d'], '6m' => ['range' => '6mo', 'interval' => '1d'], 'ytd' => ['range' => 'ytd', 'interval' => '1d'], 'all' => ['range' => 'max', 'interval' => '1mo']];
    $choice = $rangeMap[$rangeKey] ?? $rangeMap['1m'];
    $url = 'https://query1.finance.yahoo.com/v8/finance/chart/' . rawurlencode($symbol) . '?' . http_build_query($choice);
    $raw = http_get($url, 10);
    if ($raw === null) return null;
    $decoded = json_decode($raw, true);
    $result = $decoded['chart']['result'][0] ?? null;
    if (!is_array($result)) return null;
    $timestamps = $result['timestamp'] ?? [];
    $quotes = $result['indicators']['quote'][0]['close'] ?? [];
    if (!is_array($timestamps) || !is_array($quotes) || count($timestamps) === 0) return null;
    $points = [];
    foreach ($timestamps as $index => $timestamp) {
        $price = isset($quotes[$index]) ? (float) $quotes[$index] : 0;
        if ($price <= 0) continue;
        $points[] = ['date' => date($choice['interval'] === '1d' || $choice['interval'] === '1mo' ? 'Y-m-d' : 'Y-m-d H:i', (int) $timestamp), 'timestamp' => (int) $timestamp, 'price' => $price];
    }
    if (!$points) return null;
    $meta = $result['meta'] ?? [];
    return ['symbol' => $displaySymbol ?? strtoupper($symbol), 'assetType' => $assetType, 'range' => $rangeKey, 'provider' => 'yahoo', 'currency' => $meta['currency'] ?? 'USD', 'points' => $points];
}

function alpha_soft_request(array $params): ?array
{
    global $apiKey;
    if ($apiKey === '') return null;
    $params['apikey'] = $apiKey;
    $url = 'https://www.alphavantage.co/query?' . http_build_query($params);
    $raw = http_get($url, 12);
    if ($raw === null) return null;
    $decoded = json_decode($raw, true);
    if (!is_array($decoded) || !empty($decoded['Note']) || !empty($decoded['Information'])) return null;
    return $decoded;
}

function parse_symbols(string $raw): array
{
    $symbols = array_filter(array_map(static function (string $s): string { return strtoupper(trim($s)); }, explode(',', $raw)));
    return array_values(array_unique(array_slice($symbols, 0, 25)));
}

function news_ticker_for_alpha(string $symbol): string
{
    $cryptoSymbols = ['BTC','ETH','SOL','ADA','XRP','DOGE','AVAX','LINK','LTC','BCH'];
    return in_array($symbol, $cryptoSymbols, true) ? 'CRYPTO:' . $symbol : $symbol;
}

function alpha_news(array $tickers): array
{
    if (!$tickers) return [];
    $data = alpha_soft_request(['function' => 'NEWS_SENTIMENT', 'tickers' => implode(',', array_slice(array_map('news_ticker_for_alpha', $tickers), 0, 10)), 'sort' => 'LATEST', 'limit' => '50']);
    if (!$data) return [];
    $feed = $data['feed'] ?? [];
    if (!is_array($feed)) return [];
    return array_map(static function (array $item): array {
        $ticker = 'MKT';
        if (!empty($item['ticker_sentiment'][0]['ticker'])) $ticker = str_replace('CRYPTO:', '', (string) $item['ticker_sentiment'][0]['ticker']);
        $published = (string) ($item['time_published'] ?? '');
        $date = $published ? preg_replace('/^(\d{4})(\d{2})(\d{2}).*/', '$1-$2-$3', $published) : date('Y-m-d');
        return ['id' => bin2hex(random_bytes(5)), 'symbol' => $ticker, 'category' => 'portfolio', 'title' => (string) ($item['title'] ?? 'Untitled'), 'source' => (string) ($item['source'] ?? 'Alpha Vantage'), 'sourceKey' => 'alphavantage', 'url' => (string) ($item['url'] ?? ''), 'date' => $date, 'publishedAt' => $published ? preg_replace('/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2}).*/', '$1-$2-$3T$4:$5:$6', $published) : date('c'), 'sentiment' => (string) ($item['overall_sentiment_label'] ?? 'Neutral')];
    }, array_slice($feed, 0, 25));
}

function yahoo_news_symbol(string $symbol): string
{
    $cryptoSymbols = ['BTC','ETH','SOL','ADA','XRP','DOGE','AVAX','LINK','LTC','BCH'];
    return in_array($symbol, $cryptoSymbols, true) ? $symbol . '-USD' : $symbol;
}

function yahoo_news(array $tickers): array
{
    $items = [];
    foreach (array_slice($tickers, 0, 12) as $symbol) {
        $rssSymbol = yahoo_news_symbol($symbol);
        $url = 'https://feeds.finance.yahoo.com/rss/2.0/headline?' . http_build_query(['s' => $rssSymbol, 'region' => 'US', 'lang' => 'en-US']);
        $raw = http_get($url, 8, ['Accept: application/rss+xml, application/xml, text/xml', 'User-Agent: MyDailyEdge/1.0']);
        if ($raw === null || !function_exists('simplexml_load_string')) continue;
        $xml = @simplexml_load_string($raw);
        if (!$xml || empty($xml->channel->item)) continue;
        foreach ($xml->channel->item as $item) {
            $published = strtotime((string) ($item->pubDate ?? '')) ?: time();
            $items[] = ['id' => bin2hex(random_bytes(5)), 'symbol' => $symbol, 'category' => 'portfolio', 'title' => trim((string) ($item->title ?? 'Untitled')), 'source' => 'Yahoo Finance', 'sourceKey' => 'yahoo', 'url' => trim((string) ($item->link ?? '')), 'date' => date('Y-m-d', $published), 'publishedAt' => date('c', $published), 'sentiment' => 'Neutral'];
        }
    }
    usort($items, static function (array $a, array $b): int { return strcmp((string) $b['date'], (string) $a['date']); });
    return array_slice($items, 0, 30);
}

function dedupe_news(array $items): array
{
    $seen = []; $deduped = [];
    foreach ($items as $item) {
        $key = strtolower((string) ($item['url'] ?: $item['title']));
        if ($key === '' || isset($seen[$key])) continue;
        $seen[$key] = true; $deduped[] = $item;
    }
    usort($deduped, static function (array $a, array $b): int { return strcmp((string) ($b['date'] ?? ''), (string) ($a['date'] ?? '')); });
    return array_slice($deduped, 0, 60);
}

/**
 * Generic RSS fetch with file-based caching. 15-min default TTL.
 * Returns a list of normalized news items or [] on failure.
 */
function fetch_rss_feed(string $url, string $sourceLabel, string $sourceKey, string $defaultCategory = 'markets', int $cacheTtl = 900): array
{
    static $cacheDir = null;
    if ($cacheDir === null) {
        $cacheDir = sys_get_temp_dir() . '/mydailyedge_rss';
        if (!is_dir($cacheDir)) @mkdir($cacheDir, 0755, true);
    }
    $cacheFile = $cacheDir . '/' . sha1($url) . '.json';
    if (is_file($cacheFile) && (time() - filemtime($cacheFile)) < $cacheTtl) {
        $cached = @json_decode((string) @file_get_contents($cacheFile), true);
        if (is_array($cached)) return $cached;
    }
    $raw = http_get($url, 8, ['Accept: application/rss+xml, application/xml, text/xml, application/atom+xml', 'User-Agent: MyDailyEdge/1.0 (+https://mydailyedge.io)']);
    if ($raw === null || !function_exists('simplexml_load_string')) return [];
    libxml_use_internal_errors(true);
    $xml = @simplexml_load_string($raw);
    libxml_clear_errors();
    if (!$xml) return [];
    $items = [];
    if (isset($xml->channel->item)) {
        foreach ($xml->channel->item as $item) {
            $pub = strtotime((string) ($item->pubDate ?? '')) ?: time();
            $title = trim((string) ($item->title ?? 'Untitled'));
            $link = trim((string) ($item->link ?? ''));
            if ($title === '' || $link === '') continue;
            $items[] = ['id' => bin2hex(random_bytes(5)), 'symbol' => 'MKT', 'category' => $defaultCategory, 'title' => $title, 'source' => $sourceLabel, 'sourceKey' => $sourceKey, 'url' => $link, 'date' => date('Y-m-d', $pub), 'publishedAt' => date('c', $pub), 'sentiment' => 'Neutral'];
        }
    }
    if (!$items && isset($xml->entry)) {
        foreach ($xml->entry as $entry) {
            $pub = strtotime((string) ($entry->updated ?? $entry->published ?? '')) ?: time();
            $title = trim((string) ($entry->title ?? 'Untitled'));
            $link = '';
            if (isset($entry->link['href'])) $link = trim((string) $entry->link['href']);
            elseif (isset($entry->link)) $link = trim((string) $entry->link);
            if ($title === '' || $link === '') continue;
            $items[] = ['id' => bin2hex(random_bytes(5)), 'symbol' => 'MKT', 'category' => $defaultCategory, 'title' => $title, 'source' => $sourceLabel, 'sourceKey' => $sourceKey, 'url' => $link, 'date' => date('Y-m-d', $pub), 'publishedAt' => date('c', $pub), 'sentiment' => 'Neutral'];
        }
    }
    @file_put_contents($cacheFile, json_encode($items, JSON_UNESCAPED_SLASHES));
    return $items;
}

/**
 * Aggregated multi-source RSS:
 *  The Block, CoinDesk, Cointelegraph, Yahoo Finance.
 */
function aggregated_market_news(): array
{
    $sources = [
        ['url' => 'https://www.theblock.co/rss.xml',                  'label' => 'The Block',     'key' => 'theblock',      'category' => 'crypto'],
        ['url' => 'https://www.coindesk.com/arc/outboundfeeds/rss/',  'label' => 'CoinDesk',      'key' => 'coindesk',      'category' => 'crypto'],
        ['url' => 'https://cointelegraph.com/rss',                    'label' => 'Cointelegraph', 'key' => 'cointelegraph', 'category' => 'crypto'],
        ['url' => 'https://finance.yahoo.com/news/rssindex',          'label' => 'Yahoo Finance', 'key' => 'yahoo',         'category' => 'markets'],
    ];
    $all = [];
    foreach ($sources as $s) {
        $items = fetch_rss_feed($s['url'], $s['label'], $s['key'], $s['category']);
        $all = array_merge($all, array_slice($items, 0, 12));
    }
    return $all;
}

$type = (string) ($_GET['type'] ?? '');

function crypto_quote(string $symbol): ?array
{
    global $apiKey;
    $cryptoSymbols = ['BTC','ETH','SOL','ADA','XRP','DOGE','AVAX','LINK','LTC','BCH'];
    if (!in_array($symbol, $cryptoSymbols, true)) return null;
    $yahoo = yahoo_quote($symbol . '-USD', $symbol, 'crypto');
    if ($yahoo) return $yahoo;
    if ($apiKey === '') return null;
    $data = alpha_request(['function' => 'CURRENCY_EXCHANGE_RATE', 'from_currency' => $symbol, 'to_currency' => 'USD']);
    $rate = $data['Realtime Currency Exchange Rate'] ?? [];
    $price = (float) ($rate['5. Exchange Rate'] ?? 0);
    if ($price <= 0) return null;
    return ['symbol' => $symbol, 'price' => $price, 'previousClose' => $price, 'change' => 0, 'changePercent' => 0, 'latestTradingDay' => date('Y-m-d'), 'assetType' => 'crypto', 'name' => $rate['2. From_Currency Name'] ?? $symbol, 'currency' => 'USD', 'provider' => 'alpha_vantage'];
}

function crypto_history(string $symbol, string $rangeKey): ?array
{
    $cryptoSymbols = ['BTC','ETH','SOL','ADA','XRP','DOGE','AVAX','LINK','LTC','BCH'];
    if (!in_array($symbol, $cryptoSymbols, true)) return null;
    return yahoo_history($symbol . '-USD', $symbol, 'crypto', $rangeKey);
}

function equity_quote(string $symbol): ?array
{
    global $apiKey;
    $yahoo = yahoo_quote($symbol, $symbol, 'stock');
    if ($yahoo) return $yahoo;
    if ($apiKey === '') return null;
    $data = alpha_request(['function' => 'GLOBAL_QUOTE', 'symbol' => $symbol]);
    $quote = $data['Global Quote'] ?? [];
    $price = (float) ($quote['05. price'] ?? 0);
    if ($price <= 0) return null;
    return ['symbol' => $symbol, 'price' => $price, 'previousClose' => (float) ($quote['08. previous close'] ?? 0), 'change' => (float) ($quote['09. change'] ?? 0), 'changePercent' => (float) str_replace('%', '', (string) ($quote['10. change percent'] ?? '0')), 'latestTradingDay' => $quote['07. latest trading day'] ?? null, 'assetType' => 'stock', 'provider' => 'alpha_vantage'];
}

function equity_history(string $symbol, string $rangeKey): ?array { return yahoo_history($symbol, $symbol, 'stock', $rangeKey); }

if ($type === 'lookup') {
    $symbol = strtoupper(trim((string) ($_GET['symbol'] ?? '')));
    if ($symbol === '') respond(['ok' => false, 'error' => 'Symbol is required.'], 400);
    $crypto = crypto_quote($symbol);
    if ($crypto) respond(['ok' => true, 'asset' => $crypto]);
    $quote = equity_quote($symbol);
    if (!$quote) respond(['ok' => false, 'error' => 'No live quote was found for this symbol.'], 404);
    $search = alpha_soft_request(['function' => 'SYMBOL_SEARCH', 'keywords' => $symbol]) ?? [];
    $matches = $search['bestMatches'] ?? [];
    $best = null;
    foreach ($matches as $match) { if (strtoupper((string) ($match['1. symbol'] ?? '')) === $symbol) { $best = $match; break; } }
    if (!$best && !empty($matches[0])) $best = $matches[0];
    $resolvedSymbol = strtoupper((string) ($best['1. symbol'] ?? $symbol));
    if ($resolvedSymbol !== $symbol) {
        $resolvedQuote = equity_quote($resolvedSymbol);
        if ($resolvedQuote) $quote = $resolvedQuote;
        else $resolvedSymbol = $symbol;
    }
    $alphaType = strtolower((string) ($best['3. type'] ?? ''));
    $assetType = strpos($alphaType, 'etf') !== false ? 'etf' : (strpos($alphaType, 'fund') !== false ? 'fund' : 'stock');
    respond(['ok' => true, 'asset' => array_merge($quote, ['symbol' => $resolvedSymbol, 'name' => $best['2. name'] ?? $quote['name'] ?? $resolvedSymbol, 'assetType' => $assetType, 'region' => $best['4. region'] ?? null, 'currency' => $best['8. currency'] ?? $quote['currency'] ?? 'USD'])]);
}

if ($type === 'quotes') {
    $symbols = parse_symbols((string) ($_GET['symbols'] ?? ''));
    if (!$symbols) respond(['ok' => false, 'error' => 'At least one symbol is required.'], 400);
    $quotes = [];
    foreach ($symbols as $symbol) { $quote = crypto_quote($symbol) ?? equity_quote($symbol); if ($quote) $quotes[] = $quote; }
    respond(['ok' => true, 'quotes' => $quotes]);
}

if ($type === 'history') {
    $symbols = parse_symbols((string) ($_GET['symbols'] ?? ''));
    $range = strtolower(trim((string) ($_GET['range'] ?? '1m')));
    if (!$symbols) respond(['ok' => false, 'error' => 'At least one symbol is required.'], 400);
    $history = [];
    foreach ($symbols as $symbol) { $series = crypto_history($symbol, $range) ?? equity_history($symbol, $range); if ($series) $history[] = $series; }
    respond(['ok' => true, 'range' => $range, 'history' => $history]);
}

if ($type === 'news') {
    $tickers = parse_symbols((string) ($_GET['symbols'] ?? ''));
    $sourcesParam = strtolower(trim((string) ($_GET['sources'] ?? 'all')));
    $includePortfolio = $sourcesParam === 'all' || strpos($sourcesParam, 'portfolio') !== false;
    $includeMarkets = $sourcesParam === 'all' || strpos($sourcesParam, 'markets') !== false || strpos($sourcesParam, 'rss') !== false;
    $alphaItems = $includePortfolio && $tickers ? alpha_news($tickers) : [];
    $yahooItems = $includePortfolio && $tickers ? yahoo_news($tickers) : [];
    $rssItems = $includeMarkets ? aggregated_market_news() : [];
    $providers = [];
    if ($alphaItems) $providers[] = 'Alpha Vantage';
    if ($yahooItems) $providers[] = 'Yahoo Finance (tickers)';
    if ($rssItems) $providers[] = 'The Block + CoinDesk + Cointelegraph + Yahoo RSS';
    $provider = $providers ? implode(' + ', $providers) : 'None';
    $merged = dedupe_news(array_merge($alphaItems, $yahooItems, $rssItems));
    if ($tickers) {
        $tickerSet = array_flip($tickers);
        usort($merged, static function (array $a, array $b) use ($tickerSet): int {
            $aHit = isset($tickerSet[(string) ($a['symbol'] ?? '')]) ? 1 : 0;
            $bHit = isset($tickerSet[(string) ($b['symbol'] ?? '')]) ? 1 : 0;
            if ($aHit !== $bHit) return $bHit - $aHit;
            return strcmp((string) ($b['date'] ?? ''), (string) ($a['date'] ?? ''));
        });
    }
    respond(['ok' => true, 'provider' => $provider, 'sources' => array_values(array_unique(array_map(static fn($i) => $i['sourceKey'] ?? 'unknown', $merged))), 'news' => $merged]);
}

respond(['ok' => false, 'error' => 'Unsupported market data request.'], 400);
