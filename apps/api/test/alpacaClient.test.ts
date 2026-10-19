import { describe, expect, it } from 'vitest';
import { AlpacaClient, BrokerError } from '../src/broker/alpacaClient.js';
import { PaperGuardError } from '../src/lib/paperGuard.js';

const KEY = 'PKTESTKEY123456', SECRET = 'supersecretvalue123456';
type Resp = { status: number; body?: unknown; headers?: Record<string, string> };
function fakeFetch(seq: (Resp | Error)[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    const r = seq.shift();
    if (!r) throw new Error('no more responses');
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const acct = { account_number: 'PA123', status: 'ACTIVE', cash: '1000', equity: '1000', last_equity: '1000', buying_power: '1000', long_market_value: '0' };
const mk = (seq: (Resp | Error)[]) => { const { f, calls } = fakeFetch(seq); return { c: new AlpacaClient({ keyId: KEY, secretKey: SECRET, fetchImpl: f, sleep: async () => {} }), calls }; };

describe('AlpacaClient', () => {
  it('refuses live URL and live-looking keys', () => {
    expect(() => new AlpacaClient({ keyId: KEY, secretKey: SECRET, baseUrl: 'https://api.alpaca.markets' })).toThrow(PaperGuardError);
    expect(() => new AlpacaClient({ keyId: 'AKLIVE123456', secretKey: SECRET })).toThrow(PaperGuardError);
  });
  it('sends auth headers to the paper host and coerces numeric strings', async () => {
    const { c, calls } = mk([{ status: 200, body: acct }]);
    const a = await c.getAccount();
    expect(a.equity).toBe(1000);
    expect(calls[0].url).toBe('https://paper-api.alpaca.markets/v2/account');
    expect(calls[0].headers['APCA-API-KEY-ID']).toBe(KEY);
  });
  it('rejects a non-paper account number', async () => {
    const { c } = mk([{ status: 200, body: { ...acct, account_number: '123456' } }]);
    await expect(c.getAccount()).rejects.toMatchObject({ kind: 'not_paper' });
  });
  it('retries 5xx and network errors, then succeeds', async () => {
    const { c, calls } = mk([{ status: 502 }, new TypeError('fetch failed'), { status: 200, body: acct }]);
    await c.getAccount();
    expect(calls.length).toBe(3);
  });
  it('gives up after max retries on 429', async () => {
    const { c, calls } = mk([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }]);
    await expect(c.getAccount()).rejects.toMatchObject({ kind: 'rate_limit' });
    expect(calls.length).toBe(4);
  });
  it('does not retry auth errors and never leaks keys in messages', async () => {
    const { c, calls } = mk([{ status: 401, body: { message: 'forbidden' } }]);
    const e = await c.getAccount().catch((x) => x) as BrokerError;
    expect(e.kind).toBe('auth');
    expect(calls.length).toBe(1);
    expect(e.message).not.toContain(KEY);
    expect(e.message).not.toContain(SECRET);
  });
  it('flags malformed responses', async () => {
    const { c } = mk([{ status: 200, body: { hello: 'world' } }]);
    await expect(c.getClock()).rejects.toMatchObject({ kind: 'bad_response' });
  });
  it('requests orders with status=all&nested=true and parses legs', async () => {
    const { c, calls } = mk([{ status: 200, body: [{ id: '1', client_order_id: 'x', symbol: 'SPY', side: 'buy', type: 'limit', time_in_force: 'gtc', qty: '1', filled_qty: '0', status: 'new', legs: [{ id: '2', client_order_id: 'y', symbol: 'SPY', side: 'sell', type: 'stop', time_in_force: 'gtc', qty: '1', filled_qty: '0', stop_price: '90', status: 'held' }] }] }]);
    const o = await c.getOrders({});
    expect(calls[0].url).toContain('status=all');
    expect(calls[0].url).toContain('nested=true');
    expect(o[0].legs![0].stop_price).toBe(90);
  });
  it('reads daily bars from the IEX feed on the data host', async () => {
    const { c, calls } = mk([{ status: 200, body: { bars: { SPY: [{ t: '2026-10-16T04:00:00Z', o: 1, h: 2, l: 1, c: 2, v: 10 }] }, next_page_token: null } }]);
    const b = await c.getDailyBars('SPY', '2026-10-01');
    expect(b[0].c).toBe(2);
    expect(calls[0].url).toMatch(/^https:\/\/data\.alpaca\.markets\/v2\/stocks\/bars\?.*feed=iex/);
  });
});
