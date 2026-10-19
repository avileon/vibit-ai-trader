import { getPool, type Row } from '../db/pool.js';
import { decryptSecret } from '../lib/crypto.js';

export interface AlpacaKeys { keyId: string; secretKey: string; source: 'db' | 'env' }

/** Keys from the encrypted DB store (set via Settings), falling back to env. Never logged. */
export async function loadAlpacaKeys(masterKey: Buffer, env = process.env): Promise<AlpacaKeys | null> {
  const [rows] = await getPool().query<Row[]>(
    "SELECT name, ciphertext FROM secrets WHERE name IN ('ALPACA_KEY_ID','ALPACA_SECRET_KEY')",
  );
  const m = Object.fromEntries(rows.map((r) => [r.name, r.ciphertext as string]));
  if (m.ALPACA_KEY_ID && m.ALPACA_SECRET_KEY) {
    return { keyId: decryptSecret(m.ALPACA_KEY_ID, masterKey), secretKey: decryptSecret(m.ALPACA_SECRET_KEY, masterKey), source: 'db' };
  }
  if (env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY) return { keyId: env.ALPACA_KEY_ID, secretKey: env.ALPACA_SECRET_KEY, source: 'env' };
  return null;
}
