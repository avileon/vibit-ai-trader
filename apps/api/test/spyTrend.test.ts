import { describe, expect, it } from 'vitest';
import { evaluateOrder, type OrderIntent, type RiskContext } from '../src/risk/riskEngine.js';
import { DEFAULT_RISK_LIMITS, riskLimitsSchema, type RiskLimits } from '../src/riskConfig.js';
import { spyTrendDecision } from '../src/strategy/spyTrend.js';
import { makeBars } from './fixtures.js';

const END = new Date('2026-10-19T20:00:00Z');
const up = makeBars(260, 400, 0.002, END);
const down = makeBars(260, 700, -0.002, END);
const base = { heldQty: 0, heldValue: 0, virtualEquity: 1000, maxExposurePct: 100, pendingOrder: false };

describe('spy-trend-v1 decision', () => {
  it('buys the full target when above SMA200 and flat', () => {
    const d = spyTrendDecision({ ...base, bars: up });
    expect(d.signal).toBe('in');
    expect(d.action).toEqual({ kind: 'entry', notional: 1000, partial: false });
  });
  it('sells everything when below SMA200', () => {
    const d = spyTrendDecision({ ...base, bars: down, heldQty: 1.523456789, heldValue: 1000 });
    expect(d.signal).toBe('out');
    expect(d.action).toEqual({ kind: 'exit', qty: 1.523456789, partial: false });
  });
  it('stays in cash below SMA200 with no position', () => {
    expect(spyTrendDecision({ ...base, bars: down }).action).toBeNull();
  });
  it('does nothing when within drift band, tops up / trims outside it', () => {
    expect(spyTrendDecision({ ...base, bars: up, heldQty: 1.5, heldValue: 950 }).action).toBeNull();
    expect(spyTrendDecision({ ...base, bars: up, heldQty: 1, heldValue: 600 }).action).toEqual({ kind: 'entry', notional: 400, partial: true });
    const t = spyTrendDecision({ ...base, bars: up, heldQty: 2, heldValue: 1200, virtualEquity: 1000, maxExposurePct: 60 });
    expect(t.action?.kind).toBe('exit');
    expect((t.action as { qty: number }).qty).toBeCloseTo(1, 6);
  });
  it('waits while an order is pending and refuses on short history', () => {
    expect(spyTrendDecision({ ...base, bars: up, pendingOrder: true }).action).toBeNull();
    expect(spyTrendDecision({ ...base, bars: up.slice(-150) }).signal).toBe('unknown');
  });
  it('sizes on VIRTUAL equity, never on the $100k paper balance', () => {
    expect(spyTrendDecision({ ...base, bars: up, virtualEquity: 1043.57 }).action).toEqual({ kind: 'entry', notional: 1043.57, partial: false });
  });
});

const NOW = new Date('2026-10-20T14:30:00Z');
const APPROVED: RiskLimits = { ...DEFAULT_RISK_LIMITS, allocation: { maxExposurePct: 100, fractional: true, symbols: ['SPY'] } };
const buy: OrderIntent = { kind: 'entry', style: 'allocation', symbol: 'SPY', side: 'buy', notional: 1000, qty: 1.5, limitPrice: null, stopPrice: null, takeProfit: null };
const sell: OrderIntent = { kind: 'exit', style: 'allocation', symbol: 'SPY', side: 'sell', qty: 1.5, limitPrice: null, stopPrice: null, takeProfit: null };
function ctx(over: Partial<RiskContext> = {}): RiskContext {
  return {
    now: NOW, limits: APPROVED, universe: new Set(['SPY']), botMode: 'ACTIVE', killSwitch: false, brokerStatus: 'ok',
    lastSyncAt: new Date(NOW.getTime() - 30_000), clock: { isOpen: true, nextClose: new Date('2026-10-20T20:00:00Z') },
    quote: { bid: 666.9, ask: 667, ts: new Date(NOW.getTime() - 5000) }, positions: [], openOrders: [],
    account: { cash: 100_000, equity: 100_000 }, virtualEquity: 1000, dailyPl: 0, ...over,
  };
}

describe('RiskEngine — allocation orders', () => {
  it('approves a clean SPY buy and a clean full sell', () => {
    expect(evaluateOrder(buy, ctx()).failed).toEqual([]);
    expect(evaluateOrder(sell, ctx({ positions: [{ symbol: 'SPY', qty: 1.5, marketValue: 1000 }] })).failed).toEqual([]);
  });
  it.each([
    ['mode_active', buy, ctx({ botMode: 'SAFE' })],
    ['kill_switch_off', buy, ctx({ killSwitch: true })],
    ['market_open', buy, ctx({ clock: { isOpen: false, nextClose: new Date('2026-10-20T20:00:00Z') } })],
    ['asset_allowed', { ...buy, symbol: 'TQQQ' }, ctx()],
    ['market_order_day', { ...buy, limitPrice: 667 }, ctx()],
    ['notional_valid', { ...buy, notional: 0.5 }, ctx()],
    ['fractional_allowed', buy, ctx({ limits: DEFAULT_RISK_LIMITS })],
    ['total_exposure', { ...buy, notional: 1000.5 }, ctx()],
    ['total_exposure', buy, ctx({ positions: [{ symbol: 'SPY', qty: 0.1, marketValue: 66.7 }] })],
    ['total_exposure', buy, ctx({ openOrders: [{ symbol: 'SPY', side: 'buy', notional: 500, kind: 'other' }] })],
    ['spread_ok', buy, ctx({ quote: { bid: 660, ask: 667, ts: NOW } })],
    ['daily_loss', buy, ctx({ dailyPl: -25 })],
    ['drawdown', buy, ctx({ virtualEquity: 949 })],
    ['long_only', sell, ctx()],
    ['long_only', sell, ctx({ positions: [{ symbol: 'SPY', qty: 1, marketValue: 667 }] })],
    ['no_duplicate', buy, ctx({ openOrders: [{ symbol: 'SPY', side: 'buy', notional: 0, kind: 'entry' }] })],
  ] as const)('blocks on %s', (id, o, c) => {
    expect(evaluateOrder(o as OrderIntent, c).failed).toContain(id);
  });
  it('old stored limit versions (no allocation block) parse to the conservative default', () => {
    const { allocation, ...old } = APPROVED;
    expect(riskLimitsSchema.parse(old).allocation).toEqual({ maxExposurePct: 60, fractional: false, symbols: ['SPY'] });
  });
});
