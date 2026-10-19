import type { RiskLimits } from '../riskConfig.js';
import { runStrategy, type StrategyParams } from '../strategy/momentumTrend.js';
import type { DailyBar } from '../strategy/indicators.js';

/**
 * Daily event-driven backtester that reuses the LIVE strategy code (runStrategy) — one source of truth.
 *
 * Timing (no look-ahead):
 *   decision at the CLOSE of day t, using bars ≤ t  →  orders fill at the OPEN of day t+1.
 *   (The live engine decides at 10:00 NY with bars ≤ yesterday and fills around 10:00 — same information set.)
 * Fills:
 *   entry   = open × (1 + slippage); skipped if open > reference close × (1 + maxChase) ("ran away").
 *   stop    = if open ≤ stop → open (gap through the stop!) else stop; minus slippage.
 *   target  = if open ≥ target → open else target (limit order, no slippage).
 *   stop and target touched the same day → assume the STOP (conservative).
 * Risk rules mirrored from the live RiskEngine: whole shares, risk budget, max position, max exposure,
 * max open positions, cash only, daily-loss pause, 5% drawdown halt.
 */

export interface BacktestConfig {
  start: string; // first trading day to simulate (YYYY-MM-DD)
  end: string;
  capital: number;
  limits: RiskLimits;
  params: StrategyParams;
  slippageBps: number; // per side
  feePerOrder: number; // USD per order (regulatory fees etc.)
  maxChase: number; // 0.02
  universe: string[];
  benchmark: string;
  haltOnDrawdown: boolean;
}

export interface Trade {
  symbol: string; qty: number; entryDate: string; entryPrice: number; stop: number; target: number;
  exitDate: string; exitPrice: number; reason: 'stop' | 'target' | 'trend' | 'max_hold' | 'gap_stop' | 'end';
  pnl: number; r: number;
}

export interface EquityPoint { d: string; equity: number; bench: number; exposure: number }

export interface BacktestResult {
  equity: EquityPoint[];
  trades: Trade[];
  haltedOn: string | null;
  skippedEntries: { d: string; symbol: string; reason: string }[];
}

interface OpenPos { symbol: string; qty: number; entryDate: string; entryPrice: number; stop: number; target: number; risk: number; sessions: number }
interface Pending { kind: 'entry' | 'exit'; symbol: string; priceRef: number; stop?: number; target?: number; reason?: Trade['reason'] }

const day = (t: string) => t.slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;

