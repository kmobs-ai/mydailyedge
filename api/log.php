<?php
declare(strict_types=1);

// Frontend error sink. Receives JSON via fetch/sendBeacon, appends a single
// line to a log file. Best-effort: never blocks, never errors back to the
// client (a broken error logger shouldn't itself surface as another error).

header('Content-Type: text/plain; charset=utf-8');
header('Cache-Control: no-store');

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    echo "method not allowed\n";
    exit;
}

$raw = file_get_contents('php://input');
if ($raw === false || strlen($raw) > 8192) {
    http_response_code(204);
    exit;
}
$decoded = json_decode($raw, true);
if (!is_array($decoded)) {
    http_response_code(204);
    exit;
}

// Redact obvious secrets from the message + stack before they hit disk.
function redact(string $s): string {
    // Cap length to keep logs bounded
    $s = mb_substr($s, 0, 1500);
    // Strip query strings that look like cron secrets or tokens
    $s = preg_replace('/([?&](?:secret|token|key|password|csrf)=)[^&\s]+/i', '$1[REDACTED]', $s);
    // Strip anything that looks like a bearer or vapid token chunk (long base64-like)
    $s = preg_replace('/\b[A-Za-z0-9_\-]{40,}\b/', '[REDACTED-TOKEN]', $s);
    return $s;
}

$line = sprintf(
    "%s | %s | %s | %s | %s | %s | %s\n",
    date('c'),
    substr((string) ($_SERVER['REMOTE_ADDR'] ?? '?'), 0, 45),
    redact((string) ($decoded['kind'] ?? 'error')),
    redact((string) ($decoded['message'] ?? '')),
    redact((string) ($decoded['source'] ?? '')) . ':' . (int) ($decoded['line'] ?? 0) . ':' . (int) ($decoded['col'] ?? 0),
    redact((string) ($decoded['url'] ?? '')),
    redact((string) ($decoded['userAgent'] ?? ''))
);

// Append to a daily log file in a sibling 'logs/' directory if writable, else stderr
$logDir = __DIR__ . '/../logs';
if (!is_dir($logDir)) @mkdir($logDir, 0755, true);
$logFile = $logDir . '/frontend-' . date('Y-m') . '.log';
@file_put_contents($logFile, $line, FILE_APPEND | LOCK_EX);

http_response_code(204);
