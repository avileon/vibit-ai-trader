import { fileURLToPath } from 'node:url';
import { getPool, closePool } from './pool.js';

/**
 * נתוני DEMO בלבד — סמלים בדויים (DEMO-A וכו') ומחירים מומצאים.
 * הכל נשמר עם source='demo' ומוצג בממשק עם תג DEMO. אין כאן שום נתון שוק אמיתי.
 */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function seedDemo(): Promise<{ snapshots: number }> {
  const pool = getPool();
  const rnd = mulberry32(42);
  await pool.query("DELETE FROM account_snapshots WHERE source='demo'");
  await pool.query("DELETE FROM positions WHERE source='demo'");
  await pool.query("DELETE FROM orders WHERE source='demo'");
  await pool.query("DELETE FROM trade_proposals WHERE source='demo'");

  // 60 weekdays back from today
  const days: Date[] = [];
  const d = new Date(); d.setUTCHours(20, 0, 0, 0);
  while (days.length < 60) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) days.unshift(new Date(d));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  let equity = 1000, bench = 100, realized = 0;
  const rows: unknown[][] = [];
  for (const day of days) {
    const r = (rnd() - 0.48) * 0.012;
    equity = +(equity * (1 + r)).toFixed(2);
    bench = +(bench * (1 + (rnd() - 0.47) * 0.01)).toFixed(4);
    if (rnd() < 0.15) realized = +(realized + (rnd() - 0.45) * 12).toFixed(2);
    const lmv = +(equity * 0.42).toFixed(2);
    rows.push(['demo', day, equity, +(equity - lmv).toFixed(2), +(equity - lmv).toFixed(2), lmv, realized,
      +(equity - 1000 - realized).toFixed(2), bench]);
  }
  await pool.query(
    `INSERT INTO account_snapshots (source, taken_at, equity, cash, buying_power, long_market_value, realized_pl, unrealized_pl, spy_close) VALUES ?`,
    [rows],
  );

  const now = new Date();
  await pool.query(
    `INSERT INTO positions (source, symbol, qty, avg_entry_price, current_price, stop_price, opened_at) VALUES ?`,
    [[
      ['demo', 'DEMO-A', 4, 42.1, 43.35, 39.6, new Date(now.getTime() - 6 * 864e5)],
      ['demo', 'DEMO-B', 3, 61.0, 59.8, 57.7, new Date(now.getTime() - 2 * 864e5)],
    ]],
  );
  await pool.query(
    `INSERT INTO orders (source, client_order_id, symbol, side, type, order_class, time_in_force, qty, filled_qty, limit_price, stop_price, filled_avg_price, status, est_fees, reason, submitted_at) VALUES ?`,
    [[
      ['demo', 'demo-0001', 'DEMO-A', 'buy', 'limit', 'bracket', 'gtc', 4, 4, 42.2, 39.6, 42.1, 'filled', 0.01, 'DEMO: דוגמה לכניסת Momentum', new Date(now.getTime() - 6 * 864e5)],
      ['demo', 'demo-0002', 'DEMO-B', 'buy', 'limit', 'bracket', 'gtc', 3, 3, 61.1, 57.7, 61.0, 'filled', 0.01, 'DEMO: דוגמה לכניסת Momentum', new Date(now.getTime() - 2 * 864e5)],
      ['demo', 'demo-0003', 'DEMO-C', 'buy', 'limit', 'bracket', 'gtc', 2, 0, 88.0, 83.5, null, 'canceled', 0, 'DEMO: בוטל — המחיר ברח מעל טווח הכניסה', new Date(now.getTime() - 1 * 864e5)],
    ]],
  );
  return { snapshots: rows.length };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  seedDemo()
    .then((r) => console.log(`Demo data seeded (${r.snapshots} snapshots). All rows marked source='demo'.`))
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => closePool());
}
