<?php
declare(strict_types=1);

/**
 * One-shot script: generates a fresh VAPID keypair and prints the values
 * to stdout for you to paste into api/config.php.
 *
 * Run from cPanel terminal:
 *   /usr/bin/php /home/<user>/public_html/api/cron/generate-vapid.php
 *
 * Or hit it once over HTTP with the cron secret query param:
 *   https://mydailyedge.io/api/cron/generate-vapid.php?secret=<your-cron_secret>
 *
 * VAPID keys identify YOUR server to the push services (Google FCM, Mozilla
 * autopush, Apple). Generate them ONCE per environment, store both halves in
 * api/config.php, never check into git.
 */

if (PHP_SAPI !== 'cli') {
    $configPath = realpath(__DIR__ . '/../config.php');
    if (!$configPath || !is_file($configPath)) {
        http_response_code(503);
        echo "config.php missing\n";
        exit;
    }
    $cfg = require $configPath;
    $expected = (string) ($cfg['cron_secret'] ?? '');
    if ($expected === '' || !hash_equals($expected, (string) ($_GET['secret'] ?? ''))) {
        http_response_code(403);
        echo "forbidden\n";
        exit;
    }
    header('Content-Type: text/plain; charset=utf-8');
}

// Generate a fresh P-256 EC keypair using OpenSSL.
$res = openssl_pkey_new([
    'curve_name' => 'prime256v1',
    'private_key_type' => OPENSSL_KEYTYPE_EC,
]);
if (!$res) {
    fwrite(STDERR, "openssl_pkey_new failed: " . openssl_error_string() . "\n");
    exit(1);
}

openssl_pkey_export($res, $privatePem);
$details = openssl_pkey_get_details($res);

// Extract raw 32-byte private scalar `d` and the public point (x, y).
$d = $details['ec']['d'];
$x = $details['ec']['x'];
$y = $details['ec']['y'];

// Pad to 32 bytes (openssl can return shorter when leading zeros are stripped).
$pad32 = static fn(string $b) => str_pad($b, 32, "\x00", STR_PAD_LEFT);
$d = $pad32($d);
$x = $pad32($x);
$y = $pad32($y);

// Public key in uncompressed SEC1 form: 0x04 || X || Y  (65 bytes).
$publicRaw  = "\x04" . $x . $y;
$publicB64u = rtrim(strtr(base64_encode($publicRaw), '+/', '-_'), '=');
$privateB64u = rtrim(strtr(base64_encode($d), '+/', '-_'), '=');

echo "Add the following to api/config.php (inside the return [ ... ] array):\n\n";
echo "  'vapid_public_key'  => '{$publicB64u}',\n";
echo "  'vapid_private_key' => '{$privateB64u}',\n";
echo "  'vapid_subject'     => 'mailto:lsenges.it@gmail.com',  // change to your contact email\n\n";
echo "After saving, deploy api/web-push.php and api/cron/check-alerts.php so triggered alerts can fan out push notifications.\n";
