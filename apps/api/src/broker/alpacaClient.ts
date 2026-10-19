import { z } from 'zod';
import { ALPACA_DATA_URL, assertLooksLikePaperKey, assertPaperUrl, PaperGuardError } from '../lib/paperGuard.js';

/**
 * Read-only Alpaca PAPER client (phase C). Order submission is added in phase D, behind the RiskEngine.
 * - Constructor enforces the paper URL + paper-looking key.
 * - Every account response is re-checked: paper account numbers start with "PA".
 * - Timeouts, retry with backoff on 429 / 5xx / network errors.
 * - Keys are never logged or included in error messages.
 */

export type BrokerErrorKind = 'auth' | 'rate_limit' | 'network' | 'server' | 'bad_response' | 'not_paper' | 'client';
export class BrokerError extends Error {
  constructor(public kind: BrokerErrorKind, message: string, public status?: number) {
    super(message);
    this.name = 'BrokerError';
  }
}

const num = z.coerce.number();
const numN = z.union([z.coerce.number(), z.null()]).optional();

export const accountSchema = z.object({
  account_number: z.string(),
  status: z.string(),
  currency: z.string().optional(),
  cash: num,
  equity: num,
  last_equity: num,
  buying_power: num,
  long_market_value: num.optional().default(0),
  pattern_day_trader: z.boolean().optional(),
  daytrade_count: z.coerce.number().optional(),
  trading_blocked: z.boolean().optional(),
  account_blocked: z.boolean().optional(),
  multiplier: z.coerce.number().optional(),
  shorting_enabled: z.boolean().optional(),
}).passthrough();
export type AlpacaAccount = z.infer<typeof accountSchema>;

export const clockSchema = z.object({
  timestamp: z.string(),
  is_open: z.boolean(),
  next_open: z.string(),
  next_close: z.string(),
}).passthrough();
export type AlpacaClock = z.infer<typeof clockSchema>;

export const positionSchema = z.object({
  symbol: z.string(),
  qty: num,
  avg_entry_price: num,
  current_price: num,
  market_value: num,
  unrealized_pl: num,
  side: z.string(),
  asset_class: z.string().optional(),
}).passthrough();
export type AlpacaPosition = z.infer<typeof positionSchema>;

export const orderSchema: z.ZodType<any> = z.lazy(() => z.object({
  id: z.string(),
  client_order_id: z.string(),
  created_at: z.string().nullable().optional(),
  submitted_at: z.string().nullable().optional(),
  filled_at: z.string().nullable().optional(),
  canceled_at: z.string().nullable().optional(),
  symbol: z.string(),
  side: z.string(),
  type: z.string().nullable().optional(),
  order_type: z.string().nullable().optional(),
  order_class: z.string().nullable().optional(),
  time_in_force: z.string(),
  qty: numN,
  notional: numN,
  filled_qty: num,
  filled_avg_price: numN,
  limit_price: numN,
  stop_price: numN,
  status: z.string(),
  legs: z.array(orderSchema).nullable().optional(),
}).passthrough());
export type AlpacaOrder = {
  id: string; client_order_id: string; created_at?: string | null; submitted_at?: string | null; filled_at?: string | null;
  canceled_at?: string | null; symbol: string; side: string; type?: string | null; order_type?: string | null;
  order_class?: string | null; time_in_force: string; qty?: number | null; notional?: number | null; filled_qty: number;
  filled_avg_price?: number | null; limit_price?: number | null; stop_price?: number | null; status: string; legs?: AlpacaOrder[] | null;
};

export const portfolioHistorySchema = z.object({
  timestamp: z.array(z.number()),
  equity: z.array(z.number().nullable()),
  profit_loss: z.array(z.number().nullable()).optional(),
  base_value: z.number().nullable().optional(),
  timeframe: z.string().optional(),
}).passthrough();
export type PortfolioHistory = z.infer<typeof portfolioHistorySchema>;

export const barSchema = z.object({ t: z.string(), o: z.number(), h: z.number(), l: z.number(), c: z.number(), v: z.number() }).passthrough();
export type Bar = z.infer<typeof barSchema>;
const snapshotsSchema = z.record(z.object({
  latestQuote: z.object({ ap: z.number(), bp: z.number(), t: z.string() }).passthrough().nullable().optional(),
  latestTrade: z.object({ p: z.number(), t: z.string() }).passthrough().nullable().optional(),
}).passthrough().nullable());
const barsResponseSchema = z.object({ bars: z.record(z.array(barSchema)).nullable(), next_page_token: z.string().nullable().optional() }).passthrough();

export interface NewOrder {
  symbol: string;
  qty: number;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  time_in_force: 'day' | 'gtc';
  limit_price?: number;
  order_class?: 'bracket';
  take_profit?: { limit_price: number };
  stop_loss?: { stop_price: number };
  client_order_id: string;
}

