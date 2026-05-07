-- Beta invitations + admin column.
--   mysql -u <user> -p <db_name> < database/migrations/0005_create_invitations.sql

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_admin TINYINT(1) NOT NULL DEFAULT 0
  AFTER password_hash;

-- The first registered user becomes admin (this seeds you as admin)
UPDATE users SET is_admin = 1 WHERE id = (SELECT id FROM (SELECT MIN(id) AS id FROM users) AS first);

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
