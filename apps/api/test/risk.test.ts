import { describe, expect, it } from 'vitest';
import { evaluateOrder, type OrderIntent, type RiskContext } from '../src/risk/riskEngine.js';
import { DEFAULT_RISK_LIMITS } from '../src/riskConfig.js';

const NOW = new Date('2026-10-20T14:30:00Z'); // 10:30 NY
const entry: OrderIntent = { kind: 'entry', symbol: 'XLF', side: 'buy', qty: 4, limitPrice: 45, stopPrice: 43, takeProfit: 49 };
function ctx(over: Partial<RiskContext> = {}): RiskContext {
  return {
    now: NOW, limits: DEFAULT_RISK_LIMITS, universe: new Set(['XLF', 'XLE']), botMode: 'ACTIVE', killSwitch: false, brokerStatus: 'ok',
    lastSyncAt: new Date(NOW.getTime() - 30_000), clock: { isOpen: true, nextClose: new Date('2026-10-20T20:00:00Z') },
    quote: { bid: 44.97, ask: 45, ts: new Date(NOW.getTime() - 5000) }, positions: [], openOrders: [],
    account: { cash: 100_000, equity: 100_000 }, virtualEquity: 1000, dailyPl: 0, ...over,
  };
}
const failed = (o: OrderIntent, c: RiskContext) => evaluateOrder(o, c).failed;

describe('RiskEngine', () => {
  it('approves a clean entry and reports every check', () => {
    const d = evaluateOrder(entry, ctx());
    expect(d.failed).toEqual([]);
    expect(d.approved).toBe(true);
    expect(d.checks.length).toBeGreaterThan(15);
  });
  it.each([
    ['mode_active', ctx({ botMode: 'SAFE' })],
    ['kill_switch_off', ctx({ killSwitch: true })],
    ['broker_ok', ctx({ brokerStatus: 'error' })],
    ['sync_fresh', ctx({ lastSyncAt: new Date(NOW.getTime() - 10 * 60_000) })],
    ['market_open', ctx({ clock: { isOpen: false, nextClose: new Date('2026-10-20T20:00:00Z') } })],
    ['not_open_close_window', ctx({ now: new Date('2026-10-20T13:35:00Z'), lastSyncAt: new Date('2026-10-20T13:34:50Z'), quote: { bid: 44.97, ask: 45, ts: new Date('2026-10-20T13:34:58Z') } })],
    ['quote_fresh', ctx({ quote: { bid: 44.97, ask: 45, ts: new Date(NOW.getTime() - 120_000) } })],
    ['quote_valid', ctx({ quote: { bid: 46, ask: 45, ts: NOW } })],
    ['spread_ok', ctx({ quote: { bid: 44, ask: 45, ts: NOW } })],
    ['total_exposure', ctx({ positions: [{ symbol: 'XLE', qty: 5, marketValue: 450 }] })],
    ['max_positions', ctx({ positions: ['A', 'B', 'C'].map((s) => ({ symbol: s, qty: 1, marketValue: 10 })) })],
    ['not_already_holding', ctx({ positions: [{ symbol: 'XLF', qty: 1, marketValue: 45 }] })],
    ['no_duplicate', ctx({ openOrders: [{ symbol: 'XLF', side: 'buy', notional: 180, kind: 'entry' }] })],
    ['cash_no_margin', ctx({ account: { cash: 100, equity: 100_000 } })],
    ['daily_loss', ctx({ dailyPl: -25 })],
    ['drawdown', ctx({ virtualEquity: 949 })],
  ] as const)('blocks on %s', (id, c) => {
    expect(failed(entry, c)).toContain(id);
  });
  it('blocks entries outside the approved universe', () => {
    expect(failed({ ...entry, symbol: 'GME' }, ctx())).toContain('asset_allowed');
  });
  it('blocks oversize risk and position', () => {
    expect(failed({ ...entry, qty: 6 }, ctx())).toContain('risk_per_trade'); // (45-43)*6 = 12 > 10
    expect(failed({ ...entry, qty: 5, stopPrice: 44.5 }, ctx())).toContain('position_size'); // 225 > 200
  });
  it('blocks entries without a valid stop / target, fractional qty, market entries, shorts', () => {
    expect(failed({ ...entry, stopPrice: null }, ctx())).toContain('exit_defined');
    expect(failed({ ...entry, stopPrice: 46 }, ctx())).toContain('exit_defined');
    expect(failed({ ...entry, qty: 1.5 }, ctx())).toContain('whole_shares');
    expect(failed({ ...entry, limitPrice: null }, ctx())).toContain('limit_order');
    expect(failed({ ...entry, side: 'sell' }, ctx())).toContain('long_only');
  });
  it('allows an exit only for shares actually held (no shorting)', () => {
    const exit: OrderIntent = { kind: 'exit', symbol: 'XLF', side: 'sell', qty: 4, limitPrice: null, stopPrice: null, takeProfit: null };
    expect(failed(exit, ctx())).toContain('long_only');
    expect(evaluateOrder(exit, ctx({ positions: [{ symbol: 'XLF', qty: 4, marketValue: 180 }] })).approved).toBe(true);
    expect(failed({ ...exit, qty: 5 }, ctx({ positions: [{ symbol: 'XLF', qty: 4, marketValue: 180 }] }))).toContain('long_only');
  });
  it('a drawdown does not block protective exits', () => {
    const exit: OrderIntent = { kind: 'exit', symbol: 'XLF', side: 'sell', qty: 4, limitPrice: null, stopPrice: null, takeProfit: null };
    expect(evaluateOrder(exit, ctx({ virtualEquity: 900, dailyPl: -50, positions: [{ symbol: 'XLF', qty: 4, marketValue: 180 }] })).approved).toBe(true);
  });
});
