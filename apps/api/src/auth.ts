import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { getPool, type Row } from './db/pool.js';
import { randomToken, sha256, verifyPassword } from './lib/crypto.js';
import { audit } from './lib/audit.js';

export const SESSION_COOKIE = 'vibit_session';
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
// constant-time-ish dummy hash so unknown emails take similar time
const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==';

export interface SessionUser { id: number; email: string; displayName: string; role: 'admin' | 'viewer' }

declare module 'fastify' {
  interface FastifyRequest { user?: SessionUser }
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return reply.code(401).send({ error: 'unauthorized' });
  const [rows] = await getPool().query<Row[]>(
    `SELECT u.id, u.email, u.display_name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP()`,
    [sha256(token)],
  );
  if (!rows.length) return reply.code(401).send({ error: 'unauthorized' });
  const r = rows[0];
  req.user = { id: r.id, email: r.email, displayName: r.display_name, role: r.role };
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  await requireAuth(req, reply);
  if (reply.sent) return;
  if (req.user?.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
}

const loginBody = z.object({ email: z.string().email().max(190), password: z.string().min(1).max(200) });

export function registerAuthRoutes(app: FastifyInstance, cfg: AppConfig) {
  app.post('/api/auth/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_input' });
    const email = body.data.email.toLowerCase();
    const pool = getPool();
    const [rows] = await pool.query<Row[]>('SELECT * FROM users WHERE email = ?', [email]);
    const user = rows[0];
    if (user?.locked_until && new Date(user.locked_until) > new Date()) {
      return reply.code(423).send({ error: 'locked', message: 'החשבון נעול זמנית לאחר ניסיונות כושלים' });
    }
    const ok = await verifyPassword(body.data.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) {
      if (user) {
        const failed = user.failed_logins + 1;
        await pool.query(
          'UPDATE users SET failed_logins = ?, locked_until = IF(? >= ?, UTC_TIMESTAMP() + INTERVAL ? MINUTE, NULL) WHERE id = ?',
          [failed, failed, MAX_FAILED, LOCK_MINUTES, user.id],
        );
      }
      await audit('anonymous', 'auth.login_failed', { email }, req.ip);
      return reply.code(401).send({ error: 'invalid_credentials', message: 'אימייל או סיסמה שגויים' });
    }
    const token = randomToken();
    await pool.query(
      'INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP() + INTERVAL ? HOUR)',
      [user.id, sha256(token), req.ip, String(req.headers['user-agent'] ?? '').slice(0, 255), cfg.SESSION_TTL_HOURS],
    );
    await pool.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP() WHERE id = ?', [user.id]);
    await audit(user.email, 'auth.login', null, req.ip);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'strict', secure: cfg.COOKIE_SECURE === 'true', path: '/',
      maxAge: cfg.SESSION_TTL_HOURS * 3600,
    });
    return { ok: true, user: { email: user.email, displayName: user.display_name, role: user.role } };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await getPool().query('UPDATE sessions SET revoked_at = UTC_TIMESTAMP() WHERE token_hash = ?', [sha256(token)]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => ({ user: req.user }));
}
