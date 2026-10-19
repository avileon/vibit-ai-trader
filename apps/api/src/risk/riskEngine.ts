import type { RiskLimits } from '../riskConfig.js';
import { killSwitchThreshold, riskBudgetPerTrade } from '../riskConfig.js';
import { nyMinutes } from '../strategy/indicators.js';

/**
 * Deterministic, independent risk gate. The ONLY component that can approve an order.
 * Pure function: same inputs → same decision. No AI, no network, no side effects.
 * Every check is reported (pass or fail) so each decision is auditable.
 */

export interface OrderIntent {
  kind: 'entry' | 'exit';
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  limitPrice: number | null; // null = market (exits only)
  stopPrice: number | null;
  takeProfit: number | null;
}

export interface RiskContext {
  now: Date;
  limits: RiskLimits;
  universe: ReadonlySet<string>;
  botMode: 'SAFE' | 'ACTIVE' | 'HALTED';
  killSwitch: boolean;
  brokerStatus: string;
  lastSyncAt: Date | null;
  clock: { isOpen: boolean; nextClose: Date } | null;
  quote: { bid: number; ask: number; ts: Date } | null;
  positions: { symbol: string; qty: number; marketValue: number }[];
  openOrders: { symbol: string; side: 'buy' | 'sell'; notional: number; kind: 'entry' | 'exit' | 'other' }[];
  account: { cash: number; equity: number };
  /** capital base + P&L since the system started (so a $100k paper account is treated as $1k) */
  virtualEquity: number;
  /** today's P&L in USD */
  dailyPl: number;
}

export interface RiskCheck { id: string; ok: boolean; detail: string }
export interface RiskDecision { approved: boolean; checks: RiskCheck[]; failed: string[] }

const SYNC_MAX_AGE_MS = 3 * 60_000;

