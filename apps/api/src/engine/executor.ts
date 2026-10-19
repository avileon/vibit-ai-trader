import { getPool } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { BrokerError, type BrokerTrader, type NewOrder } from '../broker/alpacaClient.js';
import { evaluateOrder, type OrderIntent, type RiskContext, type RiskDecision } from '../risk/riskEngine.js';

/**
 * Executes ONE order intent:  risk check → reserve idempotency key → submit → record.
 * - client_order_id is deterministic per (kind, symbol, NY day): a second attempt the same day is a no-op.
 * - The key is reserved in MySQL (UNIQUE) BEFORE calling the broker, so two workers can't both submit.
 * - Ambiguous failures (timeout / 5xx) are resolved by looking the order up by client_order_id — never by blind retry.
 */
export interface ExecResult {
  status: 'rejected_by_risk' | 'duplicate' | 'submitted' | 'broker_rejected' | 'unknown_failed';
  decision?: RiskDecision;
  clientOrderId: string;
  message?: string;
}

export function clientOrderIdFor(kind: 'entry' | 'exit', symbol: string, nyDay: string): string {
  return `vibit-${kind}-${symbol}-${nyDay.replace(/-/g, '')}`;
}

export async function executeIntent(args: {
  broker: BrokerTrader;
  intent: OrderIntent;
  ctx: RiskContext;
  proposalId: number;
  limitsVersion: number;
  nyDay: string;
  cancelBeforeExit?: string[]; // broker order ids (bracket legs) to cancel before an exit
}): Promise<ExecResult> {
  const { broker, intent, ctx, proposalId, limitsVersion, nyDay } = args;
  const pool = getPool();
  const clientOrderId = clientOrderIdFor(intent.kind, intent.symbol, nyDay);
  const decision = evaluateOrder(intent, ctx);
  await pool.query('INSERT INTO risk_decisions (proposal_id, approved, checks, limits_version) VALUES (?, ?, ?, ?)', [
    proposalId, decision.approved ? 1 : 0, JSON.stringify(decision.checks), limitsVersion,
  ]);
  await pool.query('UPDATE trade_proposals SET client_order_id = ?, final_order = ? WHERE id = ?', [clientOrderId, JSON.stringify(intent), proposalId]);
  if (!decision.approved) {
    await pool.query("UPDATE trade_proposals SET status='rejected' WHERE id=?", [proposalId]);
    return { status: 'rejected_by_risk', decision, clientOrderId, message: decision.failed.join(', ') };
  }

  // reserve idempotency key
  try {
    await pool.query(
      `INSERT INTO orders (source, client_order_id, proposal_id, symbol, side, type, order_class, time_in_force, qty, limit_price, stop_price, status, reason, submitted_at)
       VALUES ('alpaca', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_submit', ?, UTC_TIMESTAMP())`,
      [clientOrderId, proposalId, intent.symbol, intent.side, intent.limitPrice != null ? 'limit' : 'market',
        intent.kind === 'entry' ? 'bracket' : null, intent.kind === 'entry' ? 'gtc' : 'day', intent.qty,
        intent.limitPrice, intent.stopPrice, intent.kind === 'entry' ? 'כניסה: Momentum + מגמה' : 'יציאה לפי חוקי האסטרטגיה'],
    );
  } catch (e) {
    if ((e as { code?: string }).code === 'ER_DUP_ENTRY') return { status: 'duplicate', decision, clientOrderId, message: 'already submitted today' };
    throw e;
  }

  for (const id of args.cancelBeforeExit ?? []) await broker.cancelOrder(id);

  const order: NewOrder = intent.kind === 'entry'
    ? {
        symbol: intent.symbol, qty: intent.qty, side: 'buy', type: 'limit', time_in_force: 'gtc', limit_price: intent.limitPrice!,
        order_class: 'bracket', take_profit: { limit_price: intent.takeProfit! }, stop_loss: { stop_price: intent.stopPrice! },
        client_order_id: clientOrderId,
      }
    : { symbol: intent.symbol, qty: intent.qty, side: 'sell', type: 'market', time_in_force: 'day', client_order_id: clientOrderId };

  try {
    const placed = await broker.submitOrder(order);
    await markSubmitted(clientOrderId, placed.id, placed.status, proposalId);
    await audit('engine', 'order.submitted', { clientOrderId, symbol: intent.symbol, side: intent.side, qty: intent.qty, limit: intent.limitPrice, stop: intent.stopPrice });
    return { status: 'submitted', decision, clientOrderId };
  } catch (e) {
    const be = e instanceof BrokerError ? e : null;
    if (be && (be.kind === 'network' || be.kind === 'server' || be.kind === 'rate_limit' || be.kind === 'bad_response')) {
      // ambiguous: did the broker receive it?
      const found = await broker.getOrderByClientId(clientOrderId).catch(() => null);
      if (found) {
        await markSubmitted(clientOrderId, found.id, found.status, proposalId);
        await audit('engine', 'order.submitted_after_ambiguity', { clientOrderId });
        return { status: 'submitted', decision, clientOrderId, message: 'confirmed via lookup' };
      }
      await pool.query("UPDATE orders SET status='submit_failed', reason=? WHERE client_order_id=?", [`לא נשלח: ${be.message}`.slice(0, 255), clientOrderId]);
      await pool.query("UPDATE trade_proposals SET status='expired' WHERE id=?", [proposalId]);
      await audit('engine', 'order.submit_failed', { clientOrderId, kind: be.kind });
      return { status: 'unknown_failed', decision, clientOrderId, message: be.message };
    }
    const msg = (e as Error).message.slice(0, 200);
    await pool.query("UPDATE orders SET status='rejected', reason=? WHERE client_order_id=?", [`נדחה ע״י הברוקר: ${msg}`.slice(0, 255), clientOrderId]);
    await pool.query("UPDATE trade_proposals SET status='rejected' WHERE id=?", [proposalId]);
    await audit('engine', 'order.broker_rejected', { clientOrderId, message: msg });
    return { status: 'broker_rejected', decision, clientOrderId, message: msg };
  }
}

async function markSubmitted(clientOrderId: string, alpacaId: string, status: string, proposalId: number) {
  await getPool().query('UPDATE orders SET alpaca_order_id=?, status=? WHERE client_order_id=?', [alpacaId, status, clientOrderId]);
  await getPool().query("UPDATE trade_proposals SET status='submitted' WHERE id=?", [proposalId]);
}
