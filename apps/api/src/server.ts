import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { AppConfig } from './config.js';
import { registerAuthRoutes } from './auth.js';
import { registerDataRoutes } from './routes/data.js';
import { registerControlRoutes } from './routes/control.js';
import { getPool, type Row } from './db/pool.js';

export async function buildServer(cfg: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: true,
    bodyLimit: 64 * 1024,
    logger: {
      level: cfg.NODE_ENV === 'test' ? 'silent' : 'info',
      // never log credentials/cookies
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.body.password', 'req.body.value', 'res.headers["set-cookie"]'],
    },
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  // CSRF defence: mutating requests must carry a custom header (cannot be set cross-site without CORS, which we don't enable)
  // plus SameSite=strict cookies.
  app.addHook('onRequest', async (req, reply) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers['x-vibit-csrf'] !== '1') {
      return reply.code(403).send({ error: 'csrf' });
    }
  });

  app.get('/api/health', async () => {
    let db = false;
    let worker: { alive: boolean; heartbeatAt: Date | null; mode: string | null } = { alive: false, heartbeatAt: null, mode: null };
    try {
      const [rows] = await getPool().query<Row[]>('SELECT mode, worker_heartbeat_at FROM bot_state WHERE id = 1');
      db = true;
      const hb = rows[0]?.worker_heartbeat_at ?? null;
      worker = { alive: !!hb && Date.now() - new Date(hb).getTime() < 180_000, heartbeatAt: hb, mode: rows[0]?.mode ?? null };
    } catch { /* db down */ }
    return { status: db ? 'ok' : 'degraded', tradingMode: 'paper', db, worker, time: new Date().toISOString() };
  });

  registerAuthRoutes(app, cfg);
  registerDataRoutes(app);
  registerControlRoutes(app, cfg);
  return app;
}
