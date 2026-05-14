<?php
declare(strict_types=1);

$configPath = __DIR__ . '/config.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function respond(array $payload, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
    exit;
}

function read_json(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return [];
    }

    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        respond(['ok' => false, 'error' => 'Invalid JSON body.'], 400);
    }

    return $decoded;
}

function config_exists(): bool
{
    global $configPath;
    return is_file($configPath);
}

function app_config(): array
{
    global $configPath;
    if (!config_exists()) {
        respond(['ok' => false, 'configured' => false, 'error' => 'Missing api/config.php.'], 503);
    }

    $config = require $configPath;
    if (!is_array($config)) {
        respond(['ok' => false, 'configured' => false, 'error' => 'Invalid api/config.php.'], 500);
    }

    return $config;
}

function start_app_session(array $config): void
{
    $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
    session_name($config['session_name'] ?? 'MYDAILYEDGESESSID');
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'domain' => '',
        'secure' => $secure,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
}

/**
 * Returns this session's CSRF token, generating one on first use.
 * The token rotates whenever the session id rotates (e.g. on login).
 */
function csrf_token(): string
{
    if (empty($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }
    return (string) $_SESSION['csrf_token'];
}

/**
 * Validates the X-CSRF-Token header against the session token.
 * Call before any mutating action that already has an authenticated session.
 * Login and register endpoints are intentionally exempt — those are how a
 * client bootstraps a session in the first place.
 */
function require_csrf(): void
{
    $expected = $_SESSION['csrf_token'] ?? '';
    $provided = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    if ($expected === '' || !hash_equals((string) $expected, (string) $provided)) {
        respond(['ok' => false, 'error' => 'CSRF token missing or invalid. Reload the page and try again.'], 403);
    }
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $config = app_config();
    $dsn = sprintf(
        'mysql:host=%s;dbname=%s;charset=utf8mb4',
        $config['db_host'],
        $config['db_name']
    );

    try {
        $pdo = new PDO($dsn, $config['db_user'], $config['db_pass'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
    } catch (PDOException $error) {
        respond(['ok' => false, 'configured' => true, 'error' => 'Database connection failed.'], 500);
    }

    return $pdo;
}

function user_count(): int
{
    try {
        return (int) db()->query('SELECT COUNT(*) FROM users')->fetchColumn();
    } catch (PDOException $error) {
        respond(['ok' => false, 'configured' => true, 'error' => 'Database tables are not installed.'], 500);
    }
}

function current_user(): ?array
{
    if (empty($_SESSION['user_id'])) {
        return null;
    }

    $stmt = db()->prepare('SELECT id, email, created_at FROM users WHERE id = ?');
    $stmt->execute([(int) $_SESSION['user_id']]);
    $user = $stmt->fetch();

    return $user ?: null;
}

function require_user(): array
{
    $user = current_user();
    if (!$user) {
        respond(['ok' => false, 'error' => 'Authentication required.'], 401);
    }

    return $user;
}

/**
 * Best-effort client IP. Uses REMOTE_ADDR only — X-Forwarded-For and similar
 * headers are client-spoofable, and trusting them would let an attacker bypass
 * the rate limiter by rotating the header. On cPanel/Apache, REMOTE_ADDR is the
 * real client address.
 */
function client_ip(): string
{
    $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    return $ip !== '' ? substr($ip, 0, 45) : '0.0.0.0';
}

// Brute-force ceilings for login/register, evaluated over a trailing window.
const RATE_LIMIT_WINDOW_SECONDS = 900; // 15 minutes
const RATE_LIMIT_MAX_PER_IP     = 15;  // failed attempts from one IP
const RATE_LIMIT_MAX_PER_EMAIL  = 8;   // failed attempts against one account

/**
 * Throttle login/register. Counts failed attempts (successful = 0) in the
 * trailing RATE_LIMIT_WINDOW_SECONDS against two independent ceilings:
 *   - per IP    — blunt: stops one host hammering many accounts
 *   - per email — sharp: stops a botnet hammering one account
 * Exceeding either responds 429 and exits. Call this BEFORE verifying the
 * password so a locked-out attacker never reaches password_verify().
 *
 * Fails OPEN: if the auth_attempts table is missing (migration 0007 not yet
 * run) or the DB hiccups, auth proceeds unthrottled rather than locking out
 * the only user.
 */
function rate_limit_guard(string $action, string $email): void
{
    // Window length is a compile-time constant, never user input — safe to
    // interpolate so all time math stays server-side and consistent with the
    // CURRENT_TIMESTAMP that attempted_at is written with.
    $window = RATE_LIMIT_WINDOW_SECONDS;

    try {
        // Opportunistic cleanup — ~2% of calls prune rows older than 24h so the
        // table never grows unbounded without needing its own cron.
        if (random_int(1, 50) === 1) {
            db()->query('DELETE FROM auth_attempts WHERE attempted_at < (NOW() - INTERVAL 24 HOUR)');
        }

        $ipStmt = db()->prepare(
            "SELECT COUNT(*) FROM auth_attempts
             WHERE ip_address = ? AND successful = 0
               AND attempted_at > (NOW() - INTERVAL $window SECOND)"
        );
        $ipStmt->execute([client_ip()]);
        if ((int) $ipStmt->fetchColumn() >= RATE_LIMIT_MAX_PER_IP) {
            respond(['ok' => false, 'error' => 'Too many attempts from your network. Please wait 15 minutes and try again.'], 429);
        }

        if ($email !== '') {
            $emailStmt = db()->prepare(
                "SELECT COUNT(*) FROM auth_attempts
                 WHERE email = ? AND successful = 0
                   AND attempted_at > (NOW() - INTERVAL $window SECOND)"
            );
            $emailStmt->execute([$email]);
            if ((int) $emailStmt->fetchColumn() >= RATE_LIMIT_MAX_PER_EMAIL) {
                respond(['ok' => false, 'error' => 'Too many sign-in attempts for this account. Please wait 15 minutes and try again.'], 429);
            }
        }
    } catch (PDOException $error) {
        return; // fail open
    }
}

/**
 * Record one auth attempt. On a successful auth, also clears that account's
 * prior failed rows so a legitimate user who fat-fingered their password a few
 * times isn't left locked out the moment they finally get in.
 * Best-effort: swallows DB errors so recording never breaks the auth flow.
 */
function rate_limit_record(string $action, string $email, bool $successful): void
{
    try {
        if ($successful && $email !== '') {
            $clear = db()->prepare('DELETE FROM auth_attempts WHERE successful = 0 AND email = ?');
            $clear->execute([$email]);
        }
        $insert = db()->prepare(
            'INSERT INTO auth_attempts (ip_address, email, action, successful) VALUES (?, ?, ?, ?)'
        );
        $insert->execute([client_ip(), $email, $action, $successful ? 1 : 0]);
    } catch (PDOException $error) {
        return; // best-effort
    }
}

$config = config_exists() ? app_config() : [];
if ($config) {
    start_app_session($config);
}
