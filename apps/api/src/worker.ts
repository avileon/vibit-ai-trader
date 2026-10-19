import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { getPool, closePool, type Row } from './db/pool.js';
import { audit } from './lib/audit.js';
import { buildBrokerClient, runSync } from './broker/index.js';
import { housekeeping, maybeRunDailyCycle } from './engine/cycle.js';
import { runNextBacktest } from './backtest/jobs.js';
import type { AppConfig } from './config.js';
let cfgRef: AppConfig;

/**
 * Trading engine process (runs 24/7, independent of the browser).
 * כל 30 שנ׳: heartbeat. כל דקה: סנכרון Alpaca Paper + housekeeping (Kill Switch אוטומטי, ביטול כניסות ישנות).
 * פעם ביום (10:00–15:30 ניו יורק, רק במצב ACTIVE): Strategy → RiskEngine → Executor.
 */
const VERSION = '0.5.0-phaseF';
const SYNC_EVERY_MS = 60_000;
let lastSync = 0;
const TICK_MS = 30_000;

async function startup() {
  const cfg = loadConfig();
  cfgRef = cfg;
  await migrate(cfg.DATABASE_URL);
  // SAFE-BY-DEFAULT: every (re)start forces SAFE unless the kill switch holds it in HALTED.
  await getPool().query(
    "UPDATE bot_state SET mode = IF(kill_switch = 1, 'HALTED', 'SAFE'), worker_started_at = UTC_TIMESTAMP(), worker_heartbeat_at = UTC_TIMESTAMP(), worker_version = ? WHERE id = 1",
    [VERSION],
  );
  await audit('worker', 'bot.worker_start', { version: VERSION, forcedMode: 'SAFE' });
  console.log(`[worker] started ${VERSION} in SAFE mode (no orders will be sent)`);
}

async function tick() {
  const pool = getPool();
  await pool.query('UPDATE bot_state SET worker_heartbeat_at = UTC_TIMESTAMP() WHERE id = 1');
  const [rows] = await pool.query<Row[]>('SELECT mode, kill_switch FROM bot_state WHERE id = 1');
  const st = rows[0];
  if (Date.now() - lastSync < SYNC_EVERY_MS) return;
  lastSync = Date.now();
  const r = await runSync(cfgRef);
  if (!r.configured) return;
  if (!r.ok) { console.warn(`[worker] broker sync failed: ${r.error}`); return; }
  const broker = await buildBrokerClient(cfgRef);
  if (!broker) return;
  const notes = await housekeeping(broker);
  for (const n of notes) console.warn(`[worker] ${n}`);
  if (!(st.kill_switch || st.mode !== 'ACTIVE')) {
    const rep = await maybeRunDailyCycle(broker);
    if (rep.ran) console.log(`[worker] daily cycle: ${JSON.stringify(rep.results)}`);
  }
  // research jobs run after trading duties (never instead of them)
  const bt = await runNextBacktest(broker);
  if (bt) console.log(`[worker] backtest #${bt} finished`);
}

let running = true;
async function loop() {
  await startup();
  while (running) {
    try { await tick(); } catch (e) { console.error('[worker] tick error:', (e as Error).message); }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

const stop = async () => { running = false; await closePool(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

loop().catch((e) => { console.error(`[worker] fatal: ${e.message}`); process.exit(1); });
