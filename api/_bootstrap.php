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

$config = config_exists() ? app_config() : [];
if ($config) {
    start_app_session($config);
}
