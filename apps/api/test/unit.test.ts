import { describe, expect, it } from 'vitest';
import { assertPaperEnvironment, assertPaperUrl, assertLooksLikePaperKey, PaperGuardError } from '../src/lib/paperGuard.js';
import { decryptSecret, encryptSecret, hashPassword, maskSecret, parseMasterKey, verifyPassword } from '../src/lib/crypto.js';
import { estimateMarketSession } from '../src/lib/marketHours.js';
import { DEFAULT_RISK_LIMITS, killSwitchThreshold, riskBudgetPerTrade, riskLimitsSchema } from '../src/riskConfig.js';
import { loadConfig } from '../src/config.js';

const KEY_B64 = Buffer.alloc(32, 7).toString('base64');

describe('paper guard', () => {
  it('accepts the paper endpoint', () => {
    expect(() => assertPaperEnvironment({ TRADING_MODE: 'paper', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets' })).not.toThrow();
  });
  it('rejects live mode', () => {
    expect(() => assertPaperEnvironment({ TRADING_MODE: 'live' })).toThrow(PaperGuardError);
    expect(() => assertPaperEnvironment({})).toThrow(PaperGuardError);
  });
  it.each([
    'https://api.alpaca.markets',
    'http://paper-api.alpaca.markets',
    'https://paper-api.alpaca.markets.evil.com',
    'https://user:pw@paper-api.alpaca.markets',
    'https://paper-api.alpaca.markets:8443',
    'not a url',
  ])('rejects %s', (u) => {
    expect(() => assertPaperUrl(u)).toThrow(PaperGuardError);
  });
  it('rejects live-looking key ids', () => {
    expect(() => assertLooksLikePaperKey('AKXXXXXXXXXXXX')).toThrow(PaperGuardError);
    expect(() => assertLooksLikePaperKey('PKXXXXXXXXXXXX')).not.toThrow();
  });
  it('config loader refuses to start in live mode', () => {
    expect(() => loadConfig({ TRADING_MODE: 'live', DATABASE_URL: 'mysql://a:b@c/d', MASTER_KEY: KEY_B64 } as NodeJS.ProcessEnv)).toThrow(PaperGuardError);
    expect(() => loadConfig({ TRADING_MODE: 'paper', ALPACA_BASE_URL: 'https://api.alpaca.markets', DATABASE_URL: 'mysql://a:b@c/d', MASTER_KEY: KEY_B64 } as NodeJS.ProcessEnv)).toThrow(PaperGuardError);
    const cfg = loadConfig({ TRADING_MODE: 'paper', DATABASE_URL: 'mysql://a:b@c/d', MASTER_KEY: KEY_B64 } as NodeJS.ProcessEnv);
    expect(cfg.ALPACA_BASE_URL).toBe('https://paper-api.alpaca.markets');
  });
});

describe('crypto', () => {
  const key = parseMasterKey(KEY_B64);
  it('round-trips secrets and never returns plaintext in payload', () => {
    const enc = encryptSecret('PKSECRET1234567890', key);
    expect(enc).not.toContain('PKSECRET');
    expect(decryptSecret(enc, key)).toBe('PKSECRET1234567890');
  });
  it('detects tampering', () => {
    const enc = encryptSecret('hello world', key).split(':');
    enc[3] = Buffer.from('tampered!!!').toString('base64');
    expect(() => decryptSecret(enc.join(':'), key)).toThrow();
  });
  it('rejects short master key', () => {
    expect(() => parseMasterKey(Buffer.alloc(16).toString('base64'))).toThrow();
  });
  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
  it('masks secrets', () => {
    expect(maskSecret('PK1234567890ABCD')).toBe('PK…ABCD');
  });
});

describe('market hours (estimate)', () => {
  it('open on a weekday 10:00 NY (14:00 UTC in summer)', () => {
    expect(estimateMarketSession(new Date('2026-07-15T14:00:00Z')).isOpen).toBe(true);
  });
  it('closed on weekend', () => {
    expect(estimateMarketSession(new Date('2026-07-18T15:00:00Z')).isOpen).toBe(false);
  });
  it('closed before 9:30 NY', () => {
    expect(estimateMarketSession(new Date('2026-07-15T13:00:00Z')).isOpen).toBe(false);
  });
  it('handles winter DST (EST): 9:30 NY = 14:30 UTC', () => {
    expect(estimateMarketSession(new Date('2026-12-02T14:29:00Z')).isOpen).toBe(false);
    expect(estimateMarketSession(new Date('2026-12-02T14:31:00Z')).isOpen).toBe(true);
  });
  it('labels itself an estimate', () => {
    expect(estimateMarketSession().source).toBe('estimate');
  });
});

describe('risk config', () => {
  it('defaults are valid and conservative', () => {
    expect(riskLimitsSchema.parse(DEFAULT_RISK_LIMITS)).toBeTruthy();
    expect(killSwitchThreshold(DEFAULT_RISK_LIMITS)).toBe(950);
    expect(riskBudgetPerTrade(DEFAULT_RISK_LIMITS, 1000)).toBe(10);
  });
  it('uses capital base even if paper account is $100k', () => {
    expect(riskBudgetPerTrade(DEFAULT_RISK_LIMITS, 100_000)).toBe(10);
  });
  it('shrinks risk budget after losses', () => {
    expect(riskBudgetPerTrade(DEFAULT_RISK_LIMITS, 960)).toBe(9.6);
  });
  it('cannot enable shorting/margin via schema', () => {
    expect(() => riskLimitsSchema.parse({ ...DEFAULT_RISK_LIMITS, allowShort: true })).toThrow();
    expect(() => riskLimitsSchema.parse({ ...DEFAULT_RISK_LIMITS, allowMargin: true })).toThrow();
  });
});
