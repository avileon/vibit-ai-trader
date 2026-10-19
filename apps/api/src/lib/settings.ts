import { getPool, type Row } from '../db/pool.js';

export async function getSetting<T>(name: string, fallback: T): Promise<T> {
  const [rows] = await getPool().query<Row[]>('SELECT value FROM settings WHERE name = ?', [name]);
  if (!rows.length) return fallback;
  const v = rows[0].value;
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}

export async function setSetting(name: string, value: unknown): Promise<void> {
  await getPool().query(
    'INSERT INTO settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
    [name, JSON.stringify(value)],
  );
}
