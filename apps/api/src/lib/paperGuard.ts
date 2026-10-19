/**
 * PAPER-ONLY GUARD — חסימה טכנית של מסחר אמיתי.
 * כל קוד שמתחבר לברוקר חייב לעבור דרך assertPaperEnvironment().
 * שינוי הקובץ הזה כדי לאפשר Live אסור בגרסה 1.
 */
export const ALPACA_PAPER_TRADING_URL = 'https://paper-api.alpaca.markets';
export const ALPACA_LIVE_TRADING_HOST = 'api.alpaca.markets';
export const ALPACA_DATA_URL = 'https://data.alpaca.markets';

export class PaperGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaperGuardError';
  }
}

export interface BrokerEnv {
  [k: string]: string | undefined;
  TRADING_MODE?: string;
  ALPACA_BASE_URL?: string;
}

export function assertPaperEnvironment(env: BrokerEnv): void {
  if (env.TRADING_MODE !== 'paper') {
    throw new PaperGuardError(
      `TRADING_MODE must be "paper" (got "${env.TRADING_MODE ?? ''}"). Live trading is disabled in v1.`,
    );
  }
  const raw = env.ALPACA_BASE_URL ?? ALPACA_PAPER_TRADING_URL;
  assertPaperUrl(raw);
}

export function assertPaperUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PaperGuardError(`Invalid broker URL: ${raw}`);
  }
  if (url.protocol !== 'https:') throw new PaperGuardError('Broker URL must use HTTPS');
  if (url.hostname === ALPACA_LIVE_TRADING_HOST) {
    throw new PaperGuardError('LIVE Alpaca endpoint is blocked. Use paper-api.alpaca.markets');
  }
  if (url.hostname !== new URL(ALPACA_PAPER_TRADING_URL).hostname) {
    throw new PaperGuardError(`Only ${ALPACA_PAPER_TRADING_URL} is allowed (got ${url.hostname})`);
  }
  if (url.username || url.password || (url.port && url.port !== '443')) {
    throw new PaperGuardError('Broker URL must not contain credentials or custom ports');
  }
  return url;
}

/**
 * Alpaca Paper keys usually start with "PK"; live keys with "AK".
 * זו בדיקה הגנתית נוספת בלבד — הבדיקה המכרעת היא ה-URL וקריאה ל-/v2/account בשלב ג.
 */
export function assertLooksLikePaperKey(keyId: string): void {
  if (keyId.startsWith('AK')) {
    throw new PaperGuardError('This looks like a LIVE key (prefix AK). Use Paper keys only.');
  }
}
