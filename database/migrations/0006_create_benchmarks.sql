-- Benchmark price history (SPY, BTC, etc.) for performance comparison.
--   mysql -u <user> -p <db_name> < database/migrations/0006_create_benchmarks.sql

CREATE TABLE IF NOT EXISTS benchmarks (
  symbol VARCHAR(20) NOT NULL,
  snapshot_date DATE NOT NULL,
  close DECIMAL(20,8) NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol, snapshot_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
