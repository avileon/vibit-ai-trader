import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { getPool, closePool, type Row } from './db/pool.js';
import { audit } from './lib/audit.js';
import { estimateMarketSession } from './lib/marketHours.js';

/**
 * Trading engine process (runs 24/7, independent of the browser).
 * שלב ב: heartbeat + מצב בטוח בלבד. אין כאן שום שליחת פקודות.
 * שלב ג: סנכרון Alpaca. שלב ד: Strategy → RiskEngine → Executor.
 */
const VERSION = '0.2.0-phaseB';
const TICK_MS = 30_000;

async function startup() {
  const cfg = loadConfig();
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
  const market = estimateMarketSession();
  if (st.kill_switch || st.mode !== 'ACTIVE') return; // nothing to do
  // Phase D will run the engine here. Until then ACTIVE cannot be reached (API refuses), but be defensive:
  console.warn(`[worker] mode=ACTIVE but engine not installed — forcing SAFE (market open: ${market.isOpen})`);
  await pool.query("UPDATE bot_state SET mode = 'SAFE' WHERE id = 1");
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
