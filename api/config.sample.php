<?php
declare(strict_types=1);

return [
    'db_host' => 'localhost',
    'db_name' => 'CPANEL_USERNAME_mydailyedge',
    'db_user' => 'CPANEL_USERNAME_mydailyedge',
    'db_pass' => 'CHANGE_ME',
    'alpha_vantage_api_key' => '',
    'allow_registration' => true,
  'cron_secret' => '',  // optional: required only if you trigger api/cron/check-alerts.php via HTTP instead of cron CLI
  'mail_from_email' => 'alerts@mydailyedge.io',  // create this email account in cPanel before going live
  'mail_from_name'  => 'My DailyEdge Alerts',
  'mail_reply_to'   => 'alerts@mydailyedge.io',
  'app_url'         => 'https://mydailyedge.io',
  // Browser push notifications. Run api/cron/generate-vapid.php once and paste the output below.
  'vapid_public_key'  => '',
  'vapid_private_key' => '',
  'vapid_subject'     => 'mailto:lsenges.it@gmail.com',  // used to build deep links in email bodies  // optional: required only if you trigger api/cron/check-alerts.php via HTTP instead of cron CLI
    'session_name' => 'MYDAILYEDGESESSID',
];
