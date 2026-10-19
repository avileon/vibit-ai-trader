import type { AppConfig } from '../config.js';
import { AlpacaClient } from './alpacaClient.js';
import { loadAlpacaKeys } from './credentials.js';
import { markBrokerNotConfigured, syncBroker, type SyncResult } from './sync.js';

export async function buildBrokerClient(cfg: AppConfig): Promise<AlpacaClient | null> {
  const keys = await loadAlpacaKeys(cfg.masterKey);
  if (!keys) return null;
  return new AlpacaClient({ keyId: keys.keyId, secretKey: keys.secretKey, baseUrl: cfg.ALPACA_BASE_URL });
}

/** One full sync; marks not_configured when no keys. Errors are captured into bot_state, never thrown. */
export async function runSync(cfg: AppConfig): Promise<SyncResult & { configured: boolean }> {
  let client: AlpacaClient | null;
  try {
    client = await buildBrokerClient(cfg);
  } catch (e) {
    return { ok: false, configured: true, error: (e as Error).message };
  }
  if (!client) {
    await markBrokerNotConfigured();
    return { ok: false, configured: false, error: 'Alpaca keys not set' };
  }
  return { ...(await syncBroker(client)), configured: true };
}
