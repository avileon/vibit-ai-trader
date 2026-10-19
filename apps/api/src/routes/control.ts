import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { getPool, type Row } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { encryptSecret, maskSecret } from '../lib/crypto.js';
import { assertLooksLikePaperKey, PaperGuardError, ALPACA_PAPER_TRADING_URL } from '../lib/paperGuard.js';
import { getSetting, setSetting } from '../lib/settings.js';
import { buildBrokerClient, runSync } from '../broker/index.js';
import { backtestRequestSchema, enqueueBacktest } from '../backtest/jobs.js';
import { liveReport } from '../reports/live.js';
import { killSwitchThreshold, riskBudgetPerTrade, riskLimitsSchema } from '../riskConfig.js';

const ALLOWED_SECRETS = ['ALPACA_KEY_ID', 'ALPACA_SECRET_KEY', 'ANTHROPIC_API_KEY'] as const;

export async function currentLimits() {
  const [rows] = await getPool().query<Row[]>('SELECT version, limits, reason, created_at FROM risk_limits ORDER BY version DESC LIMIT 1');
  const r = rows[0];
  const limits = riskLimitsSchema.parse(typeof r.limits === 'string' ? JSON.parse(r.limits) : r.limits);
  return { version: r.version as number, limits, reason: r.reason as string, createdAt: r.created_at };
}

