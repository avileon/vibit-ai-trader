import { getPool } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { setSetting } from '../lib/settings.js';
import type { BrokerTrader } from '../broker/alpacaClient.js';
import { syncBroker } from '../broker/sync.js';
import type { RiskLimits } from '../riskConfig.js';
import type { OrderIntent, RiskContext } from '../risk/riskEngine.js';
import { completedBars, type DailyBar } from '../strategy/indicators.js';
import { SPY_STRATEGY_VERSION, spyTrendDecision } from '../strategy/spyTrend.js';
import type { EngineState } from './context.js';
import { loadOpenOrders, type loadPositions } from './context.js';
import { executeIntent } from './executor.js';
import type { CycleReport } from './cycle.js';

type Positions = Awaited<ReturnType<typeof loadPositions>>;
type OpenOrders = Awaited<ReturnType<typeof loadOpenOrders>>;

/** Daily decision for spy-trend-v1. Same pipeline as v1: Strategy → proposal → RiskEngine → Executor. */
export async function runSpyCycle(a: {
  broker: BrokerTrader; now: Date; day: string;
  st: EngineState & { account: NonNullable<EngineState['account']> };
  limits: RiskLimits; version: number; positions: Positions; openOrders: OpenOrders; ve: number;
}): Promise<CycleReport> {
  const { broker, now, day, st, limits, version, positions, ve } = a;
  const sym = limits.allocation.symbols[0];
  const pool = getPool();
  const results: NonNullable<CycleReport['results']> = [];

  const start = new Date(now.getTime() - 420 * 864e5).toISOString().slice(0, 10);
  const raw = await broker.getBarsMulti([sym], start);
  const bars: DailyBar[] = completedBars(raw[sym] ?? [], day);

  const held = positions.find((p) => p.symbol === sym);
  const leftovers = positions.filter((p) => p.symbol !== sym); // e.g. positions left from momentum-trend-v1
  const d = spyTrendDecision({
    bars, heldQty: held?.qty ?? 0, heldValue: held?.marketValue ?? 0, virtualEquity: ve,
    maxExposurePct: limits.allocation.maxExposurePct,
    pendingOrder: a.openOrders.some((o) => o.symbol === sym && o.kind !== 'other'),
  });

  const intents: { intent: OrderIntent; rationale: string[]; priceRef: number; cancel?: string[] }[] = [];
  for (const p of leftovers) {
    intents.push({
      intent: { kind: 'exit', symbol: p.symbol, side: 'sell', qty: p.qty, limitPrice: null, stopPrice: null, takeProfit: null },
      rationale: ['האסטרטגיה הוחלפה ל-SPY + פילטר מגמה — סוגרים פוזיציה ישנה'], priceRef: p.marketValue / Math.max(p.qty, 1e-9),
      cancel: a.openOrders.filter((o) => o.symbol === p.symbol && o.side === 'sell' && o.alpacaId).map((o) => o.alpacaId!),
    });
  }
  const quotes = await broker.getQuotes([sym, ...leftovers.map((p) => p.symbol)]);
  const q = quotes[sym] ?? null;
  if (d.action) {
    const intent: OrderIntent = d.action.kind === 'entry'
      ? { kind: 'entry', style: 'allocation', symbol: sym, side: 'buy', notional: d.action.notional,
          qty: q?.ask ? Math.floor((d.action.notional / q.ask) * 1e9) / 1e9 : 0, limitPrice: null, stopPrice: null, takeProfit: null }
      : { kind: 'exit', style: 'allocation', symbol: sym, side: 'sell', qty: d.action.qty, limitPrice: null, stopPrice: null, takeProfit: null };
    intents.push({ intent, rationale: d.rationale, priceRef: d.close ?? 0 });
  }

  for (const it of intents) {
    const [ins] = await pool.query(
      `INSERT INTO trade_proposals (source, kind, symbol, side, qty, price_ref, stop_price, take_profit, rationale, strategy_version)
       VALUES ('engine', ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      [it.intent.kind, it.intent.symbol, it.intent.side, it.intent.qty, +it.priceRef.toFixed(4), JSON.stringify(it.rationale), SPY_STRATEGY_VERSION],
    );
    const proposalId = (ins as { insertId: number }).insertId;
    const fresh = await loadOpenOrders();
    const qq = quotes[it.intent.symbol] ?? null;
    const ctx: RiskContext = {
      now, limits, universe: new Set(limits.allocation.symbols), botMode: st.mode, killSwitch: st.killSwitch, brokerStatus: st.brokerStatus,
      lastSyncAt: st.lastSyncAt, clock: st.clock, quote: qq ? { bid: qq.bid, ask: qq.ask, ts: qq.ts } : null,
      positions: positions.map((x) => ({ symbol: x.symbol, qty: x.qty, marketValue: x.marketValue })),
      openOrders: fresh.map((o) => ({ symbol: o.symbol, side: o.side, notional: o.notional, kind: o.kind })),
      account: { cash: st.account.cash, equity: st.account.equity }, virtualEquity: ve, dailyPl: st.account.equity - st.account.lastEquity,
    };
    const r = await executeIntent({ broker, intent: it.intent, ctx, proposalId, limitsVersion: version, nyDay: day, cancelBeforeExit: it.cancel });
    results.push({ symbol: it.intent.symbol, kind: it.intent.kind, status: r.status, message: r.message });
  }

  const summary = d.signal === 'unknown' ? 'אין מספיק נתונים'
    : `${d.signal === 'in' ? 'מגמה עולה' : 'מתחת לממוצע'} · ${intents.length} הצעות, ${results.filter((r) => r.status === 'submitted').length} נשלחו`;
  await pool.query('UPDATE bot_state SET engine_last_run_at=UTC_TIMESTAMP(), engine_last_run_day=?, engine_message=? WHERE id=1', [day, summary]);
  await setSetting('engine_last_report', {
    at: now.toISOString(), day, strategy: SPY_STRATEGY_VERSION, regimeOk: d.signal === 'in',
    regime: { spyClose: d.close, spySma200: d.sma200 },
    allocation: { signal: d.signal, targetUsd: d.targetUsd, heldValue: d.heldValue, maxExposurePct: limits.allocation.maxExposurePct, rationale: d.rationale },
    ranked: [], skipped: [], results, virtualEquity: ve,
  });
  await audit('engine', 'engine.daily_cycle', { day, strategy: SPY_STRATEGY_VERSION, summary });
  await syncBroker(broker).catch(() => null);
  return { ran: true, regimeOk: d.signal === 'in', results };
}