export function runBacktest(allBars: Record<string, DailyBar[]>, cfg: BacktestConfig): BacktestResult {
  const L = cfg.limits;
  const slip = cfg.slippageBps / 10_000;
  const benchBars = allBars[cfg.benchmark] ?? [];
  const calendar = benchBars.map((b) => day(b.t));
  // per-symbol index by date for O(1) lookups
  const idx: Record<string, Map<string, number>> = {};
  for (const [s, arr] of Object.entries(allBars)) idx[s] = new Map(arr.map((b, i) => [day(b.t), i]));

  let cash = cfg.capital;
  const positions: OpenPos[] = [];
  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];
  const skippedEntries: BacktestResult['skippedEntries'] = [];
  let pending: Pending[] = [];
  let halted: string | null = null;
  let pauseEntriesNextDay = false;
  let prevEquity = cfg.capital;
  const firstI = calendar.findIndex((d) => d >= cfg.start);
  if (firstI < 0) return { equity, trades, haltedOn: null, skippedEntries };
  const benchStart = benchBars[firstI].o;

  const barOn = (s: string, d: string) => { const i = idx[s]?.get(d); return i == null ? null : allBars[s][i]; };
  const close = (p: OpenPos, d: string, price: number, reason: Trade['reason']) => {
    const proceeds = p.qty * price - cfg.feePerOrder;
    cash += proceeds;
    const pnl = r2(proceeds - (p.qty * p.entryPrice + cfg.feePerOrder));
    trades.push({ symbol: p.symbol, qty: p.qty, entryDate: p.entryDate, entryPrice: r2(p.entryPrice), stop: p.stop, target: p.target,
      exitDate: d, exitPrice: r2(price), reason, pnl, r: p.risk > 0 ? Math.round((pnl / p.risk) * 100) / 100 : 0 });
    positions.splice(positions.indexOf(p), 1);
  };

  for (let i = firstI; i < calendar.length && calendar[i] <= cfg.end; i++) {
    const d = calendar[i];

    // ---- 1) OPEN: execute yesterday's decisions
    for (const o of pending.filter((x) => x.kind === 'exit')) {
      const p = positions.find((x) => x.symbol === o.symbol); const b = barOn(o.symbol, d);
      if (p && b) close(p, d, b.o * (1 - slip), o.reason!);
    }
    for (const o of pending.filter((x) => x.kind === 'entry')) {
      const b = barOn(o.symbol, d);
      if (!b) { skippedEntries.push({ d, symbol: o.symbol, reason: 'אין מסחר ביום הכניסה' }); continue; }
      if (b.o > o.priceRef * (1 + cfg.maxChase)) { skippedEntries.push({ d, symbol: o.symbol, reason: 'המחיר ברח בפתיחה' }); continue; }
      const fill = b.o * (1 + slip);
      if (fill <= o.stop!) { skippedEntries.push({ d, symbol: o.symbol, reason: 'נפתח מתחת לסטופ' }); continue; }
      const eqNow = cash + positions.reduce((s, p) => s + p.qty * (barOn(p.symbol, d)?.o ?? p.entryPrice), 0);
      const budget = r2(Math.min(eqNow, L.capitalBaseUsd) * L.riskPerTradePct / 100);
      const maxPos = L.capitalBaseUsd * L.maxPositionPct / 100;
      const maxExp = L.capitalBaseUsd * L.maxTotalExposurePct / 100;
      const qty = Math.floor(Math.min(budget / (fill - o.stop!), maxPos / fill));
      const exposure = positions.reduce((s, p) => s + p.qty * (barOn(p.symbol, d)?.o ?? p.entryPrice), 0);
      const cost = qty * fill + cfg.feePerOrder;
      if (qty < 1) { skippedEntries.push({ d, symbol: o.symbol, reason: 'כמות < 1 במחיר הפתיחה' }); continue; }
      if (exposure + qty * fill > maxExp || positions.length >= L.maxOpenPositions || cost > cash) {
        skippedEntries.push({ d, symbol: o.symbol, reason: 'מגבלת חשיפה/פוזיציות/מזומן' }); continue;
      }
      cash -= cost;
      positions.push({ symbol: o.symbol, qty, entryDate: d, entryPrice: fill, stop: o.stop!, target: o.target!, risk: qty * (fill - o.stop!), sessions: 0 });
    }
    pending = [];

    // ---- 2) INTRADAY: broker-side stop / target
    for (const p of [...positions]) {
      const b = barOn(p.symbol, d);
      if (!b) continue;
      p.sessions++;
      const isEntryDay = p.entryDate === d;
      if (!isEntryDay && b.o <= p.stop) { close(p, d, b.o * (1 - slip), 'gap_stop'); continue; }
      if (b.l <= p.stop) { close(p, d, p.stop * (1 - slip), 'stop'); continue; }
      if (!isEntryDay && b.o >= p.target) { close(p, d, b.o, 'target'); continue; }
      if (b.h >= p.target) { close(p, d, p.target, 'target'); continue; }
    }

    // ---- 3) CLOSE: mark to market
    const mv = positions.reduce((s, p) => s + p.qty * (barOn(p.symbol, d)?.c ?? p.entryPrice), 0);
    const eq = r2(cash + mv);
    equity.push({ d, equity: eq, bench: r2(cfg.capital * (benchBars[i].c / benchStart)), exposure: r2(mv) });
    if (!halted && cfg.haltOnDrawdown && eq <= L.capitalBaseUsd * (1 - L.killSwitchDrawdownPct / 100)) halted = d;
    pauseEntriesNextDay = eq - prevEquity <= -(L.capitalBaseUsd * L.dailyLossLimitPct / 100);
    prevEquity = eq;

    // ---- 4) DECISION for tomorrow (bars ≤ today only)
    if (i + 1 >= calendar.length || calendar[i + 1] > cfg.end) break;
    const window: Record<string, DailyBar[]> = {};
    for (const s of cfg.universe) {
      const j = idx[s]?.get(d);
      if (j == null) continue;
      window[s] = allBars[s].slice(Math.max(0, j - 259), j + 1);
    }
    for (const p of positions) if (!window[p.symbol]) { const j = idx[p.symbol]?.get(d); if (j != null) window[p.symbol] = allBars[p.symbol].slice(Math.max(0, j - 259), j + 1); }
    const out = runStrategy({
      bars: window,
      benchmarkBars: benchBars.slice(Math.max(0, i - 259), i + 1),
      positions: positions.map((p) => ({ symbol: p.symbol, qty: p.qty, avgEntry: p.entryPrice, openedAt: new Date(`${p.entryDate}T00:00:00Z`) })),
      pendingEntrySymbols: [],
      riskBudgetUsd: r2(Math.min(eq, L.capitalBaseUsd) * L.riskPerTradePct / 100),
      maxPositionUsd: L.capitalBaseUsd * L.maxPositionPct / 100,
      maxOpenPositions: L.maxOpenPositions,
      minPriceUsd: L.minPriceUsd,
    }, cfg.params);
    for (const pr of out.proposals) {
      if (pr.kind === 'exit') {
        const p = positions.find((x) => x.symbol === pr.symbol);
        const reason: Trade['reason'] = p && p.sessions >= cfg.params.maxHoldSessions ? 'max_hold' : 'trend';
        pending.push({ kind: 'exit', symbol: pr.symbol, priceRef: pr.priceRef, reason });
      } else if (!halted && !pauseEntriesNextDay) {
        pending.push({ kind: 'entry', symbol: pr.symbol, priceRef: pr.priceRef, stop: pr.stop!, target: pr.takeProfit! });
      }
    }
  }

  // close anything still open at the last close (for accounting only)
  const last = equity.at(-1)?.d;
  if (last) for (const p of [...positions]) { const b = barOn(p.symbol, last); close(p, last, (b?.c ?? p.entryPrice) * (1 - slip), 'end'); }
  return { equity, trades, haltedOn: halted, skippedEntries };
}
