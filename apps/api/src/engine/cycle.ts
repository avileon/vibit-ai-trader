import { getPool } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { setSetting } from '../lib/settings.js';
import type { BrokerTrader } from '../broker/alpacaClient.js';
import { syncBroker } from '../broker/sync.js';
import { killSwitchThreshold, riskBudgetPerTrade } from '../riskConfig.js';
import type { RiskContext } from '../risk/riskEngine.js';
import { completedBars, nyDate, nyMinutes, round2, type DailyBar } from '../strategy/indicators.js';
import { runStrategy, STRATEGY_VERSION } from '../strategy/momentumTrend.js';
import { BENCHMARK, UNIVERSE } from '../strategy/universe.js';
import { limitsWithVersion, loadEngineState, loadOpenOrders, loadPositions, virtualEquity } from './context.js';
import { executeIntent, type ExecResult } from './executor.js';

export const RUN_WINDOW = { fromNyMin: 10 * 60, toNyMin: 15 * 60 + 30 } as const;
const STALE_ENTRY_MIN = 30;
const MAX_CHASE = 0.02; // skip entry if ask is >2% above the reference close

export interface CycleReport {
  ran: boolean;
  reason?: string;
  regimeOk?: boolean;
  results?: { symbol: string; kind: string; status: ExecResult['status'] | 'skipped'; message?: string }[];
}

/** Runs every worker tick: protective housekeeping that applies in ANY mode (SAFE included). */
export async function housekeeping(broker: BrokerTrader, now = new Date()): Promise<string[]> {
  const notes: string[] = [];
  const st = await loadEngineState();
  const { limits } = await limitsWithVersion();
  // 1) automatic kill switch on virtual drawdown
  if (st.account && st.brokerStatus === 'ok' && !st.killSwitch) {
    const ve = virtualEquity(limits, st.account);
    if (ve <= killSwitchThreshold(limits)) {
      const reason = `אוטומטי: שווי וירטואלי $${ve} ≤ $${killSwitchThreshold(limits)}`;
      await getPool().query("UPDATE bot_state SET kill_switch=1, mode='HALTED', kill_reason=?, kill_at=UTC_TIMESTAMP() WHERE id=1", [reason]);
      await audit('engine', 'risk.auto_kill_switch', { virtualEquity: ve });
      notes.push(reason);
    }
  }
  // 2) cancel stale, unfilled entry orders (prevents a GTC entry filling days later at a random time)
  if (st.brokerStatus === 'ok') {
    for (const o of await loadOpenOrders()) {
      if (o.kind !== 'entry' || !o.alpacaId || !o.submittedAt) continue;
      if (o.status === 'held') continue; // bracket legs
      if ((now.getTime() - o.submittedAt.getTime()) / 60_000 >= STALE_ENTRY_MIN && o.filledQty < o.qty) {
        await broker.cancelOrder(o.alpacaId);
        await audit('engine', 'order.stale_entry_canceled', { clientOrderId: o.clientOrderId, filled: o.filledQty });
        notes.push(`בוטלה כניסה שלא התמלאה: ${o.symbol}`);
      }
    }
  }
  return notes;
}

