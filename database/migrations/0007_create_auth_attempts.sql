-- 0007_create_auth_attempts.sql
-- Brute-force protection for the login / register endpoints.
--
-- Every login and register attempt records one row here. api/auth.php counts
-- recent failed rows (successful = 0) inside a trailing 15-minute window and
-- rejects with HTTP 429 once a per-IP or per-email ceiling is hit. A successful
-- auth clears that account's failed rows so an ordinary typo streak never
-- locks the real user out.
--
-- Run once in phpMyAdmin against the app database, the same way schema.sql was
-- applied. Until this table exists the rate limiter fails OPEN (auth still
-- works, just unthrottled) — so deploying the code before running this is safe.

CREATE TABLE IF NOT EXISTS auth_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ip_address VARCHAR(45) NOT NULL,
  email VARCHAR(190) NOT NULL DEFAULT '',
  action VARCHAR(20) NOT NULL,
  successful TINYINT(1) NOT NULL DEFAULT 0,
  attempted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY auth_attempts_ip_time (ip_address, successful, attempted_at),
  KEY auth_attempts_email_time (email, successful, attempted_at),
  KEY auth_attempts_cleanup (attempted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
