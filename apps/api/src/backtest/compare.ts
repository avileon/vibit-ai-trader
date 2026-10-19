import type { RiskLimits } from '../riskConfig.js';
import { STRATEGY_PARAMS } from '../strategy/momentumTrend.js';
import type { DailyBar } from '../strategy/indicators.js';
import { runAllocation, sectorRotationSignal, spyTrendSignal, SECTORS } from './allocation.js';
import { runBacktest, type EquityPoint, type Trade } from './engine.js';
import { curveMetrics, tradeMetrics } from './metrics.js';

/**
 * Pre-registered comparison of a FIXED, small set of hypotheses (to limit data-mining / multiple-testing bias).
 * Development period = start → (end − 2y). Hold-out = the last 2 years, reported separately and never used to choose.
 */
export interface CompareOpts { start: string; end: string; capital: number; limits: RiskLimits; slippageBps: number; feePerOrder: number; universe: string[]; benchmark: string }

export const VARIANTS = [
  { id: 'v1', name: 'Momentum + מגמה v1 (נוכחי)', desc: 'האסטרטגיה הפעילה: עד 3 מניות, סטופ 2×ATR, יעד 4×ATR, מניות שלמות, במגבלות הסיכון.' },
  { id: 'v1_no_target', name: 'v1 בלי יעד רווח', desc: 'כמו v1, אבל בלי יעד קבוע — מחזיקים כל עוד המגמה נמשכת (יציאה בסטופ / שבירת ממוצע 50 / 30 ימים).' },
  { id: 'spy_trend_limits', name: 'SPY + פילטר מגמה (60% חשיפה)', desc: 'מחזיקים SPY כשהוא מעל ממוצע 200, אחרת מזומן. מוגבל ל-60% מההון (כמו מגבלת החשיפה הנוכחית). מניות חלקיות.' },
  { id: 'spy_trend_full', name: 'SPY + פילטר מגמה (100%)', desc: 'אותו דבר, עם כל ההון. דורש לשנות את מגבלת החשיפה.' },
  { id: 'sectors_limits', name: 'רוטציית סקטורים (60% חשיפה)', desc: 'בסוף כל חודש: 3 הסקטורים עם המומנטום החזק (רק מעל ממוצע 200), משקל שווה, מוגבל ל-60%.' },
  { id: 'sectors_full', name: 'רוטציית סקטורים (100%)', desc: 'אותו דבר, עם כל ההון.' },
] as const;

function addYears(d: string, y: number) { const x = new Date(`${d}T00:00:00Z`); x.setUTCFullYear(x.getUTCFullYear() + y); return x.toISOString().slice(0, 10); }

function evaluate(eq: EquityPoint[], trades: Trade[], holdoutStart: string) {
  const seg = (pts: EquityPoint[]) => ({
    strategy: curveMetrics(pts.map((p) => p.equity), pts.map((p) => p.d)),
    benchmark: curveMetrics(pts.map((p) => p.bench), pts.map((p) => p.d)),
  });
  const dev = eq.filter((p) => p.d < holdoutStart), hold = eq.filter((p) => p.d >= holdoutStart);
  const step = Math.max(1, Math.ceil(eq.length / 300));
  return {
    full: { ...seg(eq), trades: tradeMetrics(trades.map((t) => t.pnl)) },
    development: seg(dev),
    holdout: seg(hold),
    avgMonthlyUsd: eq.length > 1 ? Math.round(((eq.at(-1)!.equity - eq[0].equity) / Math.max(1, eq.length / 21)) * 100) / 100 : 0,
    curve: eq.filter((_, i) => i % step === 0 || i === eq.length - 1).map((p) => ({ t: p.d, equity: p.equity, spy: p.bench })),
  };
}

export function runCompare(bars: Record<string, DailyBar[]>, o: CompareOpts, onProgress?: (s: string) => void) {
  const holdoutStart = addYears(o.end, -2);
  const base = { start: o.start, end: o.end, capital: o.capital, limits: o.limits, slippageBps: o.slippageBps, feePerOrder: o.feePerOrder,
    maxChase: 0.02, universe: o.universe, benchmark: o.benchmark, haltOnDrawdown: false };
  const alloc = (gross: number, maxW: number, rebalance: 'on_change' | 'monthly') =>
    ({ start: o.start, end: o.end, capital: o.capital, slippageBps: o.slippageBps, feePerOrder: o.feePerOrder, benchmark: o.benchmark,
      maxGrossExposure: gross, maxWeightPerAsset: maxW, rebalance, fractional: true });
  const lim = o.limits.maxTotalExposurePct / 100;
  const out: Record<string, ReturnType<typeof evaluate>> = {};
  const run = (id: string, fn: () => { equity: EquityPoint[]; trades: Trade[] }) => { onProgress?.(`משווה: ${id}`); const r = fn(); out[id] = evaluate(r.equity, r.trades, holdoutStart); };

  run('v1', () => runBacktest(bars, { ...base, params: STRATEGY_PARAMS }));
  run('v1_no_target', () => runBacktest(bars, { ...base, params: { ...STRATEGY_PARAMS, targetAtr: 1000 } }));
  run('spy_trend_limits', () => runAllocation(bars, alloc(lim, lim, 'on_change'), spyTrendSignal(o.benchmark)));
  run('spy_trend_full', () => runAllocation(bars, alloc(1, 1, 'on_change'), spyTrendSignal(o.benchmark)));
  run('sectors_limits', () => runAllocation(bars, alloc(lim, lim / 3, 'monthly'), sectorRotationSignal(SECTORS)));
  run('sectors_full', () => runAllocation(bars, alloc(1, 1 / 3, 'monthly'), sectorRotationSignal(SECTORS)));

  return {
    holdoutStart,
    variants: VARIANTS.map((v) => ({ ...v, ...out[v.id] })),
    notes: [
      'רשימת ההשערות נקבעה מראש (6 גרסאות) כדי לצמצם "חיפוש עד שמוצאים" (Data mining).',
      `תקופת Hold-out: ${holdoutStart} → ${o.end}. לא משמשת לבחירה — רק לאימות סופי.`,
      'אסטרטגיות ההקצאה (SPY / סקטורים) משתמשות במניות חלקיות ובפקודות Market בפתיחה, ללא סטופ אצל הברוקר — ההגנה היא פילטר המגמה, לא סטופ.',
      'הטיית שרידות: רשימת הנכסים נבחרה היום.',
    ],
  };
}