export interface Quote { symbol: string; bid: number; ask: number; ts: Date; last: number | null }

export interface BrokerTrader extends BrokerReader {
  getBarsMulti(symbols: string[], start: string): Promise<Record<string, Bar[]>>;
  getQuotes(symbols: string[]): Promise<Record<string, Quote>>;
  submitOrder(o: NewOrder): Promise<AlpacaOrder>;
  getOrderByClientId(clientOrderId: string): Promise<AlpacaOrder | null>;
  cancelOrder(id: string): Promise<void>;
  closeAllPositions(): Promise<void>;
}

export interface BrokerReader {
  getAccount(): Promise<AlpacaAccount>;
  getClock(): Promise<AlpacaClock>;
  getPositions(): Promise<AlpacaPosition[]>;
  getOrders(params: { after?: string; limit?: number }): Promise<AlpacaOrder[]>;
  getPortfolioHistory(period: string, timeframe: string): Promise<PortfolioHistory>;
  getDailyBars(symbol: string, start: string): Promise<Bar[]>;
}

export interface AlpacaClientOptions {
  keyId: string;
  secretKey: string;
  baseUrl?: string;
  dataUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  feed?: 'iex' | 'sip';
}

export function assertPaperAccount(acct: { account_number: string }): void {
  if (!acct.account_number?.startsWith('PA')) {
    throw new BrokerError('not_paper', 'Account number does not look like a PAPER account (expected prefix PA). Refusing.');
  }
}

export class AlpacaClient implements BrokerTrader {
  private base: string;
  private data: string;
  private f: typeof fetch;
  private timeoutMs: number;
  private maxRetries: number;
  private sleep: (ms: number) => Promise<void>;
  private headers: Record<string, string>;
  private feed: 'iex' | 'sip';
  public requestCount = 0;

  constructor(o: AlpacaClientOptions) {
    const url = assertPaperUrl(o.baseUrl ?? 'https://paper-api.alpaca.markets');
    assertLooksLikePaperKey(o.keyId);
    if (!o.keyId || !o.secretKey) throw new PaperGuardError('Missing Alpaca keys');
    this.base = url.origin;
    this.data = o.dataUrl ?? ALPACA_DATA_URL;
    if (new URL(this.data).hostname !== 'data.alpaca.markets') throw new PaperGuardError('Unexpected data URL');
    this.f = o.fetchImpl ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.maxRetries = o.maxRetries ?? 3;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.headers = { 'APCA-API-KEY-ID': o.keyId, 'APCA-API-SECRET-KEY': o.secretKey, accept: 'application/json' };
    this.feed = o.feed ?? 'iex';
  }

