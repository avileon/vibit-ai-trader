import { atr, avgDollarVolume, roc, round2, sma, type DailyBar } from './indicators.js';

/**
 * Strategy v1 — "Momentum + Trend filter" (long only, daily bars, swing horizon).
 * Fully deterministic. Uses only COMPLETED daily bars (caller must pass completedBars()).
 *
 * Regime:   SPY close > SPY SMA200, otherwise no new entries.
 * Entry:    close > SMA50 > SMA200 (and close > SMA200) and 6-month momentum (ROC126) > 0.
 *           close > SMA50 is required so an entry never immediately satisfies the exit rule.
 *           Rank by ROC126, fill free slots only.
 * Stop:     entry − 2 × ATR14     Take-profit: entry + 4 × ATR14 (≈ 2R)
 * Size:     floor(min(riskBudget / (entry − stop), maxPositionUsd / entry)) whole shares.
 * Exit:     close < SMA50 (trend broken) or held ≥ 30 sessions. The bracket stop / target live at the broker.
 */
export const STRATEGY_VERSION = 'momentum-trend-v1';

export const STRATEGY_PARAMS: Readonly<{
  smaFast: number; smaSlow: number; momentumLookback: number; atrPeriod: number; stopAtr: number; targetAtr: number;
  maxHoldSessions: number; minBars: number; minIexDollarVolume: number;
}> = {
  smaFast: 50,
  smaSlow: 200,
  momentumLookback: 126,
  atrPeriod: 14,
  stopAtr: 2,
  targetAtr: 4,
  maxHoldSessions: 30,
  minBars: 210,
  minIexDollarVolume: 1_000_000, // IEX-only volume is a small slice of total volume — proxy threshold
};
export type StrategyParams = typeof STRATEGY_PARAMS;

export interface StrategyPosition { symbol: string; qty: number; avgEntry: number; openedAt: Date }

export interface StrategyInput {
  bars: Record<string, DailyBar[]>; // completed bars, oldest → newest
  benchmarkBars: DailyBar[];
  positions: StrategyPosition[];
  pendingEntrySymbols: string[]; // open entry orders not yet filled
  riskBudgetUsd: number;
  maxPositionUsd: number;
  maxOpenPositions: number;
  minPriceUsd: number;
}

export interface Proposal {
  kind: 'entry' | 'exit';
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  priceRef: number;
  stop: number | null;
  takeProfit: number | null;
  rationale: { reasons: string[]; metrics: Record<string, number | null> };
  strategyVersion: string;
}

export interface Skipped { symbol: string; reason: string }

export interface StrategyOutput {
  regimeOk: boolean;
  regime: { spyClose: number | null; spySma200: number | null };
  proposals: Proposal[];
  skipped: Skipped[];
  ranked: { symbol: string; roc126: number }[];
}

