<?php
declare(strict_types=1);

/**
 * Shared helpers for the cron workers (check-alerts.php, daily-snapshot.php).
 *
 * Kept deliberately dependency-free — the crons run from the CLI and do not
 * bootstrap the full API stack (no session, no _bootstrap.php). Everything
 * here takes its config as an argument and never throws.
 */

if (!defined('CRON_CRYPTO_SET')) {
    define('CRON_CRYPTO_SET', ['BTC', 'ETH', 'SOL', 'ADA', 'XRP', 'DOGE', 'AVAX', 'LINK', 'LTC', 'BCH']);
}

/**
 * Low-level HTTP GET. Returns the response body, or null on any failure.
 * Mirrors api/market.php's http_get() so cron behavior matches the web app.
 */
function cron_http_get(
    string $url,
    int $timeout = 8,
    array $headers = ['Accept: application/json', 'User-Agent: MyDailyEdge-Cron/1.0']
): ?string {
    $raw = false;
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT        => $timeout,
            CURLOPT_CONNECTTIMEOUT => max(3, intdiv($timeout, 2)),
            CURLOPT_HTTPHEADER     => $headers,
        ]);
        $raw = curl_exec($ch);
        curl_close($ch);
    } elseif (ini_get('allow_url_fopen')) {
        $ctx = stream_context_create(['http' => [
            'method'  => 'GET',
            'timeout' => $timeout,
            'header'  => implode("\r\n", $headers) . "\r\n",
        ]]);
        $raw = @file_get_contents($url, false, $ctx);
    }
    return $raw === false ? null : $raw;
}

/**
 * Fetch a single quote for cron use, with provider fallback.
 *
 *   1. Yahoo Finance chart endpoint  (primary — no API key, no quota)
 *   2. Alpha Vantage                 (fallback — only if alpha_vantage_api_key
 *      is set; GLOBAL_QUOTE for equities, CURRENCY_EXCHANGE_RATE for crypto)
 *
 * Returns ['price' => float, 'previousClose' => float, 'provider' => string]
 * or null when every source failed. Never throws.
 *
 * Note on quota: Alpha Vantage's free tier is ~25 requests/day. The fallback
 * only fires when Yahoo fails, so in normal operation it is never touched. If
 * Yahoo has an extended outage a busy cron run could exhaust the daily quota —
 * acceptable, since partial coverage still beats none.
 */
function cron_fetch_quote(array $config, string $symbol): ?array
{
    $symbol      = strtoupper(trim($symbol));
    if ($symbol === '') {
        return null;
    }
    $isCrypto    = in_array($symbol, CRON_CRYPTO_SET, true);
    $yahooSymbol = $isCrypto ? $symbol . '-USD' : $symbol;

    // --- Primary: Yahoo Finance ---
    $raw = cron_http_get(
        'https://query1.finance.yahoo.com/v8/finance/chart/' . rawurlencode($yahooSymbol) . '?range=1d&interval=1d',
        8
    );
    if ($raw !== null) {
        $decoded = json_decode($raw, true);
        $meta    = $decoded['chart']['result'][0]['meta'] ?? null;
        if (is_array($meta)) {
            $price = (float) ($meta['regularMarketPrice'] ?? 0);
            if ($price > 0) {
                $previousClose = (float) ($meta['chartPreviousClose'] ?? $meta['previousClose'] ?? $price);
                return ['price' => $price, 'previousClose' => $previousClose, 'provider' => 'yahoo'];
            }
        }
    }

    // --- Fallback: Alpha Vantage (only when a key is configured) ---
    $apiKey = trim((string) ($config['alpha_vantage_api_key'] ?? ''));
    if ($apiKey === '') {
        return null;
    }

    if ($isCrypto) {
        $url = 'https://www.alphavantage.co/query?' . http_build_query([
            'function'      => 'CURRENCY_EXCHANGE_RATE',
            'from_currency' => $symbol,
            'to_currency'   => 'USD',
            'apikey'        => $apiKey,
        ]);
        $raw = cron_http_get($url, 12);
        if ($raw === null) {
            return null;
        }
        $decoded = json_decode($raw, true);
        if (!is_array($decoded) || !empty($decoded['Note']) || !empty($decoded['Information'])) {
            return null; // rate-limited or malformed
        }
        $price = (float) ($decoded['Realtime Currency Exchange Rate']['5. Exchange Rate'] ?? 0);
        if ($price <= 0) {
            return null;
        }
        // Alpha Vantage's exchange-rate endpoint has no previous close.
        return ['price' => $price, 'previousClose' => $price, 'provider' => 'alpha_vantage'];
    }

    $url = 'https://www.alphavantage.co/query?' . http_build_query([
        'function' => 'GLOBAL_QUOTE',
        'symbol'   => $symbol,
        'apikey'   => $apiKey,
    ]);
    $raw = cron_http_get($url, 12);
    if ($raw === null) {
        return null;
    }
    $decoded = json_decode($raw, true);
    if (!is_array($decoded) || !empty($decoded['Note']) || !empty($decoded['Information'])) {
        return null; // rate-limited or malformed
    }
    $quote = $decoded['Global Quote'] ?? [];
    $price = (float) ($quote['05. price'] ?? 0);
    if ($price <= 0) {
        return null;
    }
    $previousClose = (float) ($quote['08. previous close'] ?? 0);
    if ($previousClose <= 0) {
        $previousClose = $price;
    }
    return ['price' => $price, 'previousClose' => $previousClose, 'provider' => 'alpha_vantage'];
}
