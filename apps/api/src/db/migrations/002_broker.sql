-- Phase C: broker sync state
ALTER TABLE bot_state
  ADD COLUMN market_is_open TINYINT(1) NULL,
  ADD COLUMN market_next_open DATETIME NULL,
  ADD COLUMN market_next_close DATETIME NULL,
  ADD COLUMN clock_checked_at DATETIME NULL,
  ADD COLUMN account_meta JSON NULL,
  ADD COLUMN last_sync_at DATETIME NULL,
  ADD COLUMN sync_error VARCHAR(255) NULL;

ALTER TABLE positions
  ADD COLUMN market_value DECIMAL(14,2) NULL,
  ADD COLUMN unrealized_pl DECIMAL(14,2) NULL;

ALTER TABLE orders
  ADD COLUMN filled_at DATETIME NULL,
  ADD COLUMN canceled_at DATETIME NULL,
  ADD COLUMN legs JSON NULL;
