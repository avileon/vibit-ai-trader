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

  it('logout revokes the session', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...H, cookie } });
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });
});
