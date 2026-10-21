-- Allocation strategy (SPY + trend filter): fractional quantities + notional orders
ALTER TABLE positions MODIFY qty DECIMAL(20,9) NOT NULL;
ALTER TABLE trade_proposals MODIFY qty DECIMAL(20,9) NOT NULL;
ALTER TABLE fills MODIFY qty DECIMAL(20,9) NOT NULL;
ALTER TABLE orders
  MODIFY qty DECIMAL(20,9) NOT NULL,
  MODIFY filled_qty DECIMAL(20,9) NOT NULL DEFAULT 0,
  ADD COLUMN notional DECIMAL(14,2) NULL AFTER qty;