  /**
   * GET requests retry on 429/5xx/network. Mutating requests (POST/DELETE) NEVER auto-retry —
   * the executor resolves ambiguity by looking the order up by client_order_id (idempotency).
   */
  private async request(url: string, init: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown } = {}): Promise<unknown> {
    const method = init.method ?? 'GET';
    const retries = method === 'GET' ? this.maxRetries : 0;
    let attempt = 0;
    for (;;) {
      attempt++;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      let res: Response;
      try {
        this.requestCount++;
        res = await this.f(url, {
          method, signal: ctrl.signal,
          headers: init.body !== undefined ? { ...this.headers, 'content-type': 'application/json' } : this.headers,
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        });
      } catch (e) {
        clearTimeout(timer);
        if (attempt <= retries) { await this.sleep(this.backoff(attempt)); continue; }
        throw new BrokerError('network', `Network error calling ${new URL(url).pathname}: ${(e as Error).name}`);
      }
      clearTimeout(timer);
      if (res.ok) {
        if (res.status === 204) return null;
        try { return await res.json(); } catch { throw new BrokerError('bad_response', `Invalid JSON from ${new URL(url).pathname}`); }
      }
      const path = new URL(url).pathname;
      if (res.status === 401 || res.status === 403) throw new BrokerError('auth', `Alpaca rejected the keys (${res.status}) on ${path}`, res.status);
      if (res.status === 429) {
        if (attempt <= retries) {
          const reset = Number(res.headers.get('x-ratelimit-reset'));
          const wait = reset > 0 ? Math.min(60_000, Math.max(1000, reset * 1000 - Date.now())) : this.backoff(attempt);
          await this.sleep(wait); continue;
        }
        throw new BrokerError('rate_limit', `Rate limited on ${path}`, 429);
      }
      if (res.status >= 500) {
        if (attempt <= retries) { await this.sleep(this.backoff(attempt)); continue; }
        throw new BrokerError('server', `Alpaca server error ${res.status} on ${path}`, res.status);
      }
      const text = (await res.text().catch(() => '')).slice(0, 200);
      throw new BrokerError('client', `Alpaca ${res.status} on ${path}: ${text}`, res.status);
    }
  }

  private backoff(attempt: number): number {
    return Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 200);
  }

  private parse<S extends z.ZodTypeAny>(schema: S, data: unknown, what: string): z.output<S> {
    const r = schema.safeParse(data);
    if (!r.success) throw new BrokerError('bad_response', `Unexpected ${what} response: ${r.error.issues.slice(0, 3).map((i) => i.path.join('.')).join(', ')}`);
    return r.data;
  }

  async getAccount() {
    const a = this.parse(accountSchema, await this.request(`${this.base}/v2/account`), 'account');
    assertPaperAccount(a);
    return a;
  }
  async getClock() {
    return this.parse(clockSchema, await this.request(`${this.base}/v2/clock`), 'clock');
  }
  async getPositions() {
    return this.parse(z.array(positionSchema), await this.request(`${this.base}/v2/positions`), 'positions');
  }
  async getOrders({ after, limit = 500 }: { after?: string; limit?: number }) {
    const q = new URLSearchParams({ status: 'all', limit: String(Math.min(limit, 500)), nested: 'true', direction: 'desc' });
    if (after) q.set('after', after);
    return this.parse(z.array(orderSchema), await this.request(`${this.base}/v2/orders?${q}`), 'orders') as AlpacaOrder[];
  }
  async getPortfolioHistory(period = '1M', timeframe = '1D') {
    const q = new URLSearchParams({ period, timeframe });
    return this.parse(portfolioHistorySchema, await this.request(`${this.base}/v2/account/portfolio/history?${q}`), 'portfolio history');
  }
  async getDailyBars(symbol: string, start: string) {
    const q = new URLSearchParams({ symbols: symbol, timeframe: '1Day', start, feed: this.feed, adjustment: 'all', limit: '1000' });
    const r = this.parse(barsResponseSchema, await this.request(`${this.data}/v2/stocks/bars?${q}`), 'bars');
    return r.bars?.[symbol] ?? [];
  }

  async getBarsMulti(symbols: string[], start: string): Promise<Record<string, Bar[]>> {
    const out: Record<string, Bar[]> = {};
    let pageToken: string | null | undefined;
    let pages = 0;
    do {
      const q = new URLSearchParams({ symbols: symbols.join(','), timeframe: '1Day', start, feed: this.feed, adjustment: 'all', limit: '10000' });
      if (pageToken) q.set('page_token', pageToken);
      const r = this.parse(barsResponseSchema, await this.request(`${this.data}/v2/stocks/bars?${q}`), 'bars');
      for (const [sym, arr] of Object.entries(r.bars ?? {})) (out[sym] ??= []).push(...arr);
      pageToken = r.next_page_token;
      if (++pages > 50) throw new BrokerError('bad_response', 'Too many bar pages');
    } while (pageToken);
    return out;
  }

  async getQuotes(symbols: string[]): Promise<Record<string, Quote>> {
    const q = new URLSearchParams({ symbols: symbols.join(','), feed: this.feed });
    const raw = this.parse(snapshotsSchema, await this.request(`${this.data}/v2/stocks/snapshots?${q}`), 'snapshots');
    const out: Record<string, Quote> = {};
    for (const [sym, s] of Object.entries(raw)) {
      if (!s?.latestQuote) continue;
      out[sym] = { symbol: sym, bid: s.latestQuote.bp, ask: s.latestQuote.ap, ts: new Date(s.latestQuote.t), last: s.latestTrade?.p ?? null };
    }
    return out;
  }

  async submitOrder(o: NewOrder): Promise<AlpacaOrder> {
    if (o.side === 'sell' && o.order_class === 'bracket') throw new BrokerError('client', 'Bracket sell (short) is not allowed');
    return this.parse(orderSchema, await this.request(`${this.base}/v2/orders`, { method: 'POST', body: o }), 'order') as AlpacaOrder;
  }

  async getOrderByClientId(clientOrderId: string): Promise<AlpacaOrder | null> {
    try {
      const q = new URLSearchParams({ client_order_id: clientOrderId, nested: 'true' });
      return this.parse(orderSchema, await this.request(`${this.base}/v2/orders:by_client_order_id?${q}`), 'order') as AlpacaOrder;
    } catch (e) {
      if (e instanceof BrokerError && e.status === 404) return null;
      throw e;
    }
  }

  async cancelOrder(id: string): Promise<void> {
    try {
      await this.request(`${this.base}/v2/orders/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (e) {
      if (e instanceof BrokerError && (e.status === 404 || e.status === 422)) return; // already gone / not cancelable
      throw e;
    }
  }

  async closeAllPositions(): Promise<void> {
    await this.request(`${this.base}/v2/positions?cancel_orders=true`, { method: 'DELETE' });
  }
}
