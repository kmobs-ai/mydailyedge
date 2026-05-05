-- Adds optimistic-concurrency version column to user_state.
-- Run this migration once on existing installs:
--   mysql -u <user> -p <db_name> < database/migrations/0001_add_user_state_version.sql

ALTER TABLE user_state
  ADD COLUMN IF NOT EXISTS version BIGINT UNSIGNED NOT NULL DEFAULT 0
  AFTER state_json;
