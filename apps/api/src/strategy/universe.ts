/**
 * Fixed, transparent universe of liquid US ETFs and large-cap stocks.
 * No options, leveraged/inverse ETFs, crypto or OTC. Prices are NOT assumed —
 * the screener filters by live price (must allow ≥1 whole share within the max position size).
 * A fixed list also avoids survivorship bias in our own selection process (it is decided up front).
 */
export const UNIVERSE: readonly string[] = [
  // Sector SPDRs
  'XLB', 'XLC', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLRE', 'XLU', 'XLV', 'XLY',
  // Industry / style / international equity ETFs
  'KRE', 'XBI', 'XOP', 'XHB', 'ITB', 'XME', 'GDX', 'IYR', 'EEM', 'EFA', 'VWO', 'VEA', 'IEMG', 'SCHD', 'KWEB',
  // Large caps with broad liquidity
  'BAC', 'WFC', 'C', 'T', 'VZ', 'KO', 'PFE', 'CSCO', 'INTC', 'F', 'GM', 'XOM', 'CVX', 'MRK', 'PEP',
];

/** Benchmark + market-regime filter (not traded by the strategy). */
export const BENCHMARK = 'SPY';
