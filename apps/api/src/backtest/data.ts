import { getPool, type Row } from '../db/pool.js';
import type { BrokerTrader } from '../broker/alpacaClient.js';
import type { DailyBar } from '../strategy/indicators.js';

/**
 * Historical daily bars, cached in MySQL. Source: Alpaca SIP (consolidated, all exchanges), split+dividend adjusted.
 * The free plan allows SIP history except the most recent 15 minutes — we only ever request up to yesterday.
 */
export async function ensureBars(broker: BrokerTrader, symbols: string[], from: string, to: string, onProgress?: (s: string) => void) {
  const pool = getPool();
  const need: string[] = [];
  for (const s of symbols) {
    const [r] = await pool.query<Row[]>('SELECT MIN(d) mn, MAX(d) mx FROM bars_daily WHERE symbol=?', [s]);
    const mn = r[0].mn ? new Date(r[0].mn).toISOString().slice(0, 10) : null;
    const mx = r[0].mx ? new Date(r[0].mx).toISOString().slice(0, 10) : null;
    // refetch when cache is missing, starts too late, or is >4 days behind `to`
    if (!mn || mn > addDays(from, 7) || !mx || mx < addDays(to, -4)) need.push(s);
  }
  for (let i = 0; i < need.length; i += 10) {
    const chunk = need.slice(i, i + 10);
    onProgress?.(`טוען נתונים היסטוריים: ${chunk.join(', ')}`);
    const bars = await broker.getBarsMulti(chunk, from, { end: to, feed: 'sip' });
    const rows: unknown[][] = [];
    for (const [sym, arr] of Object.entries(bars)) for (const b of arr) rows.push([sym, b.t.slice(0, 10), b.o, b.h, b.l, b.c, Math.round(b.v), 'sip']);
    for (let k = 0; k < rows.length; k += 2000) {
      await pool.query(
        'INSERT INTO bars_daily (symbol, d, o, h, l, c, v, feed) VALUES ? ON DUPLICATE KEY UPDATE o=VALUES(o), h=VALUES(h), l=VALUES(l), c=VALUES(c), v=VALUES(v), feed=VALUES(feed)',
        [rows.slice(k, k + 2000)],
      );
    }
  }
}

export async function loadBars(symbols: string[], from: string, to: string): Promise<Record<string, DailyBar[]>> {
  const [rows] = await getPool().query<Row[]>(
    'SELECT symbol, d, o, h, l, c, v FROM bars_daily WHERE symbol IN (?) AND d BETWEEN ? AND ? ORDER BY symbol, d',
    [symbols, from, to],
  );
  const out: Record<string, DailyBar[]> = {};
  for (const r of rows) {
    (out[r.symbol] ??= []).push({ t: `${new Date(r.d).toISOString().slice(0, 10)}T04:00:00Z`, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) });
  }
  return out;
}

export function addDays(d: string, n: number): string {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
