-- Daily portfolio snapshots: one row per user per day.
-- Run on existing installs:
--   mysql -u <user> -p <db_name> < database/migrations/0004_create_snapshots.sql

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
