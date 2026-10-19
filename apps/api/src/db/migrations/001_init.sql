-- VIBIT AI Trader — initial schema. All money in USD, DECIMAL (never FLOAT).

CREATE TABLE users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  role ENUM('admin','viewer') NOT NULL DEFAULT 'admin',
  failed_logins INT NOT NULL DEFAULT 0,
  locked_until DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sessions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  ip VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_sessions_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- API keys encrypted with AES-256-GCM; plaintext never stored or returned.
CREATE TABLE secrets (
  name VARCHAR(64) PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  masked VARCHAR(32) NOT NULL,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE settings (
  name VARCHAR(64) PRIMARY KEY,
  value JSON NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Single row (id=1). Worker forces mode=SAFE on every start.
CREATE TABLE bot_state (
  id TINYINT UNSIGNED PRIMARY KEY,
  mode ENUM('SAFE','ACTIVE','HALTED') NOT NULL DEFAULT 'SAFE',
  kill_switch TINYINT(1) NOT NULL DEFAULT 0,
  kill_reason VARCHAR(255) NULL,
  kill_at DATETIME NULL,
  worker_heartbeat_at DATETIME NULL,
  worker_started_at DATETIME NULL,
  worker_version VARCHAR(32) NULL,
  broker_status ENUM('not_configured','ok','error','unknown') NOT NULL DEFAULT 'not_configured',
  broker_checked_at DATETIME NULL,
  broker_message VARCHAR(255) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;
INSERT INTO bot_state (id, mode) VALUES (1, 'SAFE');

-- Versioned risk limits. Only humans change these (via API with audit). AI has no write path.
CREATE TABLE risk_limits (
  version INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  limits JSON NOT NULL,
  reason VARCHAR(255) NOT NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE account_snapshots (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  source ENUM('demo','alpaca') NOT NULL,
  taken_at DATETIME NOT NULL,
  equity DECIMAL(14,2) NOT NULL,
  cash DECIMAL(14,2) NOT NULL,
  buying_power DECIMAL(14,2) NOT NULL,
  long_market_value DECIMAL(14,2) NOT NULL DEFAULT 0,
  realized_pl DECIMAL(14,2) NOT NULL DEFAULT 0,
  unrealized_pl DECIMAL(14,2) NOT NULL DEFAULT 0,
  spy_close DECIMAL(12,4) NULL,
  UNIQUE KEY uq_snap (source, taken_at)
) ENGINE=InnoDB;

CREATE TABLE positions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  source ENUM('demo','alpaca') NOT NULL,
  symbol VARCHAR(16) NOT NULL,
  qty DECIMAL(18,6) NOT NULL,
  avg_entry_price DECIMAL(14,4) NOT NULL,
  current_price DECIMAL(14,4) NOT NULL,
  stop_price DECIMAL(14,4) NULL,
  opened_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pos (source, symbol)
) ENGINE=InnoDB;

CREATE TABLE trade_proposals (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  source ENUM('demo','engine') NOT NULL,
  symbol VARCHAR(16) NOT NULL,
  side ENUM('buy','sell') NOT NULL,
  qty DECIMAL(18,6) NOT NULL,
  price_ref DECIMAL(14,4) NOT NULL,
  stop_price DECIMAL(14,4) NULL,
  take_profit DECIMAL(14,4) NULL,
  rationale JSON NOT NULL,
  strategy_version VARCHAR(32) NOT NULL,
  data_hash CHAR(64) NULL,
  status ENUM('pending','approved','rejected','submitted','expired') NOT NULL DEFAULT 'pending',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_prop_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE risk_decisions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  proposal_id BIGINT UNSIGNED NULL,
  approved TINYINT(1) NOT NULL,
  checks JSON NOT NULL,
  limits_version INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_rd_prop FOREIGN KEY (proposal_id) REFERENCES trade_proposals(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE orders (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  source ENUM('demo','alpaca') NOT NULL,
  client_order_id VARCHAR(64) NOT NULL UNIQUE,  -- idempotency key
  alpaca_order_id VARCHAR(64) NULL UNIQUE,
  proposal_id BIGINT UNSIGNED NULL,
  symbol VARCHAR(16) NOT NULL,
  side ENUM('buy','sell') NOT NULL,
  type VARCHAR(16) NOT NULL,
  order_class VARCHAR(16) NULL,
  time_in_force VARCHAR(8) NOT NULL,
  qty DECIMAL(18,6) NOT NULL,
  filled_qty DECIMAL(18,6) NOT NULL DEFAULT 0,
  limit_price DECIMAL(14,4) NULL,
  stop_price DECIMAL(14,4) NULL,
  filled_avg_price DECIMAL(14,4) NULL,
  status VARCHAR(32) NOT NULL,
  est_fees DECIMAL(10,4) NOT NULL DEFAULT 0,
  reason VARCHAR(255) NULL,
  submitted_at DATETIME NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_orders_symbol (symbol)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE fills (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  broker_fill_id VARCHAR(64) NULL UNIQUE,
  qty DECIMAL(18,6) NOT NULL,
  price DECIMAL(14,4) NOT NULL,
  filled_at DATETIME NOT NULL,
  CONSTRAINT fk_fills_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE ai_analyses (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  kind VARCHAR(32) NOT NULL,
  model VARCHAR(64) NOT NULL,
  prompt_version VARCHAR(32) NOT NULL,
  input_hash CHAR(64) NOT NULL,
  input_json JSON NOT NULL,
  output_json JSON NULL,
  valid TINYINT(1) NOT NULL DEFAULT 0,
  input_tokens INT NULL,
  output_tokens INT NULL,
  cost_usd DECIMAL(10,5) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ai_hash (input_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor VARCHAR(64) NOT NULL,
  action VARCHAR(64) NOT NULL,
  details JSON NULL,
  ip VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
