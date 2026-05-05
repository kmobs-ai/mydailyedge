-- Price alerts: per-user, per-symbol thresholds with status tracking.
-- Run on existing installs:
--   mysql -u <user> -p <db_name> < database/migrations/0002_create_alerts.sql

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
