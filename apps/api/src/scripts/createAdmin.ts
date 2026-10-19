import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { getPool, closePool } from '../db/pool.js';
import { hashPassword } from '../lib/crypto.js';

/**
 * Usage:  npm run create-admin -- --email you@example.com --name "Avi"
 * Password is read from ADMIN_PASSWORD env or prompted (never pass it as an argument — it would land in shell history).
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg('email')?.trim().toLowerCase();
  const name = arg('name') ?? 'Admin';
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Provide --email you@example.com');
  let pw = process.env.ADMIN_PASSWORD;
  if (!pw) {
    const rl = createInterface({ input: stdin, output: stdout });
    pw = await rl.question('Password (min 12 chars): ');
    rl.close();
  }
  if (!pw || pw.length < 12) throw new Error('Password must be at least 12 characters');
  const hash = await hashPassword(pw);
  await getPool().query(
    `INSERT INTO users (email, password_hash, display_name, role) VALUES (?, ?, ?, 'admin')
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), display_name = VALUES(display_name), failed_logins = 0, locked_until = NULL`,
    [email, hash, name],
  );
  await getPool().query(`INSERT INTO audit_log (actor, action, details) VALUES ('cli', 'admin.upsert', ?)`, [JSON.stringify({ email })]);
  console.log(`Admin ready: ${email}`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => closePool());
