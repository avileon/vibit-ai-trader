/**
 * Integration tests against a real MySQL. Runs only when TEST_DATABASE_URL is set
 * (docker compose -f docker-compose.test.yml up -d).  The DB is wiped!
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import type { FastifyInstance } from 'fastify';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('API integration (MySQL)', () => {
  let app: FastifyInstance;
  let cookie = '';
  const H = { 'x-vibit-csrf': '1' };

  beforeAll(async () => {
    const u = new URL(url!);
    const dbName = u.pathname.slice(1);
    const admin = await mysql.createConnection({ host: u.hostname, port: +u.port || 3306, user: u.username, password: decodeURIComponent(u.password) });
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4`);
    await admin.end();
    process.env.DATABASE_URL = url;
    const { migrate } = await import('../src/db/migrate.js');
    await migrate(url);
    const { hashPassword } = await import('../src/lib/crypto.js');
    const { getPool } = await import('../src/db/pool.js');
    await getPool(url).query("INSERT INTO users (email, password_hash, display_name) VALUES ('t@t.io', ?, 'Tester')", [await hashPassword('test-password-123')]);
    const { seedDemo } = await import('../src/db/seedDemo.js');
    await seedDemo();
    const { loadConfig } = await import('../src/config.js');
    const { buildServer } = await import('../src/server.js');
    app = await buildServer(loadConfig({
      NODE_ENV: 'test', TRADING_MODE: 'paper', DATABASE_URL: url, MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
    } as NodeJS.ProcessEnv));
  });

  afterAll(async () => {
    await app?.close();
    const { closePool } = await import('../src/db/pool.js');
    await closePool();
  });

  it('health is public', async () => {
    const r = await app.inject({ url: '/api/health' });
    expect(r.json()).toMatchObject({ status: 'ok', tradingMode: 'paper', db: true });
  });

  it('protected routes need a session', async () => {
    expect((await app.inject({ url: '/api/dashboard' })).statusCode).toBe(401);
  });

  it('rejects POST without CSRF header', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 't@t.io', password: 'test-password-123' } });
    expect(r.statusCode).toBe(403);
  });

  it('rejects wrong password', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: H, payload: { email: 't@t.io', password: 'nope' } });
    expect(r.statusCode).toBe(401);
  });

  it('logs in and sets httpOnly strict cookie', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: H, payload: { email: 't@t.io', password: 'test-password-123' } });
    expect(r.statusCode).toBe(200);
    const sc = String(r.headers['set-cookie']);
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/SameSite=Strict/);
    cookie = sc.split(';')[0];
  });

  it('dashboard returns demo data flagged as demo', async () => {
    const r = await app.inject({ url: '/api/dashboard', headers: { cookie } });
    const j = r.json();
    expect(j.isDemo).toBe(true);
    expect(j.series.length).toBe(60);
    expect(j.bot.mode).toBe('SAFE');
    expect(j.broker.status).toBe('not_configured');
  });

  it('refuses ACTIVE mode with explicit blockers', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/bot/mode', headers: { ...H, cookie }, payload: { mode: 'ACTIVE' } });
    expect(r.statusCode).toBe(409);
    expect(r.json().blockers.length).toBeGreaterThan(0);
  });

  it('kill switch on → HALTED, resume → SAFE (never ACTIVE)', async () => {
    let r = await app.inject({ method: 'POST', url: '/api/risk/kill', headers: { ...H, cookie }, payload: { reason: 'בדיקה' } });
    expect(r.statusCode).toBe(200);
    r = await app.inject({ url: '/api/risk', headers: { cookie } });
    expect(r.json().state).toMatchObject({ mode: 'HALTED', killSwitch: true });
    r = await app.inject({ method: 'POST', url: '/api/risk/resume', headers: { ...H, cookie }, payload: { confirm: 'no' } });
    expect(r.statusCode).toBe(400);
    r = await app.inject({ method: 'POST', url: '/api/risk/resume', headers: { ...H, cookie }, payload: { confirm: 'אני מאשר' } });
    expect(r.json().mode).toBe('SAFE');
  });

  it('stores secrets encrypted, never returns plaintext, blocks live keys', async () => {
    let r = await app.inject({ method: 'PUT', url: '/api/secrets/ALPACA_KEY_ID', headers: { ...H, cookie }, payload: { value: 'AKLIVEKEY1234567' } });
    expect(r.statusCode).toBe(400);
    r = await app.inject({ method: 'PUT', url: '/api/secrets/ALPACA_KEY_ID', headers: { ...H, cookie }, payload: { value: 'PKTESTKEY1234567' } });
    expect(r.json().masked).toBe('PK…4567');
    r = await app.inject({ url: '/api/settings', headers: { cookie } });
    expect(r.body).not.toContain('PKTESTKEY1234567');
    const { getPool } = await import('../src/db/pool.js');
    const [rows] = await getPool().query<mysql.RowDataPacket[]>("SELECT ciphertext FROM secrets WHERE name='ALPACA_KEY_ID'");
    expect(rows[0].ciphertext).not.toContain('PKTESTKEY');
    const [logs] = await getPool().query<mysql.RowDataPacket[]>('SELECT details FROM audit_log');
    expect(JSON.stringify(logs)).not.toContain('PKTESTKEY1234567');
  });

  it('stores timestamps in UTC regardless of MySQL server timezone', async () => {
    const { getPool } = await import('../src/db/pool.js');
    const [rows] = await getPool().query<mysql.RowDataPacket[]>('SELECT created_at FROM audit_log ORDER BY id DESC LIMIT 1');
    expect(Math.abs(Date.now() - new Date(rows[0].created_at).getTime())).toBeLessThan(5 * 60_000);
  });

  it('rejects unknown secret names', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/secrets/EVIL', headers: { ...H, cookie }, payload: { value: 'xxxxxxxxxxxxxx' } });
    expect(r.statusCode).toBe(404);
  });

  it('broker sync (mock): mirrors account, positions, orders incl. legs, clock', async () => {
    const { MockBroker } = await import('./mockBroker.js');
    const { syncBroker } = await import('../src/broker/sync.js');
    const { getPool } = await import('../src/db/pool.js');
    const b = new MockBroker();
    const r = await syncBroker(b);
    expect(r.ok).toBe(true);
    expect(r.positions).toBe(2);
    expect(r.orders).toBe(4); // 2 parents + 2 legs
    const [pos] = await getPool().query<mysql.RowDataPacket[]>("SELECT symbol, stop_price FROM positions WHERE source='alpaca' ORDER BY symbol");
    expect(pos.map((p) => p.symbol)).toEqual(['XLE', 'XLF']);
    expect(pos.find((p) => p.symbol === 'XLF')!.stop_price).toBe(38); // from bracket stop leg
    const [ord] = await getPool().query<mysql.RowDataPacket[]>("SELECT client_order_id, reason FROM orders WHERE source='alpaca' AND client_order_id='manual-abc'");
    expect(ord[0].reason).toMatch(/מחוץ למערכת/);
    const d = (await app.inject({ url: '/api/dashboard', headers: { cookie } })).json();
    expect(d.source).toBe('alpaca');
    expect(d.isDemo).toBe(false);
    expect(d.market.source).toBe('alpaca');
    expect(d.summary.equity).toBe(1012.5);
    expect(d.series.length).toBeGreaterThanOrEqual(3); // backfill (2 non-zero) + live snapshot
  });

  it('broker sync reconciles: closed position disappears, order status updates (idempotent)', async () => {
    const { MockBroker } = await import('./mockBroker.js');
    const { syncBroker } = await import('../src/broker/sync.js');
    const { getPool } = await import('../src/db/pool.js');
    const b = new MockBroker();
    b.positions = b.positions.filter((p) => p.symbol !== 'XLE');
    b.orders[0].legs![1].status = 'canceled';
    await syncBroker(b);
    await syncBroker(b);
    const [pos] = await getPool().query<mysql.RowDataPacket[]>("SELECT symbol FROM positions WHERE source='alpaca'");
    expect(pos.map((p) => p.symbol)).toEqual(['XLF']);
    const [o] = await getPool().query<mysql.RowDataPacket[]>("SELECT COUNT(*) c FROM orders WHERE source='alpaca'");
    expect(Number(o[0].c)).toBe(4);
    const [leg] = await getPool().query<mysql.RowDataPacket[]>("SELECT status FROM orders WHERE alpaca_order_id='ord-1-sl'");
    expect(leg[0].status).toBe('canceled');
  });

  it('broker sync refuses a non-paper account and marks error', async () => {
    const { MockBroker } = await import('./mockBroker.js');
    const { syncBroker } = await import('../src/broker/sync.js');
    const b = new MockBroker();
    b.account = { ...b.account, account_number: '987654' };
    const r = await syncBroker(b);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not_paper/);
    const st = (await app.inject({ url: '/api/broker', headers: { cookie } })).json();
    expect(st.status).toBe('error');
    const d = (await app.inject({ url: '/api/dashboard', headers: { cookie } })).json();
    expect(d.isDemo).toBe(true); // falls back to demo view when broker not ok
  });

  describe('engine (mock broker)', () => {
    const NOW = new Date('2026-10-20T14:30:00Z'); // Tue 10:30 New York
    async function setup(mode: 'ACTIVE' | 'SAFE' = 'ACTIVE') {
      const { MockBroker } = await import('./mockBroker.js');
      const { makeBars } = await import('./fixtures.js');
      const { getPool } = await import('../src/db/pool.js');
      const b = new MockBroker();
      b.positions = []; b.orders = [];
      b.quoteTs = NOW;
      b.barsMulti = { SPY: makeBars(260, 500, 0.001, NOW), XLF: makeBars(260, 30, 0.002, NOW), XLE: makeBars(260, 60, -0.002, NOW) };
      await getPool().query("UPDATE bot_state SET mode=?, kill_switch=0, kill_reason=NULL, engine_last_run_day=NULL WHERE id=1", [mode]);
      await getPool().query("DELETE FROM orders WHERE source='alpaca'");
      return { b, pool: getPool() };
    }

    it('does nothing in SAFE mode', async () => {
      const { b } = await setup('SAFE');
      const { maybeRunDailyCycle } = await import('../src/engine/cycle.js');
      expect((await maybeRunDailyCycle(b, NOW)).ran).toBe(false);
      expect(b.submitted).toHaveLength(0);
    });

    it('ACTIVE: proposes, risk-approves and submits ONE bracket order; logs decision', async () => {
      const { b, pool } = await setup();
      const { maybeRunDailyCycle } = await import('../src/engine/cycle.js');
      const rep = await maybeRunDailyCycle(b, NOW);
      expect(rep.ran).toBe(true);
      expect(rep.results, JSON.stringify(rep.results)).toEqual([expect.objectContaining({ symbol: 'XLF', kind: 'entry', status: 'submitted' })]);
      expect(b.submitted).toHaveLength(1);
      const o = b.submitted[0];
      expect(o.order_class).toBe('bracket');
      expect(o.side).toBe('buy');
      expect(o.client_order_id).toBe('vibit-entry-XLF-20261020');
      expect(o.stop_loss!.stop_price).toBeLessThan(o.limit_price!);
      expect((o.limit_price! - o.stop_loss!.stop_price) * o.qty).toBeLessThanOrEqual(10.13); // 1% of virtual equity
      expect(o.limit_price! * o.qty).toBeLessThanOrEqual(200);
      const [d] = await pool.query<mysql.RowDataPacket[]>('SELECT approved FROM risk_decisions ORDER BY id DESC LIMIT 1');
      expect(d[0].approved).toBe(1);
      // second run the same day: no-op
      expect((await maybeRunDailyCycle(b, NOW)).reason).toBe('already ran today');
    });

    it('idempotency: a forced re-run the same day never double-submits', async () => {
      const { b } = await setup();
      const { maybeRunDailyCycle } = await import('../src/engine/cycle.js');
      await maybeRunDailyCycle(b, NOW);
      const again = await maybeRunDailyCycle(b, NOW, { force: true });
      expect(b.submitted).toHaveLength(1);
      expect(again.results!.every((r) => r.status !== 'submitted')).toBe(true);
    });

    it('network failure after the broker received the order → confirmed by lookup, not resubmitted', async () => {
      const { b } = await setup();
      b.submitMode = 'network_then_found';
      const { maybeRunDailyCycle } = await import('../src/engine/cycle.js');
      const rep = await maybeRunDailyCycle(b, NOW);
      expect(rep.results![0].status).toBe('submitted');
      expect(b.submitted).toHaveLength(1);
    });

    it('network failure where the broker did NOT get it → marked failed, no blind retry', async () => {
      const { b, pool } = await setup();
      b.submitMode = 'network_not_found';
      const { maybeRunDailyCycle } = await import('../src/engine/cycle.js');
      const rep = await maybeRunDailyCycle(b, NOW);
      expect(rep.results![0].status).toBe('unknown_failed');
      const [o] = await pool.query<mysql.RowDataPacket[]>("SELECT status FROM orders WHERE client_order_id='vibit-entry-XLF-20261020'");
      expect(o[0].status).toBe('submit_failed');
    });

    it('broker rejection is recorded with the reason', async () => {
      const { b, pool } = await setup();
      b.submitMode = 'reject';
      const { maybeRunDailyCycle } = await import('../src/engine/cycle.js');
      const rep = await maybeRunDailyCycle(b, NOW);
      expect(rep.results![0].status).toBe('broker_rejected');
      const [o] = await pool.query<mysql.RowDataPacket[]>("SELECT status, reason FROM orders WHERE client_order_id='vibit-entry-XLF-20261020'");
      expect(o[0].status).toBe('rejected');
      expect(o[0].reason).toMatch(/buying power/);
    });

    it('stale market data → risk engine blocks the order', async () => {
      const { b } = await setup();
      b.quoteTs = new Date(NOW.getTime() - 10 * 60_000);
      const { maybeRunDailyCycle } = await import('../src/engine/cycle.js');
      const rep = await maybeRunDailyCycle(b, NOW);
      expect(rep.results![0].status).toBe('rejected_by_risk');
      expect(rep.results![0].message).toMatch(/quote_fresh/);
      expect(b.submitted).toHaveLength(0);
    });

    it('auto kill switch when virtual equity falls to the threshold', async () => {
      const { b } = await setup();
      const { syncBroker } = await import('../src/broker/sync.js');
      const { housekeeping } = await import('../src/engine/cycle.js');
      b.account = { ...b.account, equity: 949 }; // base 1000 → virtual 949
      await syncBroker(b);
      const notes = await housekeeping(b);
      expect(notes.join()).toMatch(/אוטומטי/);
      const r = (await app.inject({ url: '/api/risk', headers: { cookie } })).json();
      expect(r.state).toMatchObject({ mode: 'HALTED', killSwitch: true });
    });

    it('API exposes engine proposals with rationale and risk checks', async () => {
      const r = (await app.inject({ url: '/api/engine', headers: { cookie } })).json();
      expect(r.proposals.length).toBeGreaterThan(0);
      expect(r.proposals[0].rationale.reasons.length).toBeGreaterThan(0);
      expect(r.proposals[0].checks.length).toBeGreaterThan(10);
    });
  });

  it('Strategy Lab: queue a backtest via API, worker runs it, result is readable', async () => {
    const { MockBroker } = await import('./mockBroker.js');
    const { makeBars } = await import('./fixtures.js');
    const { runNextBacktest } = await import('../src/backtest/jobs.js');
    const b = new MockBroker();
    const end = new Date();
    b.barsMulti = { SPY: makeBars(500, 300, 0.0006, end), XLF: makeBars(500, 20, 0.0015, end, 0.01), XLE: makeBars(500, 60, -0.0005, end) };
    let r = await app.inject({ method: 'POST', url: '/api/backtests', headers: { ...H, cookie }, payload: { start: '2025-01-01', walkForward: false } });
    expect(r.statusCode).toBe(200);
    const id = r.json().id;
    r = await app.inject({ method: 'POST', url: '/api/backtests', headers: { ...H, cookie }, payload: {} });
    expect(r.statusCode).toBe(409); // one at a time
    expect(await runNextBacktest(b)).toBe(id);
    const run = (await app.inject({ url: `/api/backtests/${id}`, headers: { cookie } })).json();
    expect(run.status, run.error).toBe('done');
    expect(run.result.summary.strategy.days).toBeGreaterThan(50);
    expect(run.result.segments).toHaveLength(3);
    expect(run.result.caveats.join()).toMatch(/Survivorship/);
    const list = (await app.inject({ url: '/api/backtests', headers: { cookie } })).json();
    expect(list.runs[0].id).toBe(id);
  });

  it('live report endpoint works with paper data', async () => {
    const r = (await app.inject({ url: '/api/reports?period=all', headers: { cookie } })).json();
    expect(r.period).toBe('all');
    expect(r).toHaveProperty('netPnlUsd');
    expect(r).toHaveProperty('winRatePct');
  });

  it('logout revokes the session', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...H, cookie } });
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });
});
