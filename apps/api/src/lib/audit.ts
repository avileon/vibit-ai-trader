import { getPool } from '../db/pool.js';

const SECRET_LIKE = /(key|secret|token|password)/i;

/** Writes an audit row. Any field whose name looks secret is redacted before storage. */
export async function audit(actor: string, action: string, details: Record<string, unknown> | null, ip?: string) {
  const safe = details
    ? Object.fromEntries(Object.entries(details).map(([k, v]) => [k, SECRET_LIKE.test(k) ? '[redacted]' : v]))
    : null;
  await getPool().query('INSERT INTO audit_log (actor, action, details, ip) VALUES (?, ?, ?, ?)', [
    actor, action, safe ? JSON.stringify(safe) : null, ip ?? null,
  ]);
}
