import { getPool, type Row } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { getSetting, setSetting } from '../lib/settings.js';
import { BrokerError, type AlpacaOrder, type BrokerReader } from './alpacaClient.js';

/**
 * Mirrors the Alpaca PAPER account into MySQL (source='alpaca'). Read-only toward the broker.
 * Reconciliation: positions not returned by Alpaca are deleted locally; orders are upserted by alpaca id.
 */
export interface SyncResult {
  ok: boolean;
  error?: string;
  account?: { status: string; equity: number; cash: number; buyingPower: number; pdt?: boolean; daytradeCount?: number; multiplier?: number };
  clock?: { isOpen: boolean; nextOpen: string; nextClose: string };
  positions?: number;
  orders?: number;
  backfilled?: number;
}

const SNAP_BUCKET_MIN = 15;

function toDate(s?: string | null): Date | null {
  return s ? new Date(s) : null;
}
function bucket(d: Date, minutes = SNAP_BUCKET_MIN): Date {
  const ms = minutes * 60_000;
  return new Date(Math.floor(d.getTime() / ms) * ms);
}

/** Flattens nested bracket/OTO legs so each leg is its own row. */
export function flattenOrders(orders: AlpacaOrder[]): AlpacaOrder[] {
  const out: AlpacaOrder[] = [];
  for (const o of orders) {
    out.push(o);
    for (const leg of o.legs ?? []) out.push(leg);
  }
  return out;
}

async function spyCloseFor(client: BrokerReader): Promise<Map<string, number>> {
  const cached = await getSetting<{ day: string; closes: Record<string, number> } | null>('spy_closes', null);
  const today = new Date().toISOString().slice(0, 10);
  if (cached?.day === today) return new Map(Object.entries(cached.closes));
  const start = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  const bars = await client.getDailyBars('SPY', start);
  const closes: Record<string, number> = {};
  for (const b of bars) closes[b.t.slice(0, 10)] = b.c;
  await setSetting('spy_closes', { day: today, closes });
  return new Map(Object.entries(closes));
}

function lastCloseOnOrBefore(m: Map<string, number>, day: string): number | null {
  let best: string | null = null;
  for (const k of m.keys()) if (k <= day && (!best || k > best)) best = k;
  return best ? m.get(best)! : null;
}

