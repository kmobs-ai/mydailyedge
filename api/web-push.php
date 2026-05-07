<?php
declare(strict_types=1);

/**
 * Minimal Web Push implementation: VAPID auth + payload encryption.
 * No Composer / vendor dependencies — uses only ext-openssl and ext-curl.
 *
 * Standards followed:
 *  - RFC 8291: Message Encryption for Web Push (aes128gcm content encoding)
 *  - RFC 8292: Voluntary Application Server Identification (VAPID)
 *
 * Public surface:
 *   web_push_send($config, $subscription, $payload, $options = []): array
 *
 *   $subscription = [
 *     'endpoint' => 'https://fcm.googleapis.com/...',
 *     'p256dh'   => '<base64url public key>',
 *     'auth'     => '<base64url 16-byte secret>',
 *   ];
 *
 *   Returns ['statusCode' => int, 'body' => string].
 *   Status 410 / 404 means the subscription has expired and the row should be deleted.
 */

function b64u_encode(string $bin): string
{
    return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
}

function b64u_decode(string $s): string
{
    $s = strtr($s, '-_', '+/');
    $pad = strlen($s) % 4;
    if ($pad) $s .= str_repeat('=', 4 - $pad);
    return base64_decode($s, true) ?: '';
}

/**
 * Sign a string with a P-256 ECDSA key, returning the JWS-format raw r||s
 * (64 bytes), not OpenSSL's ASN.1 DER encoding.
 */
function vapid_sign_es256(string $message, string $privateScalar): string
{
    // Build a PEM EC private key from the raw 32-byte scalar.
    $pem = vapid_private_key_pem($privateScalar);
    $key = openssl_pkey_get_private($pem);
    if (!$key) {
        throw new RuntimeException('vapid: failed to load EC private key: ' . openssl_error_string());
    }
    $der = '';
    if (!openssl_sign($message, $der, $key, OPENSSL_ALGO_SHA256)) {
        throw new RuntimeException('vapid: openssl_sign failed: ' . openssl_error_string());
    }
    // Parse ASN.1 DER signature (SEQUENCE { r INTEGER, s INTEGER }) into 64-byte raw.
    return der_signature_to_raw($der);
}

function der_signature_to_raw(string $der): string
{
    if (substr($der, 0, 1) !== "\x30") {
        throw new RuntimeException('vapid: signature DER missing SEQUENCE');
    }
    $offset = 2;
    if (ord($der[1]) > 0x80) $offset = 2 + (ord($der[1]) & 0x7F);
    $extract = static function (string $der, int &$offset) {
        if ($der[$offset] !== "\x02") {
            throw new RuntimeException('vapid: expected INTEGER');
        }
        $len = ord($der[$offset + 1]);
        $offset += 2;
        $value = substr($der, $offset, $len);
        $offset += $len;
        // Strip leading zero added when high bit was set.
        if (strlen($value) > 32 && $value[0] === "\x00") $value = substr($value, 1);
        // Pad to 32.
        return str_pad($value, 32, "\x00", STR_PAD_LEFT);
    };
    $r = $extract($der, $offset);
    $s = $extract($der, $offset);
    return $r . $s;
}

function vapid_private_key_pem(string $rawScalar): string
{
    // Build a SEC1 DER for an EC private key on prime256v1.
    // SEQUENCE {
    //   INTEGER 1,
    //   OCTET STRING privateKey,
    //   [0] OBJECT IDENTIFIER prime256v1
    // }
    $oid_prime256v1 = "\x06\x08\x2A\x86\x48\xCE\x3D\x03\x01\x07";
    $param = "\xA0" . chr(strlen($oid_prime256v1)) . $oid_prime256v1;
    $key = "\x04\x20" . $rawScalar; // OCTET STRING of length 32
    $version = "\x02\x01\x01";
    $body = $version . $key . $param;
    $der = "\x30" . der_length(strlen($body)) . $body;
    return "-----BEGIN EC PRIVATE KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END EC PRIVATE KEY-----\n";
}

function der_length(int $len): string
{
    if ($len < 128) return chr($len);
    $hex = ltrim(dechex($len), '0');
    if (strlen($hex) % 2) $hex = '0' . $hex;
    $bytes = hex2bin($hex);
    return chr(0x80 | strlen($bytes)) . $bytes;
}

/**
 * Build the VAPID Authorization header value for a given push endpoint.
 */
function vapid_authorization_header(string $endpoint, array $config, int $expirySeconds = 43200): string
{
    $publicRaw = b64u_decode((string) $config['vapid_public_key']);
    $privateRaw = b64u_decode((string) $config['vapid_private_key']);
    $sub = (string) $config['vapid_subject'];

    $audience = parse_audience_origin($endpoint);

    $header = b64u_encode(json_encode(['typ' => 'JWT', 'alg' => 'ES256'], JSON_UNESCAPED_SLASHES));
    $claims = b64u_encode(json_encode([
        'aud' => $audience,
        'exp' => time() + min(86400, $expirySeconds),
        'sub' => $sub,
    ], JSON_UNESCAPED_SLASHES));
    $signingInput = "$header.$claims";
    $sig = b64u_encode(vapid_sign_es256($signingInput, $privateRaw));
    $jwt = "$signingInput.$sig";
    $k = b64u_encode($publicRaw);

    return "vapid t=$jwt, k=$k";
}

