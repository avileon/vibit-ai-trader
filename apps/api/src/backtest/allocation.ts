import { roc, sma, type DailyBar } from '../strategy/indicators.js';
import type { EquityPoint, Trade } from './engine.js';

/**
 * Portfolio-allocation backtester (target weights, periodic rebalance) for research variants
 * like "SPY trend filter" and "sector rotation". Same timing rule as the main engine:
 * signal computed at the CLOSE of day t from bars ≤ t, executed at the OPEN of t+1.
 * Fractional shares are allowed here (Alpaca supports fractional market DAY orders; these
 * strategies need no broker-side bracket, so the whole-share constraint does not apply).
 */
export interface AllocConfig {
  start: string; end: string; capital: number;
  slippageBps: number; feePerOrder: number;
  benchmark: string;
  maxGrossExposure: number; // 0..1 of equity
  maxWeightPerAsset: number; // 0..1
  rebalance: 'on_change' | 'monthly';
  fractional: boolean;
}

export type Signal = (ctx: { i: number; date: string; closes: (s: string, n: number) => number[] | null }) => Record<string, number>;

const day = (t: string) => t.slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;

export function runAllocation(bars: Record<string, DailyBar[]>, cfg: AllocConfig, signal: Signal) {
  const bench = bars[cfg.benchmark] ?? [];
  const cal = bench.map((b) => day(b.t));
  const idx: Record<string, Map<string, number>> = {};
  for (const [s, a] of Object.entries(bars)) idx[s] = new Map(a.map((b, i) => [day(b.t), i]));
  const barOn = (s: string, d: string) => { const i = idx[s]?.get(d); return i == null ? null : bars[s][i]; };
  const slip = cfg.slippageBps / 10_000;

  let cash = cfg.capital;
  const pos: Record<string, { qty: number; cost: number; since: string }> = {};
  const equity: EquityPoint[] = [];
  const trades: Trade[] = [];
  let target: Record<string, number> | null = null;
  let lastKey = '';
  const first = cal.findIndex((d) => d >= cfg.start);
  if (first < 0) return { equity, trades };
  const benchStart = bench[first].o;

  for (let i = first; i < cal.length && cal[i] <= cfg.end; i++) {
    const d = cal[i];
    // ---- OPEN: rebalance toward target
    if (target) {
      const px = (s: string) => barOn(s, d)?.o ?? null;
      const eqOpen = cash + Object.entries(pos).reduce((a, [s, p]) => a + p.qty * (px(s) ?? p.cost), 0);
      const want: Record<string, number> = {};
      for (const [s, w] of Object.entries(target)) {
        const p = px(s); if (!p) continue;
        const raw = (eqOpen * w) / (p * (1 + slip));
        want[s] = cfg.fractional ? Math.floor(raw * 1000) / 1000 : Math.floor(raw);
      }
      // sells first
      for (const [s, p] of Object.entries(pos)) {
        const w = want[s] ?? 0;
        if (p.qty > w + 1e-9) {
          const price = px(s); if (!price) continue;
          const q = p.qty - w;
          const fill = price * (1 - slip);
          cash += q * fill - cfg.feePerOrder;
          const pnl = r2(q * (fill - p.cost) - cfg.feePerOrder);
          trades.push({ symbol: s, qty: r2(q), entryDate: p.since, entryPrice: r2(p.cost), stop: 0, target: 0, exitDate: d, exitPrice: r2(fill), reason: 'trend', pnl, r: 0 });
          p.qty = w;
          if (p.qty <= 1e-9) delete pos[s];
        }
      }
      for (const [s, w] of Object.entries(want)) {
        const have = pos[s]?.qty ?? 0;
        if (w > have + 1e-9) {
          const price = px(s)!; const fill = price * (1 + slip);
          let q = w - have;
          if (q * fill + cfg.feePerOrder > cash) q = cfg.fractional ? Math.floor(((cash - cfg.feePerOrder) / fill) * 1000) / 1000 : Math.floor((cash - cfg.feePerOrder) / fill);
          if (q <= 0) continue;
          cash -= q * fill + cfg.feePerOrder;
          const p = pos[s] ?? (pos[s] = { qty: 0, cost: 0, since: d });
          p.cost = (p.cost * p.qty + fill * q) / (p.qty + q);
          p.qty += q;
        }
      }
      target = null;
    }
    // ---- CLOSE: mark to market
    const mv = Object.entries(pos).reduce((a, [s, p]) => a + p.qty * (barOn(s, d)?.c ?? p.cost), 0);
    equity.push({ d, equity: r2(cash + mv), bench: r2(cfg.capital * (bench[i].c / benchStart)), exposure: r2(mv) });
    // ---- SIGNAL for tomorrow
    if (i + 1 >= cal.length || cal[i + 1] > cfg.end) break;
    const monthEnd = cal[i + 1].slice(0, 7) !== d.slice(0, 7);
    if (cfg.rebalance === 'monthly' && !monthEnd && i !== first) continue;
    const closes = (s: string, n: number) => {
      const j = idx[s]?.get(d); if (j == null || j + 1 < n) return null;
      return bars[s].slice(j + 1 - n, j + 1).map((b) => b.c);
    };
    let w = signal({ i, date: d, closes });
    // caps
    for (const s of Object.keys(w)) w[s] = Math.min(w[s], cfg.maxWeightPerAsset);
    const gross = Object.values(w).reduce((a, b) => a + b, 0);
    if (gross > cfg.maxGrossExposure) w = Object.fromEntries(Object.entries(w).map(([s, x]) => [s, (x * cfg.maxGrossExposure) / gross]));
    const key = JSON.stringify(Object.entries(w).filter(([, x]) => x > 0).map(([s]) => s).sort());
    // on_change: act when holdings change, and at month-end to trim drift back under the exposure cap
    if (cfg.rebalance === 'on_change' && key === lastKey && !monthEnd) continue;
    lastKey = key;
    target = w;
  }
  return { equity, trades };
}

/** Hold SPY while close > SMA200, otherwise cash. */
export const spyTrendSignal = (sym = 'SPY'): Signal => ({ closes }) => {
  const c = closes(sym, 200);
  if (!c) return {};
  const ma = sma(c, 200)!;
  return { [sym]: c.at(-1)! > ma ? 1 : 0 };
};

/** Monthly: top-N sectors by 6-month momentum, each only if above its SMA200 (else that slot stays in cash). */
export const sectorRotationSignal = (sectors: string[], topN = 3): Signal => ({ closes }) => {
  const scored: { s: string; m: number }[] = [];
  for (const s of sectors) {
    const c = closes(s, 200);
    if (!c) continue;
    const m = roc(c, 126);
    if (m == null || c.at(-1)! <= sma(c, 200)!) continue;
    scored.push({ s, m });
  }
  scored.sort((a, b) => b.m - a.m);
  const w: Record<string, number> = {};
  for (const x of scored.slice(0, topN)) if (x.m > 0) w[x.s] = 1 / topN;
  return w;
};

export const SECTORS = ['XLB', 'XLC', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLRE', 'XLU', 'XLV', 'XLY'];
