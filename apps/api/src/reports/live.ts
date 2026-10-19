import { getPool, type Row } from '../db/pool.js';
import { curveMetrics, tradeMetrics } from '../backtest/metrics.js';

export interface RoundTrip { symbol: string; qty: number; entryAt: string; entryPrice: number; exitAt: string; exitPrice: number; pnl: number }

/** FIFO round trips from filled orders (buy lots closed by later sells). Pure. */
export function roundTrips(fills: { symbol: string; side: 'buy' | 'sell'; qty: number; price: number; at: string }[]): RoundTrip[] {
  const lots: Record<string, { qty: number; price: number; at: string }[]> = {};
  const out: RoundTrip[] = [];
  for (const f of [...fills].sort((a, b) => a.at.localeCompare(b.at))) {
    const q = (lots[f.symbol] ??= []);
    if (f.side === 'buy') { q.push({ qty: f.qty, price: f.price, at: f.at }); continue; }
    let left = f.qty;
    while (left > 0 && q.length) {
      const lot = q[0];
      const take = Math.min(left, lot.qty);
      out.push({ symbol: f.symbol, qty: take, entryAt: lot.at, entryPrice: lot.price, exitAt: f.at, exitPrice: f.price, pnl: Math.round(take * (f.price - lot.price) * 100) / 100 });
      lot.qty -= take; left -= take;
      if (lot.qty <= 1e-9) q.shift();
    }
  }
  return out;
}

const PERIODS: Record<string, number | null> = { day: 1, week: 7, month: 31, all: null };

export async function liveReport(period: keyof typeof PERIODS, capitalBase: number) {
  const pool = getPool();
  const days = PERIODS[period];
  const since = days ? new Date(Date.now() - days * 864e5) : new Date(0);
  const [snaps] = await pool.query<Row[]>(
    "SELECT taken_at, equity, spy_close FROM account_snapshots WHERE source='alpaca' AND taken_at >= ? ORDER BY taken_at", [since],
  );
  const [fillRows] = await pool.query<Row[]>(
    "SELECT symbol, side, filled_qty, filled_avg_price, filled_at FROM orders WHERE source='alpaca' AND filled_qty > 0 AND filled_avg_price IS NOT NULL AND filled_at IS NOT NULL",
  );
  const trips = roundTrips(fillRows.map((r) => ({ symbol: r.symbol, side: r.side, qty: Number(r.filled_qty), price: Number(r.filled_avg_price), at: new Date(r.filled_at).toISOString() })))
    .filter((t) => new Date(t.exitAt) >= since);
  const eq = snaps.map((s) => Number(s.equity));
  const dates = snaps.map((s) => new Date(s.taken_at).toISOString());
  // daily series for Sharpe: last snapshot per day
  const byDay = new Map<string, { eq: number; spy: number | null }>();
  for (const s of snaps) byDay.set(new Date(s.taken_at).toISOString().slice(0, 10), { eq: Number(s.equity), spy: s.spy_close == null ? null : Number(s.spy_close) });
  const dEntries = [...byDay.entries()];
  const daily = curveMetrics(dEntries.map(([, v]) => v.eq), dEntries.map(([d]) => d));
  const spyVals = dEntries.map(([, v]) => v.spy).filter((x): x is number => x != null);
  const pnlUsd = eq.length ? Math.round((eq.at(-1)! - eq[0]) * 100) / 100 : 0;
  return {
    period, from: dates[0] ?? null, to: dates.at(-1) ?? null,
    netPnlUsd: pnlUsd,
    netPnlPctOfCapitalBase: Math.round((pnlUsd / capitalBase) * 10000) / 100,
    maxDrawdownUsd: daily.maxDrawdownUsd,
    sharpe: daily.sharpe, // null until ≥ 60 daily points
    benchmarkPct: spyVals.length >= 2 ? Math.round((spyVals.at(-1)! / spyVals[0] - 1) * 10000) / 100 : null,
    ...tradeMetrics(trips.map((t) => t.pnl)),
    trips: trips.slice(-100).reverse(),
    dataPoints: dEntries.length,
  };
}