export function runStrategy(input: StrategyInput, P: StrategyParams = STRATEGY_PARAMS): StrategyOutput {
  const spyCloses = input.benchmarkBars.map((b) => b.c);
  const spyClose = spyCloses.at(-1) ?? null;
  const spySma200 = sma(spyCloses, P.smaSlow);
  const regimeOk = spyClose != null && spySma200 != null && spyClose > spySma200;
  const proposals: Proposal[] = [];
  const skipped: Skipped[] = [];

  // ---- exits first
  for (const pos of input.positions) {
    const bars = input.bars[pos.symbol];
    if (!bars?.length) { skipped.push({ symbol: pos.symbol, reason: 'אין נתוני מחיר לפוזיציה — לא מחליטים על יציאה בלי נתונים' }); continue; }
    const closes = bars.map((b) => b.c);
    const close = closes.at(-1)!;
    const sma50 = sma(closes, P.smaFast);
    const held = bars.filter((b) => new Date(b.t) >= startOfDay(pos.openedAt)).length;
    const reasons: string[] = [];
    if (sma50 != null && close < sma50) reasons.push(`המחיר (${close}) ירד מתחת לממוצע 50 (${round2(sma50)}) — המגמה נשברה`);
    if (held >= P.maxHoldSessions) reasons.push(`הוחזקה ${held} ימי מסחר (מקסימום ${P.maxHoldSessions})`);
    if (reasons.length) {
      proposals.push({
        kind: 'exit', symbol: pos.symbol, side: 'sell', qty: pos.qty, priceRef: close, stop: null, takeProfit: null,
        rationale: { reasons, metrics: { close, sma50: sma50 && round2(sma50), heldSessions: held, avgEntry: pos.avgEntry } },
        strategyVersion: STRATEGY_VERSION,
      });
    }
  }

  // ---- entries
  const held = new Set([...input.positions.map((p) => p.symbol), ...input.pendingEntrySymbols]);
  // exits free a slot only after they fill (next cycle) — conservative
  let slots = input.maxOpenPositions - input.positions.length - input.pendingEntrySymbols.length;
  const ranked: { symbol: string; roc126: number; close: number; sma50: number; sma200: number; atr14: number; adv: number }[] = [];

  if (!regimeOk) {
    skipped.push({ symbol: 'SPY', reason: 'מצב שוק: SPY מתחת לממוצע 200 — לא פותחים עסקאות חדשות' });
  } else {
    for (const [symbol, bars] of Object.entries(input.bars)) {
      if (held.has(symbol)) continue;
      if (bars.length < P.minBars) { skipped.push({ symbol, reason: `מעט מדי היסטוריה (${bars.length} ימים)` }); continue; }
      const closes = bars.map((b) => b.c);
      const close = closes.at(-1)!;
      const s50 = sma(closes, P.smaFast)!, s200 = sma(closes, P.smaSlow)!, m = roc(closes, P.momentumLookback)!;
      const a = atr(bars, P.atrPeriod)!, adv = avgDollarVolume(bars, 20)!;
      if (close < input.minPriceUsd) { skipped.push({ symbol, reason: `מחיר נמוך מ-$${input.minPriceUsd}` }); continue; }
      if (close > input.maxPositionUsd) { skipped.push({ symbol, reason: `מניה אחת ($${close}) יקרה מגודל פוזיציה מקסימלי ($${input.maxPositionUsd})` }); continue; }
      if (adv < P.minIexDollarVolume) { skipped.push({ symbol, reason: 'מחזור מסחר נמוך מדי (לפי IEX)' }); continue; }
      if (!(close > s50 && close > s200 && s50 > s200)) continue; // not in uptrend — silent. close > SMA50 keeps entry consistent with the exit rule
      if (!(m > 0)) continue;
      ranked.push({ symbol, roc126: m, close, sma50: s50, sma200: s200, atr14: a, adv });
    }
    ranked.sort((x, y) => y.roc126 - x.roc126);
    for (const c of ranked) {
      if (slots <= 0) break;
      const stop = round2(c.close - P.stopAtr * c.atr14);
      const target = round2(c.close + P.targetAtr * c.atr14);
      const riskPerShare = c.close - stop;
      if (riskPerShare <= 0 || stop <= 0) { skipped.push({ symbol: c.symbol, reason: 'סטופ לא תקין' }); continue; }
      const qty = Math.floor(Math.min(input.riskBudgetUsd / riskPerShare, input.maxPositionUsd / c.close));
      if (qty < 1) {
        skipped.push({ symbol: c.symbol, reason: `גם מניה אחת מסכנת $${round2(riskPerShare)} — יותר מתקציב הסיכון $${input.riskBudgetUsd}` });
        continue;
      }
      proposals.push({
        kind: 'entry', symbol: c.symbol, side: 'buy', qty, priceRef: c.close, stop, takeProfit: target,
        rationale: {
          reasons: [
            `מגמה עולה: מחיר ${c.close} מעל ממוצע 50 (${round2(c.sma50)}) ומעל ממוצע 200 (${round2(c.sma200)}), וממוצע 50 מעל ממוצע 200`,
            `מומנטום 6 חודשים: ${(c.roc126 * 100).toFixed(1)}% (מקום ${ranked.indexOf(c) + 1} מתוך ${ranked.length} מועמדים)`,
            `סטופ = מחיר − 2×ATR (${round2(c.atr14)}) = ${stop}; יעד = מחיר + 4×ATR = ${target}`,
            `כמות ${qty}: סיכון מתוכנן $${round2(qty * riskPerShare)} (תקציב $${input.riskBudgetUsd}), שווי $${round2(qty * c.close)}`,
          ],
          metrics: { close: c.close, sma50: round2(c.sma50), sma200: round2(c.sma200), roc126: round2(c.roc126 * 100), atr14: round2(c.atr14), iexDollarVolume: Math.round(c.adv) },
        },
        strategyVersion: STRATEGY_VERSION,
      });
      slots--;
    }
  }
  return { regimeOk, regime: { spyClose, spySma200: spySma200 && round2(spySma200) }, proposals, skipped, ranked: ranked.map((r) => ({ symbol: r.symbol, roc126: round2(r.roc126 * 100) })) };
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}
