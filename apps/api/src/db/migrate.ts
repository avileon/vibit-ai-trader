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
