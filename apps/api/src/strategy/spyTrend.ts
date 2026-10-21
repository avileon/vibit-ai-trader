import { round2, sma, type DailyBar } from './indicators.js';

/**
 * spy-trend-v1 — the variant that won the pre-registered comparison (see backtest/compare.ts).
 * Rule: at the last COMPLETED daily close, SPY > SMA200 → hold SPY with up to `maxExposurePct` of virtual
 * equity; otherwise → cash. Pure function: same inputs → same decision. It only PROPOSES; RiskEngine approves.
 */
export const SPY_STRATEGY_VERSION = 'spy-trend-v1';
export const SPY_SMA = 200;
/** Top up / trim only when the holding drifts more than this from target (avoids daily churn). */
export const DRIFT = 0.1;
export const MIN_NOTIONAL = 1; // Alpaca minimum for fractional notional orders

export type SpyAction =
  | { kind: 'entry'; notional: number; partial: boolean }
  | { kind: 'exit'; qty: number; partial: boolean };

export interface SpyDecision {
  signal: 'in' | 'out' | 'unknown';
  close: number | null;
  sma200: number | null;
  targetUsd: number;
  heldValue: number;
  action: SpyAction | null;
  rationale: string[];
}

const floor2 = (n: number) => Math.floor(n * 100) / 100;
const floor9 = (n: number) => Math.floor(n * 1e9) / 1e9;

export function spyTrendDecision(a: {
  bars: DailyBar[]; // completed bars only
  heldQty: number;
  heldValue: number;
  virtualEquity: number;
  maxExposurePct: number;
  pendingOrder: boolean;
}): SpyDecision {
  const closes = a.bars.map((b) => b.c);
  const close = closes.at(-1) ?? null;
  const ma = sma(closes, SPY_SMA);
  const targetUsd = floor2(Math.max(0, a.virtualEquity) * (a.maxExposurePct / 100));
  const base = { close, sma200: ma == null ? null : round2(ma), targetUsd, heldValue: round2(a.heldValue) };
  if (close == null || ma == null) {
    return { ...base, signal: 'unknown', action: null, rationale: [`אין מספיק היסטוריה (${closes.length} ימים, נדרשים ${SPY_SMA})`] };
  }
  const signal = close > ma ? 'in' : 'out';
  const why = signal === 'in'
    ? `SPY נסגר ב-${close} מעל ממוצע 200 (${round2(ma)}) — מגמה עולה, מחזיקים`
    : `SPY נסגר ב-${close} מתחת לממוצע 200 (${round2(ma)}) — יוצאים למזומן`;
  if (a.pendingOrder) return { ...base, signal, action: null, rationale: [why, 'יש כבר הוראה פתוחה ל-SPY — ממתינים'] };

  if (signal === 'out') {
    if (a.heldQty <= 0) return { ...base, signal, action: null, rationale: [why, 'אין פוזיציה — נשארים במזומן'] };
    return { ...base, signal, action: { kind: 'exit', qty: floor9(a.heldQty), partial: false }, rationale: [why, 'מוכרים את כל הפוזיציה'] };
  }

  if (a.heldQty <= 0) {
    const n = floor2(targetUsd);
    if (n < MIN_NOTIONAL) return { ...base, signal, action: null, rationale: [why, `יעד $${n} קטן מהמינימום`] };
    return { ...base, signal, action: { kind: 'entry', notional: n, partial: false }, rationale: [why, `קונים SPY בסכום $${n} (${a.maxExposurePct}% מהשווי הווירטואלי)`] };
  }
  const gap = targetUsd - a.heldValue;
  if (gap > targetUsd * DRIFT && floor2(gap) >= MIN_NOTIONAL) {
    return { ...base, signal, action: { kind: 'entry', notional: floor2(gap), partial: true }, rationale: [why, `השלמה: מחזיקים $${round2(a.heldValue)} מתוך יעד $${targetUsd}`] };
  }
  if (-gap > targetUsd * DRIFT && a.heldValue > 0) {
    const qty = floor9(a.heldQty * (-gap / a.heldValue));
    if (qty > 0) return { ...base, signal, action: { kind: 'exit', qty, partial: true }, rationale: [why, `קיצוץ: מחזיקים $${round2(a.heldValue)} מעל יעד $${targetUsd}`] };
  }
  return { ...base, signal, action: null, rationale: [why, 'הפוזיציה כבר ביעד — אין פעולה'] };
}
