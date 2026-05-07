CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(190) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_admin TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY users_email_unique (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_state (
  user_id BIGINT UNSIGNED NOT NULL,
  state_json LONGTEXT NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT user_state_user_id_foreign
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS alerts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  symbol VARCHAR(20) NOT NULL,
  direction ENUM('above', 'below', 'pct_up', 'pct_down') NOT NULL,
  threshold DECIMAL(20,8) NOT NULL,
  baseline DECIMAL(20,8) DEFAULT NULL,
  note VARCHAR(500) DEFAULT NULL,
  status ENUM('active', 'paused', 'triggered', 'dismissed') NOT NULL DEFAULT 'active',
  triggered_at TIMESTAMP NULL DEFAULT NULL,
  triggered_price DECIMAL(20,8) DEFAULT NULL,
  acknowledged_at TIMESTAMP NULL DEFAULT NULL,
  notify_email TINYINT(1) NOT NULL DEFAULT 1,
  notify_push TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY alerts_user_status (user_id, status),
  KEY alerts_symbol_status (symbol, status),
  CONSTRAINT alerts_user_id_foreign
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  endpoint VARCHAR(500) NOT NULL,
  p256dh_key VARCHAR(255) NOT NULL,
  auth_key VARCHAR(64) NOT NULL,
  user_agent VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY push_endpoint_unique (endpoint),
  KEY push_user_id (user_id),
  CONSTRAINT push_subscriptions_user_id_foreign
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS snapshots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  snapshot_date DATE NOT NULL,
  portfolio_value DECIMAL(20,4) NOT NULL DEFAULT 0,
  portfolio_cost DECIMAL(20,4) NOT NULL DEFAULT 0,
  day_pnl DECIMAL(20,4) NOT NULL DEFAULT 0,
  day_pct DECIMAL(10,4) NOT NULL DEFAULT 0,
  total_gain DECIMAL(20,4) NOT NULL DEFAULT 0,
  total_gain_pct DECIMAL(10,4) NOT NULL DEFAULT 0,
  open_tasks INT UNSIGNED NOT NULL DEFAULT 0,
  due_tasks INT UNSIGNED NOT NULL DEFAULT 0,
  positions_json LONGTEXT NULL,
  report TEXT NULL,
  source ENUM('cron', 'manual') NOT NULL DEFAULT 'cron',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY snapshots_user_date (user_id, snapshot_date),
  CONSTRAINT snapshots_user_id_foreign
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS invitations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(190) NOT NULL,
  token CHAR(64) NOT NULL,
  invited_by BIGINT UNSIGNED NULL,
  invited_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  accepted_at TIMESTAMP NULL DEFAULT NULL,
  accepted_user_id BIGINT UNSIGNED NULL,
  revoked_at TIMESTAMP NULL DEFAULT NULL,
  note VARCHAR(500) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY invitations_token_unique (token),
  KEY invitations_email (email),
  KEY invitations_status (accepted_at, revoked_at, expires_at),
  CONSTRAINT invitations_invited_by_foreign
    FOREIGN KEY (invited_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT invitations_accepted_user_foreign
    FOREIGN KEY (accepted_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
