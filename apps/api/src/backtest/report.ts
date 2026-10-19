import { runBacktest, type BacktestConfig, type BacktestResult, type EquityPoint } from './engine.js';
import { curveMetrics, monthlyReturns, tradeMetrics, type Metrics } from './metrics.js';
import type { DailyBar } from '../strategy/indicators.js';
import { STRATEGY_PARAMS, type StrategyParams } from '../strategy/momentumTrend.js';

export interface SegmentReport { name: string; from: string; to: string; strategy: Metrics; benchmark: Metrics }

export function summarize(res: BacktestResult) {
  const eq = res.equity;
  const strat = { ...curveMetrics(eq.map((p) => p.equity), eq.map((p) => p.d)), ...tradeMetrics(res.trades.map((t) => t.pnl)) };
  strat.exposurePct = eq.length ? Math.round((eq.filter((p) => p.exposure > 0).length / eq.length) * 1000) / 10 : 0;
  const bench = curveMetrics(eq.map((p) => p.bench), eq.map((p) => p.d));
  return { strategy: strat, benchmark: bench };
}

/** Train / validation / test = 60 / 20 / 20 % of the period (by trading days). Params are NOT fitted on any of them. */
export function splitSegments(eq: EquityPoint[]): SegmentReport[] {
  const n = eq.length;
  const cuts = [0, Math.floor(n * 0.6), Math.floor(n * 0.8), n];
  const names = ['Train (60%)', 'Validation (20%)', 'Test / Out-of-Sample (20%)'];
  return names.map((name, k) => {
    const seg = eq.slice(cuts[k], cuts[k + 1]);
    return {
      name, from: seg[0]?.d ?? '', to: seg.at(-1)?.d ?? '',
      strategy: curveMetrics(seg.map((p) => p.equity), seg.map((p) => p.d)),
      benchmark: curveMetrics(seg.map((p) => p.bench), seg.map((p) => p.d)),
    };
  }).filter((s) => s.from);
}

export const WF_GRID: Partial<StrategyParams>[] = [];
for (const stopAtr of [1.5, 2, 3]) for (const momentumLookback of [63, 126, 252]) WF_GRID.push({ stopAtr, momentumLookback });

function addMonths(d: string, m: number): string {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCMonth(x.getUTCMonth() + m);
  return x.toISOString().slice(0, 10);
}

export interface WalkForwardWindow {
  trainFrom: string; trainTo: string; testFrom: string; testTo: string;
  chosen: Partial<StrategyParams>; trainSharpe: number | null;
  testReturnPct: number; testReturnDefaultPct: number; testBenchPct: number;
}

/**
 * Walk-forward: for each window, choose the grid params with the best TRAIN Sharpe (return as tie-break),
 * then measure them on the following, unseen TEST window. Stitched test results = honest out-of-sample estimate.
 */
export function walkForward(bars: Record<string, DailyBar[]>, base: BacktestConfig, trainMonths = 24, testMonths = 6, onProgress?: (s: string) => void) {
  const windows: WalkForwardWindow[] = [];
  let trainFrom = base.start;
  while (true) {
    const trainTo = addMonths(trainFrom, trainMonths);
    const testTo = addMonths(trainTo, testMonths);
    if (trainTo >= base.end) break;
    let best: { p: Partial<StrategyParams>; sharpe: number; ret: number } | null = null;
    for (const p of WF_GRID) {
      const res = runBacktest(bars, { ...base, start: trainFrom, end: trainTo, params: { ...STRATEGY_PARAMS, ...p }, haltOnDrawdown: false });
      const m = curveMetrics(res.equity.map((e) => e.equity), res.equity.map((e) => e.d));
      const s = m.sharpe ?? -99;
      if (!best || s > best.sharpe || (s === best.sharpe && m.totalReturnPct > best.ret)) best = { p, sharpe: s, ret: m.totalReturnPct };
    }
    const end = testTo < base.end ? testTo : base.end;
    const test = runBacktest(bars, { ...base, start: trainTo, end, params: { ...STRATEGY_PARAMS, ...best!.p }, haltOnDrawdown: false });
    const testDefault = runBacktest(bars, { ...base, start: trainTo, end, params: base.params, haltOnDrawdown: false });
    const tm = curveMetrics(test.equity.map((e) => e.equity), test.equity.map((e) => e.d));
    const dm = curveMetrics(testDefault.equity.map((e) => e.equity), testDefault.equity.map((e) => e.d));
    const bm = curveMetrics(test.equity.map((e) => e.bench), test.equity.map((e) => e.d));
    windows.push({ trainFrom, trainTo, testFrom: trainTo, testTo: end, chosen: best!.p, trainSharpe: best!.sharpe === -99 ? null : best!.sharpe,
      testReturnPct: tm.totalReturnPct, testReturnDefaultPct: dm.totalReturnPct, testBenchPct: bm.totalReturnPct });
    onProgress?.(`walk-forward ${windows.length}: test ${trainTo}→${end}`);
    if (end >= base.end) break;
    trainFrom = addMonths(trainFrom, testMonths);
  }
  const compound = (xs: number[]) => Math.round((xs.reduce((a, x) => a * (1 + x / 100), 1) - 1) * 10000) / 100;
  return {
    windows,
    stitched: {
      optimizedPct: compound(windows.map((w) => w.testReturnPct)),
      defaultPct: compound(windows.map((w) => w.testReturnDefaultPct)),
      benchmarkPct: compound(windows.map((w) => w.testBenchPct)),
      windowsBeatingBenchmark: windows.filter((w) => w.testReturnPct > w.testBenchPct).length,
    },
  };
}

export function fullReport(bars: Record<string, DailyBar[]>, cfg: BacktestConfig, withWalkForward: boolean, onProgress?: (s: string) => void) {
  const res = runBacktest(bars, cfg);
  onProgress?.('main backtest done');
  const sum = summarize(res);
  const reasons: Record<string, number> = {};
  for (const t of res.trades) reasons[t.reason] = (reasons[t.reason] ?? 0) + 1;
  // thin the curve for the UI (max ~400 points)
  const step = Math.max(1, Math.ceil(res.equity.length / 400));
  return {
    summary: { ...sum, haltedOn: res.haltedOn, exitReasons: reasons, skippedEntries: res.skippedEntries.length },
    segments: splitSegments(res.equity),
    monthly: monthlyReturns(res.equity),
    walkForward: withWalkForward ? walkForward(bars, cfg, 24, 6, onProgress) : null,
    curve: res.equity.filter((_, i) => i % step === 0 || i === res.equity.length - 1).map((p) => ({ t: p.d, equity: p.equity, spy: p.bench })),
    trades: res.trades,
  };
}