export function evaluateOrder(o: OrderIntent, c: RiskContext): RiskDecision {
  const L = c.limits;
  const checks: RiskCheck[] = [];
  const add = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
  const entry = o.kind === 'entry';
  const price = o.limitPrice ?? (c.quote ? (o.side === 'buy' ? c.quote.ask : c.quote.bid) : NaN);

  add('mode_active', c.botMode === 'ACTIVE', `מצב בוט: ${c.botMode}`);
  add('kill_switch_off', !c.killSwitch, c.killSwitch ? 'Kill Switch פעיל' : 'כבוי');
  add('broker_ok', c.brokerStatus === 'ok', `סטטוס ברוקר: ${c.brokerStatus}`);
  const syncAge = c.lastSyncAt ? c.now.getTime() - c.lastSyncAt.getTime() : Infinity;
  add('sync_fresh', syncAge <= SYNC_MAX_AGE_MS, `סנכרון אחרון לפני ${Number.isFinite(syncAge) ? Math.round(syncAge / 1000) : '∞'} שנ׳`);

  const open = !!c.clock?.isOpen && c.clock.nextClose.getTime() > c.now.getTime();
  add('market_open', open, open ? 'השוק פתוח (שעון Alpaca)' : 'השוק סגור');
  if (open) {
    const sinceOpen = nyMinutes(c.now) - (9 * 60 + 30);
    const toClose = (c.clock!.nextClose.getTime() - c.now.getTime()) / 60_000;
    const ok = sinceOpen >= L.noTradeOpenCloseMinutes && toClose >= L.noTradeOpenCloseMinutes;
    add('not_open_close_window', ok, `${Math.round(sinceOpen)} דק׳ מהפתיחה, ${Math.round(toClose)} דק׳ לסגירה (מינימום ${L.noTradeOpenCloseMinutes})`);
  }

  add('whole_shares', Number.isInteger(o.qty) && o.qty >= 1, `כמות ${o.qty}`);

  const quoteAge = c.quote ? (c.now.getTime() - c.quote.ts.getTime()) / 1000 : Infinity;
  add('quote_fresh', quoteAge <= L.maxQuoteAgeSec, c.quote ? `ציטוט בן ${Math.round(quoteAge)} שנ׳ (מקס׳ ${L.maxQuoteAgeSec})` : 'אין ציטוט');
  const validQuote = !!c.quote && c.quote.bid > 0 && c.quote.ask > 0 && c.quote.ask >= c.quote.bid;
  add('quote_valid', validQuote, validQuote ? `Bid ${c.quote!.bid} / Ask ${c.quote!.ask}` : 'ציטוט חסר או שגוי (Bid/Ask לא הגיוניים)');

  if (entry) {
    add('long_only', o.side === 'buy', o.side === 'buy' ? 'קנייה' : 'כניסה בצד מכירה = שורט — אסור');
    add('asset_allowed', c.universe.has(o.symbol), c.universe.has(o.symbol) ? 'ברשימת הנכסים המאושרים' : 'לא ברשימת הנכסים המאושרים');
    if (validQuote) {
      const mid = (c.quote!.bid + c.quote!.ask) / 2;
      const spreadPct = ((c.quote!.ask - c.quote!.bid) / mid) * 100;
      add('spread_ok', spreadPct <= L.maxSpreadPct, `Spread ${spreadPct.toFixed(3)}% (מקס׳ ${L.maxSpreadPct}%)`);
    }
    add('limit_order', o.limitPrice != null && o.limitPrice > 0, 'כניסה רק בפקודת Limit');
    add('price_min', price >= L.minPriceUsd, `מחיר ${price} (מינ׳ ${L.minPriceUsd})`);
    const stopOk = o.stopPrice != null && o.stopPrice > 0 && o.stopPrice < price;
    add('exit_defined', stopOk && o.takeProfit != null && o.takeProfit > price,
      stopOk ? `סטופ ${o.stopPrice}, יעד ${o.takeProfit}` : 'אין סטופ תקין — אסור להחזיק פוזיציה ללא מנגנון יציאה');

    const budget = riskBudgetPerTrade(L, c.virtualEquity);
    const plannedRisk = stopOk ? (price - o.stopPrice!) * o.qty : Infinity;
    add('risk_per_trade', plannedRisk <= budget + 0.01, `סיכון מתוכנן $${plannedRisk.toFixed(2)} (תקציב $${budget})`);

    const maxPos = (L.capitalBaseUsd * L.maxPositionPct) / 100;
    const value = price * o.qty;
    add('position_size', value <= maxPos + 0.01, `שווי $${value.toFixed(2)} (מקס׳ $${maxPos})`);

    const maxExp = (L.capitalBaseUsd * L.maxTotalExposurePct) / 100;
    const exposure = c.positions.reduce((s, p) => s + Math.abs(p.marketValue), 0) +
      c.openOrders.filter((x) => x.side === 'buy').reduce((s, x) => s + x.notional, 0);
    add('total_exposure', exposure + value <= maxExp + 0.01, `חשיפה אחרי העסקה $${(exposure + value).toFixed(2)} (מקס׳ $${maxExp})`);

    const pendingEntries = c.openOrders.filter((x) => x.kind === 'entry').length;
    const count = c.positions.length + pendingEntries;
    add('max_positions', count < L.maxOpenPositions, `${count} פוזיציות/כניסות פתוחות (מקס׳ ${L.maxOpenPositions})`);

    const holding = c.positions.some((p) => p.symbol === o.symbol);
    add('not_already_holding', !holding, holding ? 'כבר מחזיקים את הנכס' : 'אין פוזיציה קיימת');

    add('cash_no_margin', value <= c.account.cash, `עלות $${value.toFixed(2)} מול מזומן $${c.account.cash.toFixed(2)} (ללא מינוף)`);

    const dailyLimit = (L.capitalBaseUsd * L.dailyLossLimitPct) / 100;
    add('daily_loss', c.dailyPl > -dailyLimit, `רווח/הפסד היום $${c.dailyPl.toFixed(2)} (עצירה ב-‎-$${dailyLimit})`);

    const kill = killSwitchThreshold(L);
    add('drawdown', c.virtualEquity > kill, `שווי וירטואלי $${c.virtualEquity.toFixed(2)} (עצירה ב-$${kill})`);
  } else {
    const pos = c.positions.find((p) => p.symbol === o.symbol);
    add('long_only', o.side === 'sell' && !!pos && pos.qty >= o.qty,
      pos ? `מכירת ${o.qty} מתוך ${pos.qty} מוחזקות` : 'אין פוזיציה — מכירה הייתה יוצרת שורט');
  }

  const dup = c.openOrders.some((x) => x.symbol === o.symbol && x.side === o.side && x.kind !== 'other');
  add('no_duplicate', !dup, dup ? 'כבר קיימת הוראה פתוחה זהה' : 'אין הוראה כפולה');

  const failed = checks.filter((x) => !x.ok).map((x) => x.id);
  return { approved: failed.length === 0, checks, failed };
}
