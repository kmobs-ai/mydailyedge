<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';

if (!config_exists()) {
    respond([
        'ok' => true,
        'configured' => false,
        'authenticated' => false,
        'registrationOpen' => false,
    ]);
}

$user = current_user();
$isAdmin = false;
if ($user) {
    $stmt = db()->prepare('SELECT is_admin FROM users WHERE id = ?');
    $stmt->execute([(int) $user['id']]);
    $row = $stmt->fetch();
    $isAdmin = !empty($row['is_admin']);
}
$users = user_count();

respond([
    'ok' => true,
    'configured' => true,
    'authenticated' => $user !== null,
    'user' => $user,
    'registrationOpen' => $users === 0 || !empty($config['allow_registration']),
    'marketDataConfigured' => true,
    'marketDataProvider' => !empty($config['alpha_vantage_api_key']) ? 'Yahoo + Alpha Vantage' : 'Yahoo Finance',
    'newsDataConfigured' => !empty($config['alpha_vantage_api_key']),
    'userCount' => $users,
    'csrfToken' => csrf_token(),
    'isAdmin' => $isAdmin,
]);
