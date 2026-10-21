import { getPool, type Row } from '../db/pool.js';
import { currentLimits } from '../routes/control.js';
import type { RiskLimits } from '../riskConfig.js';

export const OPEN_STATUSES = ['new', 'accepted', 'pending_new', 'partially_filled', 'held', 'accepted_for_bidding', 'pending_replace', 'calculated', 'pending_submit'];

export interface EngineState {
  mode: 'SAFE' | 'ACTIVE' | 'HALTED';
  killSwitch: boolean;
  brokerStatus: string;
  lastSyncAt: Date | null;
  clock: { isOpen: boolean; nextClose: Date } | null;
  account: { equity: number; lastEquity: number; cash: number; baseEquity: number } | null;
  engineLastRunDay: string | null;
}

export async function loadEngineState(): Promise<EngineState> {
  const [rows] = await getPool().query<Row[]>('SELECT * FROM bot_state WHERE id = 1');
  const r = rows[0];
  const meta = r.account_meta ? (typeof r.account_meta === 'string' ? JSON.parse(r.account_meta) : r.account_meta) : null;
  return {
    mode: r.mode, killSwitch: !!r.kill_switch, brokerStatus: r.broker_status,
    lastSyncAt: r.last_sync_at ? new Date(r.last_sync_at) : null,
    clock: r.market_is_open == null ? null : { isOpen: !!r.market_is_open, nextClose: new Date(r.market_next_close) },
    account: meta && meta.equity != null && meta.baseEquity != null
      ? { equity: Number(meta.equity), lastEquity: Number(meta.lastEquity ?? meta.equity), cash: Number(meta.cash ?? 0), baseEquity: Number(meta.baseEquity) }
      : null,
    engineLastRunDay: r.engine_last_run_day ? new Date(r.engine_last_run_day).toISOString().slice(0, 10) : null,
  };
}

export async function loadPositions() {
  const [rows] = await getPool().query<Row[]>("SELECT symbol, qty, avg_entry_price, current_price, market_value, opened_at FROM positions WHERE source='alpaca'");
  return rows.map((p) => ({
    symbol: p.symbol as string, qty: Number(p.qty), avgEntry: Number(p.avg_entry_price),
    marketValue: Number(p.market_value ?? p.qty * p.current_price), openedAt: new Date(p.opened_at),
  }));
}

export function orderKind(clientOrderId: string): 'entry' | 'exit' | 'other' {
  if (clientOrderId.startsWith('vibit-entry-') && !/-(tp|sl)$/.test(clientOrderId)) return 'entry';
  if (clientOrderId.startsWith('vibit-exit-')) return 'exit';
  return 'other';
}

export async function loadOpenOrders() {
  const [rows] = await getPool().query<Row[]>(
    "SELECT client_order_id, alpaca_order_id, symbol, side, qty, notional, filled_qty, limit_price, status, submitted_at FROM orders WHERE source='alpaca' AND status IN (?)",
    [OPEN_STATUSES],
  );
  return rows.map((o) => ({
    clientOrderId: o.client_order_id as string, alpacaId: o.alpaca_order_id as string | null, symbol: o.symbol as string,
    side: o.side as 'buy' | 'sell', qty: Number(o.qty), filledQty: Number(o.filled_qty), status: o.status as string,
    notional: o.notional != null && Number(o.filled_qty) === 0 ? Number(o.notional) : Number(o.limit_price ?? 0) * (Number(o.qty) - Number(o.filled_qty)),
    submittedAt: o.submitted_at ? new Date(o.submitted_at) : null, kind: orderKind(o.client_order_id),
  }));
}

export async function limitsWithVersion(): Promise<{ version: number; limits: RiskLimits }> {
  const l = await currentLimits();
  return { version: l.version, limits: l.limits };
}

export function virtualEquity(limits: RiskLimits, acct: { equity: number; baseEquity: number }): number {
  return +(limits.capitalBaseUsd + (acct.equity - acct.baseEquity)).toFixed(2);
}
