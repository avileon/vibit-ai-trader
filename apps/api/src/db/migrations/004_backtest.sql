-- Phase F: historical bar cache + backtest runs
CREATE TABLE bars_daily (
  symbol VARCHAR(16) NOT NULL,
  d DATE NOT NULL,
  o DECIMAL(14,4) NOT NULL,
  h DECIMAL(14,4) NOT NULL,
  l DECIMAL(14,4) NOT NULL,
  c DECIMAL(14,4) NOT NULL,
  v BIGINT NOT NULL,
  feed VARCHAR(8) NOT NULL,
  PRIMARY KEY (symbol, d)
) ENGINE=InnoDB;

CREATE TABLE backtest_runs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  status ENUM('queued','running','done','error') NOT NULL DEFAULT 'queued',
  config JSON NOT NULL,
  result LONGTEXT NULL,
  progress VARCHAR(255) NULL,
  error VARCHAR(500) NULL,
  created_by VARCHAR(190) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
