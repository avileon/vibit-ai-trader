import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { getPool, type Row } from '../db/pool.js';
import { estimateMarketSession } from '../lib/marketHours.js';
import { getSetting } from '../lib/settings.js';

const sourceQ = z.object({ source: z.enum(['demo', 'alpaca']).optional() });

async function resolveSource(requested?: 'demo' | 'alpaca'): Promise<'demo' | 'alpaca'> {
  if (requested) return requested;
  const [s] = await getPool().query<Row[]>('SELECT broker_status FROM bot_state WHERE id = 1');
  return s[0]?.broker_status === 'ok' ? 'alpaca' : 'demo';
}

const fmtIL = (d: Date) => new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);

/** Alpaca clock if checked in the last 10 minutes; otherwise the labelled estimate. */
function marketFromState(st: Row) {
  const est = estimateMarketSession();
  const fresh = st.clock_checked_at && Date.now() - new Date(st.clock_checked_at).getTime() < 10 * 60_000;
  if (!fresh || st.market_is_open == null) return est;
  const nextOpen = new Date(st.market_next_open), nextClose = new Date(st.market_next_close);
  // if the stored next_close has passed, the clock is stale for this purpose
  const isOpen = !!st.market_is_open && nextClose.getTime() > Date.now();
  return {
    ...est,
    isOpen,
    source: 'alpaca' as const,
    nextOpenIL: fmtIL(nextOpen),
    nextCloseIL: fmtIL(nextClose),
    note: 'לפי שעון Alpaca (כולל חגים וימים מקוצרים).',
  };
}

function workerAlive(hb: Date | null): boolean {
  return !!hb && Date.now() - new Date(hb).getTime() < 3 * 60_000;
}

export function registerDataRoutes(app: FastifyInstance) {
  app.get('/api/dashboard', { preHandler: requireAuth }, async (req, reply) => {
    const q = sourceQ.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_input' });
    const source = await resolveSource(q.data.source);
    const pool = getPool();
    const [snaps] = await pool.query<Row[]>(
      'SELECT taken_at, equity, cash, buying_power, long_market_value, realized_pl, unrealized_pl, spy_close FROM account_snapshots WHERE source = ? ORDER BY taken_at DESC LIMIT 260',
      [source],
    );
    const series = snaps.slice().reverse();
    const last = series.at(-1) ?? null;
    const prev = series.at(-2) ?? null;
    let monthStart = null as Row | null;
    if (last) {
      const m = new Date(last.taken_at).getUTCMonth();
      const before = series.filter((s) => new Date(s.taken_at).getUTCMonth() !== m);
      monthStart = before.at(-1) ?? series[0];
    }
    const [stateRows] = await pool.query<Row[]>('SELECT * FROM bot_state WHERE id = 1');
    const st = stateRows[0];
    const [posCount] = await pool.query<Row[]>('SELECT COUNT(*) c FROM positions WHERE source = ?', [source]);
    const ilsRate = await getSetting<number | null>('ils_rate', null);
    return {
      source,
      isDemo: source === 'demo',
      summary: last && {
        asOf: last.taken_at,
        equity: last.equity,
        cash: last.cash,
        buyingPower: last.buying_power,
        longMarketValue: last.long_market_value,
        realizedPl: last.realized_pl,
        unrealizedPl: last.unrealized_pl,
        dayPl: prev ? +(last.equity - prev.equity).toFixed(2) : null,
        monthPl: monthStart ? +(last.equity - monthStart.equity).toFixed(2) : null,
        openPositions: Number(posCount[0].c),
      },
      series: series.map((s) => ({ t: s.taken_at, equity: s.equity, spy: s.spy_close })),
      bot: {
        mode: st.mode,
        killSwitch: !!st.kill_switch,
        killReason: st.kill_reason,
        workerAlive: workerAlive(st.worker_heartbeat_at),
        workerHeartbeatAt: st.worker_heartbeat_at,
      },
      broker: { status: st.broker_status, checkedAt: st.broker_checked_at, message: st.broker_message },
      market: marketFromState(st),
      account: st.account_meta ? (typeof st.account_meta === 'string' ? JSON.parse(st.account_meta) : st.account_meta) : null,
      lastSyncAt: st.last_sync_at,
      ilsRate,
    };
  });

  app.get('/api/portfolio', { preHandler: requireAuth }, async (req, reply) => {
    const q = sourceQ.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_input' });
    const source = await resolveSource(q.data.source);
    const [rows] = await getPool().query<Row[]>('SELECT * FROM positions WHERE source = ? ORDER BY symbol', [source]);
    const [snap] = await getPool().query<Row[]>('SELECT equity FROM account_snapshots WHERE source = ? ORDER BY taken_at DESC LIMIT 1', [source]);
    const equity = snap[0]?.equity ?? 0;
    return {
      source, isDemo: source === 'demo', equity,
      positions: rows.map((p) => {
        const value = +(p.qty * p.current_price).toFixed(2);
        const pl = +((p.current_price - p.avg_entry_price) * p.qty).toFixed(2);
        const riskToStop = p.stop_price != null ? +((p.current_price - p.stop_price) * p.qty).toFixed(2) : null;
        return {
          symbol: p.symbol, qty: p.qty, avgEntry: p.avg_entry_price, current: p.current_price, stop: p.stop_price,
          value, pl, plPct: +((p.current_price / p.avg_entry_price - 1) * 100).toFixed(2),
          exposurePct: equity ? +((value / equity) * 100).toFixed(1) : null, riskToStop, openedAt: p.opened_at,
        };
      }),
    };
  });

  app.get('/api/orders', { preHandler: requireAuth }, async (req, reply) => {
    const q = sourceQ.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_input' });
    const source = await resolveSource(q.data.source);
    const [rows] = await getPool().query<Row[]>(
      'SELECT client_order_id, alpaca_order_id, symbol, side, type, order_class, time_in_force, qty, filled_qty, limit_price, stop_price, filled_avg_price, status, est_fees, reason, submitted_at FROM orders WHERE source = ? ORDER BY submitted_at DESC LIMIT 200',
      [source],
    );
    return { source, isDemo: source === 'demo', orders: rows };
  });
}