export async function syncBroker(client: BrokerReader, now = new Date()): Promise<SyncResult> {
  const pool = getPool();
  try {
    const acct = await client.getAccount(); // throws not_paper if not PA…
    const clock = await client.getClock();
    const positions = await client.getPositions();
    const orders = flattenOrders(await client.getOrders({ after: new Date(now.getTime() - 60 * 864e5).toISOString() }));

    // baseline for realized P&L (first equity we ever saw, or portfolio-history base)
    let baseEquity = await getSetting<number | null>('alpaca_base_equity', null);
    let backfilled = 0;
    if (baseEquity == null) {
      const hist = await client.getPortfolioHistory('3M', '1D').catch(() => null);
      baseEquity = hist?.base_value ?? acct.last_equity ?? acct.equity;
      await setSetting('alpaca_base_equity', baseEquity);
      if (hist) {
        const spy = await spyCloseFor(client).catch(() => new Map<string, number>());
        const rows: unknown[][] = [];
        hist.timestamp.forEach((ts, i) => {
          const eq = hist.equity[i];
          if (eq == null || eq === 0) return;
          const d = new Date(ts * 1000);
          rows.push(['alpaca', d, eq, eq, eq, 0, 0, 0, lastCloseOnOrBefore(spy, d.toISOString().slice(0, 10))]);
        });
        if (rows.length) {
          await pool.query(
            `INSERT IGNORE INTO account_snapshots (source, taken_at, equity, cash, buying_power, long_market_value, realized_pl, unrealized_pl, spy_close) VALUES ?`,
            [rows],
          );
          backfilled = rows.length;
        }
      }
    }

    // snapshot (one per 15-minute bucket, last write wins)
    const unrealized = positions.reduce((s, p) => s + p.unrealized_pl, 0);
    const realized = +(acct.equity - baseEquity - unrealized).toFixed(2);
    const spy = await spyCloseFor(client).catch(() => new Map<string, number>());
    await pool.query(
      `INSERT INTO account_snapshots (source, taken_at, equity, cash, buying_power, long_market_value, realized_pl, unrealized_pl, spy_close)
       VALUES ('alpaca', ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE equity=VALUES(equity), cash=VALUES(cash), buying_power=VALUES(buying_power),
         long_market_value=VALUES(long_market_value), realized_pl=VALUES(realized_pl), unrealized_pl=VALUES(unrealized_pl), spy_close=VALUES(spy_close)`,
      [bucket(now), acct.equity, acct.cash, acct.buying_power, acct.long_market_value ?? 0, realized, +unrealized.toFixed(2),
        lastCloseOnOrBefore(spy, now.toISOString().slice(0, 10))],
    );

    // positions reconcile
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const symbols = positions.map((p) => p.symbol);
      if (symbols.length) {
        await conn.query("DELETE FROM positions WHERE source='alpaca' AND symbol NOT IN (?)", [symbols]);
      } else {
        await conn.query("DELETE FROM positions WHERE source='alpaca'");
      }
      for (const p of positions) {
        // stop = the open stop-loss leg/order for this symbol, if any
        const stop = orders.find((o) => o.symbol === p.symbol && o.side === 'sell' && o.stop_price != null &&
          ['new', 'accepted', 'held', 'pending_new', 'partially_filled'].includes(o.status))?.stop_price ?? null;
        const [existing] = await conn.query<Row[]>("SELECT opened_at FROM positions WHERE source='alpaca' AND symbol=?", [p.symbol]);
        const opened = existing[0]?.opened_at ??
          toDate(orders.filter((o) => o.symbol === p.symbol && o.side === 'buy' && o.filled_at).map((o) => o.filled_at!).sort().at(-1)) ?? now;
        await conn.query(
          `INSERT INTO positions (source, symbol, qty, avg_entry_price, current_price, stop_price, opened_at, market_value, unrealized_pl)
           VALUES ('alpaca', ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE qty=VALUES(qty), avg_entry_price=VALUES(avg_entry_price), current_price=VALUES(current_price),
             stop_price=VALUES(stop_price), market_value=VALUES(market_value), unrealized_pl=VALUES(unrealized_pl)`,
          [p.symbol, p.qty, p.avg_entry_price, p.current_price, stop, opened, p.market_value, p.unrealized_pl],
        );
      }

      for (const o of orders) {
        await conn.query(
          `INSERT INTO orders (source, client_order_id, alpaca_order_id, symbol, side, type, order_class, time_in_force, qty, filled_qty,
             limit_price, stop_price, filled_avg_price, status, submitted_at, filled_at, canceled_at, legs, reason)
           VALUES ('alpaca', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE qty=IF(VALUES(qty) > 0, VALUES(qty), qty), filled_qty=VALUES(filled_qty), filled_avg_price=VALUES(filled_avg_price), status=VALUES(status),
             filled_at=VALUES(filled_at), canceled_at=VALUES(canceled_at), limit_price=VALUES(limit_price), stop_price=VALUES(stop_price)`,
          [o.client_order_id, o.id, o.symbol, o.side, o.type ?? o.order_type ?? 'unknown', o.order_class || null, o.time_in_force,
            o.qty ?? 0, o.filled_qty, o.limit_price ?? null, o.stop_price ?? null, o.filled_avg_price ?? null, o.status,
            toDate(o.submitted_at ?? o.created_at), toDate(o.filled_at), toDate(o.canceled_at),
            o.legs?.length ? JSON.stringify(o.legs.map((l) => l.id)) : null,
            o.client_order_id.startsWith('vibit-') ? null : 'נוצרה מחוץ למערכת (ידנית ב-Alpaca)'],
        );
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    const meta = {
      status: acct.status, accountPrefix: acct.account_number.slice(0, 2), pdt: acct.pattern_day_trader ?? null,
      daytradeCount: acct.daytrade_count ?? null, multiplier: acct.multiplier ?? null, shortingEnabled: acct.shorting_enabled ?? null,
      tradingBlocked: acct.trading_blocked ?? null, accountBlocked: acct.account_blocked ?? null, equity: acct.equity,
      lastEquity: acct.last_equity, cash: acct.cash, baseEquity,
    };
    const healthy = acct.status === 'ACTIVE' && !acct.trading_blocked && !acct.account_blocked;
    await pool.query(
      `UPDATE bot_state SET broker_status=?, broker_checked_at=?, broker_message=?, market_is_open=?, market_next_open=?,
         market_next_close=?, clock_checked_at=?, account_meta=?, last_sync_at=?, sync_error=NULL WHERE id=1`,
      [healthy ? 'ok' : 'error', now, healthy ? 'Paper account active' : `Account status ${acct.status}${acct.trading_blocked ? ', trading blocked' : ''}`,
        clock.is_open ? 1 : 0, new Date(clock.next_open), new Date(clock.next_close), now, JSON.stringify(meta), now],
    );
    return {
      ok: healthy,
      account: { status: acct.status, equity: acct.equity, cash: acct.cash, buyingPower: acct.buying_power, pdt: acct.pattern_day_trader, daytradeCount: acct.daytrade_count, multiplier: acct.multiplier },
      clock: { isOpen: clock.is_open, nextOpen: clock.next_open, nextClose: clock.next_close },
      positions: positions.length, orders: orders.length, backfilled,
    };
  } catch (e) {
    const msg = e instanceof BrokerError ? `${e.kind}: ${e.message}` : `internal: ${(e as Error).message}`;
    await pool.query(
      "UPDATE bot_state SET broker_status='error', broker_checked_at=UTC_TIMESTAMP(), broker_message=?, sync_error=? WHERE id=1",
      [msg.slice(0, 255), msg.slice(0, 255)],
    );
    if (e instanceof BrokerError && (e.kind === 'not_paper' || e.kind === 'auth')) {
      await audit('worker', 'broker.rejected', { kind: e.kind });
    }
    return { ok: false, error: msg };
  }
}

export async function markBrokerNotConfigured() {
  await getPool().query(
    "UPDATE bot_state SET broker_status='not_configured', broker_message='Alpaca keys not set', broker_checked_at=UTC_TIMESTAMP() WHERE id=1",
  );
}