/** Once-per-day decision cycle. Only runs in ACTIVE mode, market open, inside the run window. */
export async function maybeRunDailyCycle(broker: BrokerTrader, now = new Date(), opts: { force?: boolean } = {}): Promise<CycleReport> {
  const st0 = await loadEngineState();
  const day = nyDate(now);
  if (st0.mode !== 'ACTIVE') return { ran: false, reason: `mode ${st0.mode}` };
  if (st0.killSwitch) return { ran: false, reason: 'kill switch' };
  if (!opts.force && st0.engineLastRunDay === day) return { ran: false, reason: 'already ran today' };
  const m = nyMinutes(now);
  if (!st0.clock?.isOpen) return { ran: false, reason: 'market closed' };
  if (m < RUN_WINDOW.fromNyMin || m > RUN_WINDOW.toNyMin) return { ran: false, reason: 'outside run window' };

  // fresh broker state right before deciding
  const sync = await syncBroker(broker, now);
  if (!sync.ok) return { ran: false, reason: `sync failed: ${sync.error}` };
  const st = await loadEngineState();
  if (!st.account) return { ran: false, reason: 'no account data' };

  const { limits, version } = await limitsWithVersion();
  const positions = await loadPositions();
  const openOrders = await loadOpenOrders();
  const ve = virtualEquity(limits, st.account);
  const budget = riskBudgetPerTrade(limits, ve);
  const maxPos = (limits.capitalBaseUsd * limits.maxPositionPct) / 100;

  const symbols = Array.from(new Set([...UNIVERSE, BENCHMARK, ...positions.map((p) => p.symbol)]));
  const start = new Date(now.getTime() - 420 * 864e5).toISOString().slice(0, 10);
  const raw = await broker.getBarsMulti(symbols, start);
  const bars: Record<string, DailyBar[]> = {};
  for (const s of symbols) if (s !== BENCHMARK) bars[s] = completedBars(raw[s] ?? [], day);

  const out = runStrategy({
    bars, benchmarkBars: completedBars(raw[BENCHMARK] ?? [], day),
    positions: positions.map((p) => ({ symbol: p.symbol, qty: p.qty, avgEntry: p.avgEntry, openedAt: p.openedAt })),
    pendingEntrySymbols: openOrders.filter((o) => o.kind === 'entry').map((o) => o.symbol),
    riskBudgetUsd: budget, maxPositionUsd: maxPos, maxOpenPositions: limits.maxOpenPositions, minPriceUsd: limits.minPriceUsd,
  });

  const quotes = out.proposals.length ? await broker.getQuotes(out.proposals.map((p) => p.symbol)) : {};
  const results: NonNullable<CycleReport['results']> = [];
  const pool = getPool();

  for (const p of out.proposals) {
    const q = quotes[p.symbol] ?? null;
    let intent;
    if (p.kind === 'entry') {
      if (!q) { results.push({ symbol: p.symbol, kind: p.kind, status: 'skipped', message: 'אין ציטוט' }); continue; }
      if (q.ask > p.priceRef * (1 + MAX_CHASE)) {
        results.push({ symbol: p.symbol, kind: p.kind, status: 'skipped', message: `המחיר ברח: Ask ${q.ask} מול ${p.priceRef}` });
        continue;
      }
      const limit = round2(q.ask * 1.001);
      const stop = Math.min(p.stop!, round2(limit - 0.01));
      const tp = Math.max(p.takeProfit!, round2(limit + 0.01));
      const qty = Math.floor(Math.min(budget / (limit - stop), maxPos / limit));
      intent = { kind: 'entry' as const, symbol: p.symbol, side: 'buy' as const, qty, limitPrice: limit, stopPrice: stop, takeProfit: tp };
    } else {
      intent = { kind: 'exit' as const, symbol: p.symbol, side: 'sell' as const, qty: p.qty, limitPrice: null, stopPrice: null, takeProfit: null };
    }

    const [ins] = await pool.query(
      `INSERT INTO trade_proposals (source, kind, symbol, side, qty, price_ref, stop_price, take_profit, rationale, strategy_version)
       VALUES ('engine', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.kind, p.symbol, p.side, intent.qty, p.priceRef, intent.stopPrice, intent.takeProfit, JSON.stringify(p.rationale), STRATEGY_VERSION],
    );
    const proposalId = (ins as { insertId: number }).insertId;

    const freshOrders = await loadOpenOrders();
    const ctx: RiskContext = {
      now, limits, universe: new Set(UNIVERSE), botMode: st.mode, killSwitch: st.killSwitch, brokerStatus: st.brokerStatus,
      lastSyncAt: st.lastSyncAt, clock: st.clock, quote: q ? { bid: q.bid, ask: q.ask, ts: q.ts } : null,
      positions: positions.map((x) => ({ symbol: x.symbol, qty: x.qty, marketValue: x.marketValue })),
      openOrders: freshOrders.map((o) => ({ symbol: o.symbol, side: o.side, notional: o.notional, kind: o.kind })),
      account: { cash: st.account.cash, equity: st.account.equity }, virtualEquity: ve, dailyPl: st.account.equity - st.account.lastEquity,
    };
    const cancelBeforeExit = p.kind === 'exit'
      ? freshOrders.filter((o) => o.symbol === p.symbol && o.side === 'sell' && o.alpacaId).map((o) => o.alpacaId!)
      : undefined;
    const r = await executeIntent({ broker, intent, ctx, proposalId, limitsVersion: version, nyDay: day, cancelBeforeExit });
    results.push({ symbol: p.symbol, kind: p.kind, status: r.status, message: r.message });
  }

  const summary = `${out.proposals.length} הצעות, ${results.filter((r) => r.status === 'submitted').length} נשלחו`;
  await pool.query('UPDATE bot_state SET engine_last_run_at=UTC_TIMESTAMP(), engine_last_run_day=?, engine_message=? WHERE id=1', [day, summary]);
  await setSetting('engine_last_report', {
    at: now.toISOString(), day, strategy: STRATEGY_VERSION, regimeOk: out.regimeOk, regime: out.regime,
    ranked: out.ranked.slice(0, 15), skipped: out.skipped.slice(0, 60), results, riskBudgetUsd: budget, virtualEquity: ve,
  });
  await audit('engine', 'engine.daily_cycle', { day, summary });
  await syncBroker(broker).catch(() => null);
  return { ran: true, regimeOk: out.regimeOk, results };
}
