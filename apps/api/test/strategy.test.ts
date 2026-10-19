import { describe, expect, it } from 'vitest';
import { atr, completedBars, roc, sma, nyDate } from '../src/strategy/indicators.js';
import { runStrategy, type StrategyInput } from '../src/strategy/momentumTrend.js';
import { makeBars } from './fixtures.js';

const NOW = new Date('2026-10-20T14:30:00Z'); // Tue 10:30 NY

function input(over: Partial<StrategyInput> = {}): StrategyInput {
  return {
    bars: { UP: makeBars(260, 30, 0.002, NOW), DOWN: makeBars(260, 60, -0.002, NOW) },
    benchmarkBars: makeBars(260, 500, 0.001, NOW),
    positions: [], pendingEntrySymbols: [], riskBudgetUsd: 10, maxPositionUsd: 200, maxOpenPositions: 3, minPriceUsd: 5,
    ...over,
  };
}

describe('indicators', () => {
  it('sma / roc / atr basics', () => {
    expect(sma([1, 2, 3, 4], 2)).toBe(3.5);
    expect(sma([1], 2)).toBeNull();
    expect(roc([100, 110], 1)).toBeCloseTo(0.1);
    const bars = [{ t: '', o: 10, h: 11, l: 9, c: 10, v: 1 }, { t: '', o: 10, h: 12, l: 10, c: 11, v: 1 }, { t: '', o: 11, h: 11, l: 8, c: 9, v: 1 }];
    expect(atr(bars, 2)).toBeCloseTo((2 + 3) / 2);
  });
  it('completedBars drops today and future bars (no look-ahead)', () => {
    const bars = [
      { t: '2026-10-19T04:00:00Z', o: 1, h: 1, l: 1, c: 1, v: 1 },
      { t: '2026-10-20T04:00:00Z', o: 2, h: 2, l: 2, c: 2, v: 1 }, // today (partial)
      { t: '2026-10-21T04:00:00Z', o: 3, h: 3, l: 3, c: 3, v: 1 },
    ];
    expect(completedBars(bars, nyDate(NOW)).map((b) => b.c)).toEqual([1]);
  });
});

describe('momentum-trend-v1', () => {
  it('enters the uptrend, ignores the downtrend, sizes by risk budget', () => {
    const out = runStrategy(input());
    expect(out.regimeOk).toBe(true);
    const e = out.proposals.filter((p) => p.kind === 'entry');
    expect(e.map((p) => p.symbol)).toEqual(['UP']);
    const p = e[0];
    expect(p.stop).toBeLessThan(p.priceRef);
    expect(p.takeProfit).toBeGreaterThan(p.priceRef);
    expect((p.priceRef - p.stop!) * p.qty).toBeLessThanOrEqual(10.0001);
    expect(p.priceRef * p.qty).toBeLessThanOrEqual(200);
    expect(Number.isInteger(p.qty)).toBe(true);
    expect(p.rationale.reasons.length).toBeGreaterThan(2);
  });
  it('no entries when SPY regime is down', () => {
    const out = runStrategy(input({ benchmarkBars: makeBars(260, 500, -0.001, NOW) }));
    expect(out.regimeOk).toBe(false);
    expect(out.proposals.filter((p) => p.kind === 'entry')).toHaveLength(0);
  });
  it('skips names too expensive for one whole share within max position', () => {
    const out = runStrategy(input({ bars: { PRICEY: makeBars(260, 150, 0.002, NOW) } }));
    expect(out.proposals).toHaveLength(0);
    expect(out.skipped.find((s) => s.symbol === 'PRICEY')?.reason).toMatch(/יקרה/);
  });
  it('skips when even one share exceeds the risk budget', () => {
    const out = runStrategy(input({ riskBudgetUsd: 0.5 }));
    expect(out.proposals).toHaveLength(0);
    expect(out.skipped.some((s) => s.reason.includes('תקציב הסיכון'))).toBe(true);
  });
  it('respects free slots and pending entries', () => {
    const many = Object.fromEntries(['A', 'B', 'C', 'D'].map((s, i) => [s, makeBars(260, 20 + i, 0.002 + i * 0.0002, NOW)]));
    expect(runStrategy(input({ bars: many })).proposals).toHaveLength(3);
    expect(runStrategy(input({ bars: many, pendingEntrySymbols: ['X', 'Y'] })).proposals).toHaveLength(1);
    // ranked by momentum: D has highest drift
    expect(runStrategy(input({ bars: many })).proposals[0].symbol).toBe('D');
  });
  it('proposes an exit when the trend breaks', () => {
    const bars = makeBars(260, 50, 0.002, NOW);
    for (let i = 250; i < 260; i++) bars[i] = { ...bars[i], c: bars[i].c * 0.8, l: bars[i].l * 0.8 };
    const out = runStrategy(input({ bars: { UP: bars }, positions: [{ symbol: 'UP', qty: 2, avgEntry: 60, openedAt: new Date('2026-10-10') }] }));
    const exit = out.proposals.find((p) => p.kind === 'exit');
    expect(exit?.symbol).toBe('UP');
    expect(exit?.side).toBe('sell');
    expect(exit?.qty).toBe(2);
  });
  it('is deterministic', () => {
    expect(JSON.stringify(runStrategy(input()))).toBe(JSON.stringify(runStrategy(input())));
  });
});
