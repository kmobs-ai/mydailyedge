<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';

$body = read_json();
$action = (string) ($body['action'] ?? '');

if ($action === 'logout') {
    require_csrf();
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $params = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $params['path'], $params['domain'], $params['secure'], $params['httponly']);
    }
    session_destroy();
    respond(['ok' => true]);
}

$email = strtolower(trim((string) ($body['email'] ?? '')));
$password = (string) ($body['password'] ?? '');

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    respond(['ok' => false, 'error' => 'Enter a valid email address.'], 400);
}

if ($action === 'register') {
    rate_limit_guard('register', $email);

    $users = user_count();
    if ($users > 0 && empty($config['allow_registration'])) {
        respond(['ok' => false, 'error' => 'Registration is closed.'], 403);
    }

    if (strlen($password) < 10) {
        respond(['ok' => false, 'error' => 'Use a password with at least 10 characters.'], 400);
    }

    $stmt = db()->prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)');
    try {
        $stmt->execute([$email, password_hash($password, PASSWORD_DEFAULT)]);
    } catch (PDOException $error) {
        rate_limit_record('register', $email, false);
        respond(['ok' => false, 'error' => 'That email is already registered.'], 409);
    }

    rate_limit_record('register', $email, true);
    session_regenerate_id(true);
    unset($_SESSION['csrf_token']); // force a fresh token bound to the new session id
    $_SESSION['user_id'] = (int) db()->lastInsertId();
    respond(['ok' => true, 'user' => current_user(), 'csrfToken' => csrf_token()]);
}

if ($action === 'login') {
    rate_limit_guard('login', $email);

    $stmt = db()->prepare('SELECT id, email, password_hash FROM users WHERE email = ?');
    $stmt->execute([$email]);
    $user = $stmt->fetch();

    if (!$user || !password_verify($password, $user['password_hash'])) {
        rate_limit_record('login', $email, false);
        respond(['ok' => false, 'error' => 'Email or password is incorrect.'], 401);
    }

    rate_limit_record('login', $email, true);
    session_regenerate_id(true);
    unset($_SESSION['csrf_token']); // force a fresh token bound to the new session id
    $_SESSION['user_id'] = (int) $user['id'];
    respond(['ok' => true, 'user' => current_user(), 'csrfToken' => csrf_token()]);
}

respond(['ok' => false, 'error' => 'Unsupported auth action.'], 400);
