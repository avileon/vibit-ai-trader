import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { buildServer } from './server.js';
import { closePool } from './db/pool.js';

async function main() {
  const cfg = loadConfig(); // throws (and exits) if not paper
  const applied = await migrate(cfg.DATABASE_URL);
  if (applied.length) console.log(`Migrations applied: ${applied.join(', ')}`);
  const app = await buildServer(cfg);
  await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
  const stop = async () => { await app.close(); await closePool(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => {
  console.error(`[api] fatal: ${e.message}`);
  process.exit(1);
});