export function registerControlRoutes(app: FastifyInstance, cfg: AppConfig) {
  // ---------- Risk Center ----------
  app.get('/api/risk', { preHandler: requireAuth }, async () => {
    const pool = getPool();
    const lim = await currentLimits();
    const [st] = await pool.query<Row[]>('SELECT mode, kill_switch, kill_reason, kill_at FROM bot_state WHERE id = 1');
    const [decisions] = await pool.query<Row[]>('SELECT id, proposal_id, approved, checks, limits_version, created_at FROM risk_decisions ORDER BY id DESC LIMIT 50');
    const [events] = await pool.query<Row[]>(
      "SELECT actor, action, details, created_at FROM audit_log WHERE action LIKE 'bot.%' OR action LIKE 'risk.%' ORDER BY id DESC LIMIT 50",
    );
    return {
      limitsVersion: lim.version, limits: lim.limits, limitsReason: lim.reason,
      derived: {
        killSwitchEquity: killSwitchThreshold(lim.limits),
        riskPerTradeUsd: riskBudgetPerTrade(lim.limits, lim.limits.capitalBaseUsd),
        maxPositionUsd: +(lim.limits.capitalBaseUsd * lim.limits.maxPositionPct / 100).toFixed(2),
        maxExposureUsd: +(lim.limits.capitalBaseUsd * lim.limits.maxTotalExposurePct / 100).toFixed(2),
        dailyLossUsd: +(lim.limits.capitalBaseUsd * lim.limits.dailyLossLimitPct / 100).toFixed(2),
      },
      state: { mode: st[0].mode, killSwitch: !!st[0].kill_switch, killReason: st[0].kill_reason, killAt: st[0].kill_at },
      decisions, events,
    };
  });

  const killBody = z.object({ reason: z.string().trim().min(3).max(200) });
  app.post('/api/risk/kill', { preHandler: requireAdmin }, async (req, reply) => {
    const b = killBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid_input', message: 'יש לציין סיבה' });
    await getPool().query(
      "UPDATE bot_state SET kill_switch = 1, mode = 'HALTED', kill_reason = ?, kill_at = UTC_TIMESTAMP() WHERE id = 1",
      [b.data.reason],
    );
    await audit(req.user!.email, 'bot.kill_switch_on', { reason: b.data.reason }, req.ip);
    return { ok: true };
  });

  const resumeBody = z.object({ confirm: z.literal('אני מאשר') });
  app.post('/api/risk/resume', { preHandler: requireAdmin }, async (req, reply) => {
    if (!resumeBody.safeParse(req.body).success) {
      return reply.code(400).send({ error: 'confirm_required', message: 'יש להקליד "אני מאשר"' });
    }
    // Resume goes to SAFE only — never directly to ACTIVE.
    await getPool().query("UPDATE bot_state SET kill_switch = 0, mode = 'SAFE', kill_reason = NULL WHERE id = 1");
    await audit(req.user!.email, 'bot.kill_switch_off', { newMode: 'SAFE' }, req.ip);
    return { ok: true, mode: 'SAFE' };
  });

  const modeBody = z.object({ mode: z.enum(['SAFE', 'ACTIVE']), confirm: z.string().optional() });
  app.post('/api/bot/mode', { preHandler: requireAdmin }, async (req, reply) => {
    const b = modeBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid_input' });
    const [st] = await getPool().query<Row[]>('SELECT kill_switch, broker_status, worker_heartbeat_at, last_sync_at FROM bot_state WHERE id = 1');
    if (b.data.mode === 'ACTIVE') {
      const blockers: string[] = [];
      if (st[0].kill_switch) blockers.push('Kill Switch פעיל');
      if (st[0].broker_status !== 'ok') blockers.push('אין חיבור מאומת ל-Alpaca Paper');
      if (!st[0].worker_heartbeat_at || Date.now() - new Date(st[0].worker_heartbeat_at).getTime() > 180_000) blockers.push('ה-Worker לא פעיל');
      if (!st[0].last_sync_at || Date.now() - new Date(st[0].last_sync_at).getTime() > 300_000) blockers.push('אין סנכרון עדכני מהברוקר');
      if (b.data.confirm !== 'הפעל Paper') blockers.push('יש להקליד "הפעל Paper" לאישור');
      if (blockers.length) {
        await audit(req.user!.email, 'bot.activate_denied', { blockers }, req.ip);
        return reply.code(409).send({ error: 'blocked', blockers });
      }
      await getPool().query("UPDATE bot_state SET mode = 'ACTIVE' WHERE id = 1 AND kill_switch = 0");
      await audit(req.user!.email, 'bot.mode_active', null, req.ip);
      return { ok: true, mode: 'ACTIVE' };
    }
    await getPool().query("UPDATE bot_state SET mode = 'SAFE' WHERE id = 1 AND kill_switch = 0");
    await audit(req.user!.email, 'bot.mode_safe', null, req.ip);
    return { ok: true };
  });

  const flattenBody = z.object({ confirm: z.literal('סגור הכל') });
  app.post('/api/risk/flatten', { preHandler: requireAdmin, config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!flattenBody.safeParse(req.body).success) return reply.code(400).send({ error: 'confirm_required', message: 'יש להקליד "סגור הכל"' });
    const broker = await buildBrokerClient(cfg);
    if (!broker) return reply.code(409).send({ error: 'no_broker' });
    await getPool().query("UPDATE bot_state SET kill_switch = 1, mode = 'HALTED', kill_reason = 'סגירת כל הפוזיציות ידנית', kill_at = UTC_TIMESTAMP() WHERE id = 1");
    await broker.closeAllPositions();
    await audit(req.user!.email, 'risk.flatten_all', null, req.ip);
    await runSync(cfg);
    return { ok: true };
  });

  app.get('/api/engine', { preHandler: requireAuth }, async () => {
    const [props] = await getPool().query<Row[]>(
      `SELECT p.id, p.kind, p.symbol, p.side, p.qty, p.price_ref, p.stop_price, p.take_profit, p.rationale, p.strategy_version, p.status,
              p.client_order_id, p.created_at, d.approved, d.checks
       FROM trade_proposals p LEFT JOIN risk_decisions d ON d.proposal_id = p.id
       WHERE p.source='engine' ORDER BY p.id DESC LIMIT 50`,
    );
    const [st] = await getPool().query<Row[]>('SELECT mode, engine_last_run_at, engine_message FROM bot_state WHERE id = 1');
    const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
    return {
      mode: st[0].mode, lastRunAt: st[0].engine_last_run_at, message: st[0].engine_message,
      report: await getSetting('engine_last_report', null),
      proposals: props.map((p) => ({ ...p, rationale: parse(p.rationale), checks: p.checks ? parse(p.checks) : null })),
    };
  });

  // ---------- Strategy Lab ----------
  app.post('/api/backtests', { preHandler: requireAdmin, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = backtestRequestSchema.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'invalid_input' });
    const [busy] = await getPool().query<Row[]>("SELECT COUNT(*) c FROM backtest_runs WHERE status IN ('queued','running')");
    if (Number(busy[0].c) > 0) return reply.code(409).send({ error: 'busy', message: 'כבר רצה בדיקה — המתן לסיומה' });
    const id = await enqueueBacktest(b.data, req.user!.email);
    await audit(req.user!.email, 'backtest.enqueued', { id }, req.ip);
    return { ok: true, id };
  });
  app.get('/api/backtests', { preHandler: requireAuth }, async () => {
    const [rows] = await getPool().query<Row[]>(
      `SELECT id, status, config, progress, error, created_at, finished_at,
        JSON_EXTRACT(result, '$.summary.strategy.totalReturnPct') AS ret, JSON_EXTRACT(result, '$.summary.benchmark.totalReturnPct') AS bench, JSON_UNQUOTE(JSON_EXTRACT(config, '$.kind')) AS kind
       FROM backtest_runs ORDER BY id DESC LIMIT 30`,
    );
    return { runs: rows.map((r) => ({ ...r, config: typeof r.config === 'string' ? JSON.parse(r.config) : r.config })) };
  });
  app.get('/api/backtests/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid_input' });
    const [rows] = await getPool().query<Row[]>('SELECT id, status, config, progress, error, result, created_at, finished_at FROM backtest_runs WHERE id=?', [id]);
    if (!rows.length) return reply.code(404).send({ error: 'not_found' });
    const r = rows[0];
    return { ...r, config: typeof r.config === 'string' ? JSON.parse(r.config) : r.config, result: r.result ? JSON.parse(r.result) : null };
  });

  // ---------- Reports (live paper trading) ----------
  app.get('/api/reports', { preHandler: requireAuth }, async (req, reply) => {
    const p = z.object({ period: z.enum(['day', 'week', 'month', 'all']).default('week') }).safeParse(req.query);
    if (!p.success) return reply.code(400).send({ error: 'invalid_input' });
    return liveReport(p.data.period, cfg.CAPITAL_BASE_USD);
  });

  // ---------- Broker ----------
  app.get('/api/broker', { preHandler: requireAuth }, async () => {
    const [st] = await getPool().query<Row[]>(
      'SELECT broker_status, broker_message, broker_checked_at, account_meta, last_sync_at, sync_error, market_is_open, market_next_open, market_next_close FROM bot_state WHERE id = 1',
    );
    const r = st[0];
    return {
      status: r.broker_status, message: r.broker_message, checkedAt: r.broker_checked_at, lastSyncAt: r.last_sync_at, syncError: r.sync_error,
      account: r.account_meta ? (typeof r.account_meta === 'string' ? JSON.parse(r.account_meta) : r.account_meta) : null,
      capitalBaseUsd: cfg.CAPITAL_BASE_USD,
    };
  });

  app.post('/api/broker/sync', { preHandler: requireAdmin, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const r = await runSync(cfg);
    await audit(req.user!.email, 'broker.manual_sync', { ok: r.ok, configured: r.configured }, req.ip);
    return r;
  });

  // ---------- Settings ----------
  app.get('/api/settings', { preHandler: requireAuth }, async () => {
    const [secrets] = await getPool().query<Row[]>('SELECT name, masked, updated_at FROM secrets');
    return {
      tradingMode: 'paper',
      brokerUrl: ALPACA_PAPER_TRADING_URL,
      capitalBaseUsd: cfg.CAPITAL_BASE_USD,
      ilsRate: await getSetting<number | null>('ils_rate', null),
      notifications: await getSetting('notifications', { email: '', whatsapp: '', enabled: false }),
      activeHours: await getSetting('active_hours', { from: '16:45', to: '22:45', tz: 'Asia/Jerusalem' }),
      secrets: ALLOWED_SECRETS.map((n) => {
        const s = secrets.find((x) => x.name === n);
        return { name: n, configured: !!s, masked: s?.masked ?? null, updatedAt: s?.updated_at ?? null };
      }),
    };
  });

  const settingsBody = z.object({
    ilsRate: z.number().min(1).max(10).nullable().optional(),
    notifications: z.object({ email: z.string().email().or(z.literal('')), whatsapp: z.string().regex(/^\+?\d{0,15}$/), enabled: z.boolean() }).optional(),
    activeHours: z.object({ from: z.string().regex(/^\d{2}:\d{2}$/), to: z.string().regex(/^\d{2}:\d{2}$/), tz: z.literal('Asia/Jerusalem') }).optional(),
  });
  app.put('/api/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const b = settingsBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid_input', issues: b.error.issues.map((i) => i.path.join('.')) });
    if (b.data.ilsRate !== undefined) await setSetting('ils_rate', b.data.ilsRate);
    if (b.data.notifications) await setSetting('notifications', b.data.notifications);
    if (b.data.activeHours) await setSetting('active_hours', b.data.activeHours);
    await audit(req.user!.email, 'settings.update', { keys: Object.keys(b.data) }, req.ip);
    return { ok: true };
  });

  const secretBody = z.object({ value: z.string().trim().min(10).max(300).regex(/^[\x21-\x7e]+$/) });
  app.put('/api/secrets/:name', { preHandler: requireAdmin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const name = (req.params as { name: string }).name as (typeof ALLOWED_SECRETS)[number];
    if (!ALLOWED_SECRETS.includes(name)) return reply.code(404).send({ error: 'unknown_secret' });
    const b = secretBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid_input' });
    try {
      if (name === 'ALPACA_KEY_ID') assertLooksLikePaperKey(b.data.value);
    } catch (e) {
      if (e instanceof PaperGuardError) return reply.code(400).send({ error: 'paper_only', message: e.message });
      throw e;
    }
    const masked = maskSecret(b.data.value);
    await getPool().query(
      'INSERT INTO secrets (name, ciphertext, masked, updated_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE ciphertext = VALUES(ciphertext), masked = VALUES(masked), updated_by = VALUES(updated_by)',
      [name, encryptSecret(b.data.value, cfg.masterKey), masked, req.user!.id],
    );
    await audit(req.user!.email, 'secret.set', { which: name, masked }, req.ip);
    return { ok: true, masked };
  });

  app.delete('/api/secrets/:name', { preHandler: requireAdmin }, async (req, reply) => {
    const name = (req.params as { name: string }).name as (typeof ALLOWED_SECRETS)[number];
    if (!ALLOWED_SECRETS.includes(name)) return reply.code(404).send({ error: 'unknown_secret' });
    await getPool().query('DELETE FROM secrets WHERE name = ?', [name]);
    await audit(req.user!.email, 'secret.delete', { name }, req.ip);
    return { ok: true };
  });
}
