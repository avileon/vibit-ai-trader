-- Phase D: engine bookkeeping
ALTER TABLE trade_proposals
  ADD COLUMN kind ENUM('entry','exit') NOT NULL DEFAULT 'entry',
  ADD COLUMN client_order_id VARCHAR(64) NULL,
  ADD COLUMN final_order JSON NULL;
ALTER TABLE bot_state
  ADD COLUMN engine_last_run_at DATETIME NULL,
  ADD COLUMN engine_last_run_day DATE NULL,
  ADD COLUMN engine_message VARCHAR(255) NULL;
