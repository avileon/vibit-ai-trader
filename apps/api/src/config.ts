import { z } from 'zod';
import { assertPaperEnvironment, type BrokerEnv } from './lib/paperGuard.js';
import { parseMasterKey } from './lib/crypto.js';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().url(),
  MASTER_KEY: z.string().min(40, 'MASTER_KEY missing — openssl rand -base64 32'),
  TRADING_MODE: z.literal('paper'),
  ALPACA_BASE_URL: z.string().url().default('https://paper-api.alpaca.markets'),
  CAPITAL_BASE_USD: z.coerce.number().positive().default(1000),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  ALLOWED_ORIGIN: z.string().default('http://localhost:3000'),
  SESSION_TTL_HOURS: z.coerce.number().default(12),
});

export type AppConfig = z.infer<typeof schema> & { masterKey: Buffer };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Guard runs FIRST, with a clear error, before anything else.
  assertPaperEnvironment(env as BrokerEnv);
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  return { ...parsed.data, masterKey: parseMasterKey(parsed.data.MASTER_KEY) };
}