function parse_audience_origin(string $endpoint): string
{
    $parts = parse_url($endpoint);
    if (!$parts || empty($parts['scheme']) || empty($parts['host'])) {
        throw new RuntimeException('web-push: malformed endpoint URL');
    }
    return $parts['scheme'] . '://' . $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '');
}

/**
 * RFC 8291 aes128gcm encryption.
 *
 * @param string $payload      plain UTF-8 text up to ~3993 bytes
 * @param string $userAgentPub raw 65-byte SEC1 public key from subscription.p256dh
 * @param string $authSecret   raw 16-byte secret from subscription.auth
 * @return string              the encrypted body, ready for the request body
 */
function aes128gcm_encrypt_payload(string $payload, string $userAgentPub, string $authSecret): string
{
    // 1. Generate ephemeral P-256 keypair (server side).
    $ephRes = openssl_pkey_new([
        'curve_name' => 'prime256v1',
        'private_key_type' => OPENSSL_KEYTYPE_EC,
    ]);
    if (!$ephRes) throw new RuntimeException('web-push: ephemeral key gen failed');
    $ephDetails = openssl_pkey_get_details($ephRes);
    $ephPubX = str_pad($ephDetails['ec']['x'], 32, "\x00", STR_PAD_LEFT);
    $ephPubY = str_pad($ephDetails['ec']['y'], 32, "\x00", STR_PAD_LEFT);
    $ephPubRaw = "\x04" . $ephPubX . $ephPubY;

    // 2. ECDH: derive shared secret.
    $uaPubPem = ec_public_key_pem_from_raw($userAgentPub);
    $uaPubKey = openssl_pkey_get_public($uaPubPem);
    if (!$uaPubKey) throw new RuntimeException('web-push: invalid user-agent public key');
    $sharedSecret = openssl_pkey_derive($uaPubKey, $ephRes, 0);
    if (!$sharedSecret) throw new RuntimeException('web-push: ECDH derive failed');

    // 3. HKDF chain (RFC 8291 §3.4).
    $salt = random_bytes(16);
    $prkKey = hash_hkdf('sha256', $sharedSecret, 32, "WebPush: info\x00" . $userAgentPub . $ephPubRaw, $authSecret);
    $contentKey = hash_hkdf('sha256', $prkKey, 16, "Content-Encoding: aes128gcm\x00", $salt);
    $contentNonce = hash_hkdf('sha256', $prkKey, 12, "Content-Encoding: nonce\x00", $salt);

    // 4. Pad and AES-128-GCM encrypt.
    $plaintext = $payload . "\x02"; // delimiter byte for last record
    $tag = '';
    $cipherText = openssl_encrypt($plaintext, 'aes-128-gcm', $contentKey, OPENSSL_RAW_DATA, $contentNonce, $tag);
    if ($cipherText === false) throw new RuntimeException('web-push: AES-GCM encrypt failed');

    // 5. Build the aes128gcm record header + payload.
    //    salt(16) || rs(4 BE) || idlen(1) || keyid(idlen) || ciphertext+tag
    $rs = 4096;
    $header = $salt . pack('N', $rs) . chr(strlen($ephPubRaw)) . $ephPubRaw;
    return $header . $cipherText . $tag;
}

function ec_public_key_pem_from_raw(string $raw): string
{
    if (strlen($raw) !== 65 || $raw[0] !== "\x04") {
        throw new RuntimeException('web-push: expected 65-byte uncompressed EC point');
    }
    // SubjectPublicKeyInfo for prime256v1.
    $algo = "\x30\x13\x06\x07\x2A\x86\x48\xCE\x3D\x02\x01\x06\x08\x2A\x86\x48\xCE\x3D\x03\x01\x07";
    $bitString = "\x03" . der_length(strlen($raw) + 1) . "\x00" . $raw;
    $body = $algo . $bitString;
    $der = "\x30" . der_length(strlen($body)) . $body;
    return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
}

function web_push_send(array $config, array $subscription, string $payload, array $options = []): array
{
    $endpoint = (string) $subscription['endpoint'];
    $userAgentPub = b64u_decode((string) $subscription['p256dh']);
    $authSecret = b64u_decode((string) $subscription['auth']);
    if (strlen($userAgentPub) !== 65 || strlen($authSecret) !== 16) {
        throw new RuntimeException('web-push: bad subscription keys');
    }

    $body = aes128gcm_encrypt_payload($payload, $userAgentPub, $authSecret);
    $authHeader = vapid_authorization_header($endpoint, $config);

    $headers = [
        'Authorization: ' . $authHeader,
        'Crypto-Key: p256ecdsa=' . b64u_encode(b64u_decode($config['vapid_public_key'])),  // rebuild for safety
        'Content-Type: application/octet-stream',
        'Content-Encoding: aes128gcm',
        'TTL: ' . (int) ($options['ttl'] ?? 86400),
        'Urgency: ' . ($options['urgency'] ?? 'normal'),
    ];

    $ch = curl_init($endpoint);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $body,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_TIMEOUT => 12,
        CURLOPT_FOLLOWLOCATION => false,
    ]);
    $respBody = curl_exec($ch);
    $statusCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);

    if ($respBody === false) {
        throw new RuntimeException('web-push: curl error: ' . $err);
    }

    return ['statusCode' => $statusCode, 'body' => (string) $respBody];
}
