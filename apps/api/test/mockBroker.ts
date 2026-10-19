import type { AlpacaAccount, AlpacaClock, AlpacaOrder, AlpacaPosition, Bar, BrokerReader, PortfolioHistory } from '../src/broker/alpacaClient.js';

/** In-memory broker for tests — no network. Mutate the public fields to simulate state changes. */
export class MockBroker implements BrokerReader {
  account: AlpacaAccount = {
    account_number: 'PA1234567', status: 'ACTIVE', cash: 600, equity: 1012.5, last_equity: 1000, buying_power: 600,
    long_market_value: 412.5, pattern_day_trader: false, daytrade_count: 0, multiplier: 1, trading_blocked: false, account_blocked: false,
  } as AlpacaAccount;
  clock: AlpacaClock = { timestamp: new Date().toISOString(), is_open: true, next_open: '2026-10-20T13:30:00Z', next_close: '2099-10-19T20:00:00Z' } as AlpacaClock;
  positions: AlpacaPosition[] = [
    { symbol: 'XLF', qty: 5, avg_entry_price: 40, current_price: 41.25, market_value: 206.25, unrealized_pl: 6.25, side: 'long' } as AlpacaPosition,
    { symbol: 'XLE', qty: 2, avg_entry_price: 100, current_price: 103.125, market_value: 206.25, unrealized_pl: 6.25, side: 'long' } as AlpacaPosition,
  ];
  orders: AlpacaOrder[] = [{
    id: 'ord-1', client_order_id: 'vibit-test-1', submitted_at: '2026-10-15T14:00:00Z', filled_at: '2026-10-15T14:00:02Z', symbol: 'XLF',
    side: 'buy', type: 'limit', order_class: 'bracket', time_in_force: 'gtc', qty: 5, filled_qty: 5, filled_avg_price: 40, limit_price: 40.1,
    stop_price: null, status: 'filled',
    legs: [
      { id: 'ord-1-tp', client_order_id: 'vibit-test-1-tp', symbol: 'XLF', side: 'sell', type: 'limit', time_in_force: 'gtc', qty: 5, filled_qty: 0, limit_price: 44, status: 'new' },
      { id: 'ord-1-sl', client_order_id: 'vibit-test-1-sl', symbol: 'XLF', side: 'sell', type: 'stop', time_in_force: 'gtc', qty: 5, filled_qty: 0, stop_price: 38, status: 'held' },
    ],
  }, {
    id: 'ord-2', client_order_id: 'manual-abc', submitted_at: '2026-10-16T15:00:00Z', filled_at: '2026-10-16T15:00:01Z', symbol: 'XLE',
    side: 'buy', type: 'market', order_class: '', time_in_force: 'day', qty: 2, filled_qty: 2, filled_avg_price: 100, status: 'filled',
  }];
  history: PortfolioHistory = { timestamp: [1792000000, 1792086400, 1792172800], equity: [0, 1000, 1005], base_value: 1000, timeframe: '1D' };
  bars: Bar[] = [{ t: '2026-10-16T04:00:00Z', o: 600, h: 605, l: 598, c: 603, v: 1 }, { t: '2026-10-17T04:00:00Z', o: 603, h: 610, l: 601, c: 608, v: 1 }];
  calls: string[] = [];
  async getAccount() { this.calls.push('account'); if (!this.account.account_number.startsWith('PA')) { const { assertPaperAccount } = await import('../src/broker/alpacaClient.js'); assertPaperAccount(this.account); } return this.account; }
  async getClock() { this.calls.push('clock'); return this.clock; }
  async getPositions() { this.calls.push('positions'); return this.positions; }
  async getOrders() { this.calls.push('orders'); return this.orders; }
  async getPortfolioHistory() { this.calls.push('history'); return this.history; }
  async getDailyBars() { this.calls.push('bars'); return this.bars; }
}
