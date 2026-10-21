import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { DEFAULT_RISK_LIMITS } from '../riskConfig.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Simple forward-only migration runner. Each file runs once, recorded in schema_migrations. */
export async function migrate(databaseUrl = process.env.DATABASE_URL!): Promise<string[]> {
  const conn = await mysql.createConnection({ uri: databaseUrl, multipleStatements: true });
  const applied: string[] = [];
  try {
    await conn.query("SET time_zone = '+00:00'");
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(190) PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name as string));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(join(dir, f), 'utf8');
      await conn.query(sql);
      await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [f]);
      applied.push(f);
    }
    // ensure an initial risk-limits version exists
    const [rl] = await conn.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS c FROM risk_limits');
    if (Number(rl[0].c) === 0) {
      await conn.query('INSERT INTO risk_limits (limits, reason) VALUES (?, ?)', [
        JSON.stringify(DEFAULT_RISK_LIMITS), 'ברירת מחדל ראשונית — שלב א',
      ]);
    } else if (applied.includes('005_allocation.sql')) {
      // One-time, owner-approved change (Avi, 21.10.2026) on an EXISTING deployment:
      // switch the live paper strategy to SPY + trend filter, 100% exposure, fractional shares.
      // Every other threshold (kill switch, daily loss, spread…) is carried over unchanged.
      const [last] = await conn.query<mysql.RowDataPacket[]>('SELECT limits FROM risk_limits ORDER BY version DESC LIMIT 1');
      const prev = typeof last[0].limits === 'string' ? JSON.parse(last[0].limits) : last[0].limits;
      const next = { ...prev, allocation: { maxExposurePct: 100, fractional: true, symbols: ['SPY'] } };
      await conn.query('INSERT INTO risk_limits (limits, reason) VALUES (?, ?)', [
        JSON.stringify(next), 'אושר ע״י אבי (21.10.2026): אסטרטגיית SPY + פילטר מגמה, חשיפה 100%, מניות חלקיות',
      ]);
      await conn.query(
        'INSERT INTO settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
        ['active_strategy', JSON.stringify({ id: 'spy-trend-v1', approvedBy: 'avi@vibit.co.il', at: new Date().toISOString() })],
      );
      await conn.query("INSERT INTO audit_log (actor, action, details) VALUES ('migration', 'strategy.switched', ?)",
        [JSON.stringify({ to: 'spy-trend-v1', maxExposurePct: 100, fractional: true })]);
    }
    if (Number(rl[0].c) > 0 && applied.includes('006_kill_switch_15.sql')) {
      // One-time, owner-approved change (Avi, 21.10.2026): automatic kill switch at 15% virtual drawdown ($850 on $1,000).
      const [last] = await conn.query<mysql.RowDataPacket[]>('SELECT limits FROM risk_limits ORDER BY version DESC LIMIT 1');
      const prev = typeof last[0].limits === 'string' ? JSON.parse(last[0].limits) : last[0].limits;
      await conn.query('INSERT INTO risk_limits (limits, reason) VALUES (?, ?)', [
        JSON.stringify({ ...prev, killSwitchDrawdownPct: 15 }), 'אושר ע״י אבי (21.10.2026): Kill Switch אוטומטי ב-15% ירידה (שווי וירטואלי $850)',
      ]);
      await conn.query("INSERT INTO audit_log (actor, action, details) VALUES ('migration', 'risk.limits_changed', ?)",
        [JSON.stringify({ killSwitchDrawdownPct: { from: prev.killSwitchDrawdownPct, to: 15 } })]);
    }
  } finally {
    await conn.end();
  }
  return applied;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  migrate()
    .then((a) => { console.log(a.length ? `Applied: ${a.join(', ')}` : 'DB up to date'); })
    .catch((e) => { console.error('Migration failed:', e.message); process.exit(1); });
}
