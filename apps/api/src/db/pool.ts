import mysql from 'mysql2/promise';

let pool: mysql.Pool | null = null;

export function getPool(databaseUrl = process.env.DATABASE_URL): mysql.Pool {
  if (!pool) {
    if (!databaseUrl) throw new Error('DATABASE_URL is not set');
    pool = mysql.createPool({
      uri: databaseUrl,
      connectionLimit: 10,
      timezone: 'Z',
      dateStrings: false,
      decimalNumbers: true,
      multipleStatements: false,
    });
    // All DATETIME defaults (CURRENT_TIMESTAMP) must be UTC regardless of server TZ.
    (pool as any).pool.on('connection', (c: any) => c.query("SET time_zone = '+00:00'"));
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) await pool.end();
  pool = null;
}

export type Row = mysql.RowDataPacket;
