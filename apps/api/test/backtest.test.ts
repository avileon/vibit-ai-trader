import { describe, expect, it } from 'vitest';
import { runBacktest, type BacktestConfig } from '../src/backtest/engine.js';
import { curveMetrics, tradeMetrics, monthlyReturns } from '../src/backtest/metrics.js';
import { walkForward, splitSegments } from '../src/backtest/report.js';
import { roundTrips } from '../src/reports/live.js';
import { DEFAULT_RISK_LIMITS } from '../src/riskConfig.js';
import { STRATEGY_PARAMS } from '../src/strategy/momentumTrend.js';
import type { DailyBar } from '../src/strategy/indicators.js';
import { makeBars } from './fixtures.js';

const END = new Date('2026-06-01T12:00:00Z');
function data(): Record<string, DailyBar[]> {
  return { SPY: makeBars(700, 300, 0.0006, END), UP: makeBars(700, 20, 0.0015, END, 0.01), FLAT: makeBars(700, 50, -0.0005, END) };
}
const cfg = (bars: Record<string, DailyBar[]>, over: Partial<BacktestConfig> = {}): BacktestConfig => ({
  start: bars.SPY[300].t.slice(0, 10), end: bars.SPY.at(-1)!.t.slice(0, 10), capital: 1000, limits: DEFAULT_RISK_LIMITS,
  params: STRATEGY_PARAMS, slippageBps: 5, feePerOrder: 0.02, maxChase: 0.02, universe: ['UP', 'FLAT'], benchmark: 'SPY', haltOnDrawdown: true, ...over,
});
const d = (b: DailyBar) => b.t.slice(0, 10);

describe('backtest engine', () => {
  it('fills entries at the NEXT open (+slippage), never at the decision close', () => {
    const bars = data();
    const res = runBacktest(bars, cfg(bars));
    expect(res.trades.length).toBeGreaterThan(0);
    const t = res.trades[0];
    const bar = bars.UP.find((b) => d(b) === t.entryDate)!;
    expect(t.entryPrice).toBeCloseTo(bar.o * 1.0005, 2);
    expect(t.entryDate > cfg(bars).start).toBe(true);
  });

  it('no data leakage: changing FUTURE bars does not change past equity', () => {
    const a = data(), b = data();
    const cut = 500;
    for (const s of Object.keys(b)) for (let i = cut + 1; i < b[s].length; i++) b[s][i] = { ...b[s][i], o: b[s][i].o * 3, h: b[s][i].h * 3, l: b[s][i].l * 0.2, c: b[s][i].c * 0.5 };
    const ra = runBacktest(a, cfg(a)), rb = runBacktest(b, cfg(b));
    const cutDay = d(a.SPY[cut]);
    const pa = ra.equity.filter((p) => p.d <= cutDay), pb = rb.equity.filter((p) => p.d <= cutDay);
    expect(pb).toEqual(pa);
  });

  it('a gap below the stop exits at the OPEN (loss larger than planned)', () => {
    const bars = data();
    const first = runBacktest(bars, cfg(bars)).trades[0];
    const i = bars.UP.findIndex((b) => d(b) === first.entryDate);
    const gapDay = bars.UP[i + 2];
    bars.UP[i + 2] = { ...gapDay, o: first.stop * 0.9, h: first.stop * 0.92, l: first.stop * 0.85, c: first.stop * 0.9 };
    const t = runBacktest(bars, cfg(bars)).trades[0];
    expect(t.reason).toBe('gap_stop');
    expect(t.exitPrice).toBeLessThan(first.stop);
    expect(t.r).toBeLessThan(-1); // worse than the planned 1R loss
  });

  it('stop and target on the same day → assumes the stop (conservative)', () => {
    const bars = data();
    const first = runBacktest(bars, cfg(bars)).trades[0];
    const i = bars.UP.findIndex((b) => d(b) === first.entryDate);
    const b1 = bars.UP[i + 1];
    bars.UP[i + 1] = { ...b1, o: (first.stop + first.target) / 2, h: first.target * 1.01, l: first.stop * 0.99 };
    expect(runBacktest(bars, cfg(bars)).trades[0].reason).toBe('stop');
  });

  it('respects risk limits on every trade', () => {
    const bars = data();
    const res = runBacktest(bars, cfg(bars));
    for (const t of res.trades) {
      expect(Number.isInteger(t.qty)).toBe(true);
      expect(t.qty * t.entryPrice).toBeLessThanOrEqual(200.01);
      expect(t.qty * (t.entryPrice - t.stop)).toBeLessThanOrEqual(10.6); // ≤1% of equity (equity can grow above $1000 → capped at base)
    }
    for (const p of res.equity) expect(p.exposure).toBeLessThanOrEqual(600 * 1.5); // MTM can drift above entry cost
  });

  it('halts new entries after the 5% drawdown', () => {
    const bars = data();
    // crash UP hard after some trades
    for (let i = 450; i < bars.UP.length; i++) bars.UP[i] = { ...bars.UP[i], o: bars.UP[i].o * 0.5, h: bars.UP[i].h * 0.5, l: bars.UP[i].l * 0.5, c: bars.UP[i].c * 0.5 };
    const res = runBacktest(bars, cfg(bars, { limits: { ...DEFAULT_RISK_LIMITS, killSwitchDrawdownPct: 0.5 } }));
    expect(res.haltedOn).not.toBeNull();
    expect(res.trades.every((t) => t.entryDate <= res.haltedOn!)).toBe(true);
  });
});

describe('metrics', () => {
  it('max drawdown, returns, sharpe gate', () => {
    const m = curveMetrics([100, 120, 90, 130], ['2020-01-01', '2020-01-02', '2020-01-03', '2020-01-04']);
    expect(m.maxDrawdownPct).toBe(25);
    expect(m.totalReturnPct).toBe(30);
    expect(m.sharpe).toBeNull(); // < 60 points
  });
  it('trade stats', () => {
    const t = tradeMetrics([10, -5, 20, -5]);
    expect(t.winRatePct).toBe(50);
    expect(t.profitFactor).toBe(3);
    expect(t.expectancy).toBe(5);
  });
  it('monthly returns', () => {
    const m = monthlyReturns([{ d: '2020-01-02', equity: 100 }, { d: '2020-01-31', equity: 110 }, { d: '2020-02-28', equity: 99 }]);
    expect(m).toEqual([{ month: '2020-01', pct: 10 }, { month: '2020-02', pct: -10 }]);
  });
});

describe('splits & walk-forward', () => {
  it('splits 60/20/20 and walk-forward produces out-of-sample windows', () => {
    const bars = data();
    const c = cfg(bars, { start: d(bars.SPY[260]) });
    const segs = splitSegments(runBacktest(bars, c).equity);
    expect(segs.map((s) => s.name)).toHaveLength(3);
    const wf = walkForward(bars, c, 6, 3);
    expect(wf.windows.length).toBeGreaterThan(0);
    for (const w of wf.windows) expect(w.testFrom >= w.trainTo).toBe(true);
    expect(typeof wf.stitched.optimizedPct).toBe('number');
  });
});

describe('live round trips (FIFO)', () => {
  it('matches sells to the oldest buys', () => {
    const t = roundTrips([
      { symbol: 'X', side: 'buy', qty: 2, price: 10, at: '2026-01-01' },
      { symbol: 'X', side: 'buy', qty: 2, price: 12, at: '2026-01-02' },
      { symbol: 'X', side: 'sell', qty: 3, price: 11, at: '2026-01-03' },
    ]);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ qty: 2, pnl: 2 });
    expect(t[1]).toMatchObject({ qty: 1, pnl: -1 });
  });
});
