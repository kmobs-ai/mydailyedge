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
$users = user_count();

respond([
    'ok' => true,
    'configured' => true,
    'authenticated' => $user !== null,
    'user' => $user,
    'registrationOpen' => $users === 0 || !empty($config['allow_registration']),
    'marketDataConfigured' => !empty($config['alpha_vantage_api_key']),
    'userCount' => $users,
]);
