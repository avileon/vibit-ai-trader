/** Performance statistics. Sharpe is only reported with ≥ 60 daily observations; otherwise null (noise). */

export interface Metrics {
  days: number;
  startEquity: number;
  endEquity: number;
  totalReturnPct: number;
  cagrPct: number | null;
  maxDrawdownPct: number;
  maxDrawdownUsd: number;
  sharpe: number | null;
  volatilityPct: number | null;
  trades?: number;
  winRatePct?: number | null;
  profitFactor?: number | null;
  avgWin?: number | null;
  avgLoss?: number | null;
  expectancy?: number | null;
  exposurePct?: number;
}

const r = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export function curveMetrics(values: number[], dates: string[]): Metrics {
  const n = values.length;
  const start = values[0] ?? 0, end = values[n - 1] ?? 0;
  let peak = -Infinity, mdd = 0, mddUsd = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) { const dd = (peak - v) / peak; if (dd > mdd) { mdd = dd; mddUsd = peak - v; } }
  }
  const rets: number[] = [];
  for (let i = 1; i < n; i++) if (values[i - 1] > 0) rets.push(values[i] / values[i - 1] - 1);
  let sharpe: number | null = null, vol: number | null = null;
  if (rets.length >= 60) {
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
    vol = r(sd * Math.sqrt(252) * 100);
    sharpe = sd > 0 ? r((mean / sd) * Math.sqrt(252)) : null;
  }
  const years = n > 1 ? (Date.parse(dates[n - 1]) - Date.parse(dates[0])) / (365.25 * 864e5) : 0;
  return {
    days: n, startEquity: r(start), endEquity: r(end),
    totalReturnPct: start > 0 ? r((end / start - 1) * 100) : 0,
    cagrPct: years >= 1 && start > 0 && end > 0 ? r(((end / start) ** (1 / years) - 1) * 100) : null,
    maxDrawdownPct: r(mdd * 100), maxDrawdownUsd: r(mddUsd), sharpe, volatilityPct: vol,
  };
}

export function tradeMetrics(pnls: number[]) {
  const wins = pnls.filter((p) => p > 0), losses = pnls.filter((p) => p <= 0);
  const gw = wins.reduce((a, b) => a + b, 0), gl = Math.abs(losses.reduce((a, b) => a + b, 0));
  return {
    trades: pnls.length,
    winRatePct: pnls.length ? r((wins.length / pnls.length) * 100) : null,
    profitFactor: gl > 0 ? r(gw / gl) : (gw > 0 ? null : null),
    avgWin: wins.length ? r(gw / wins.length) : null,
    avgLoss: losses.length ? r(-gl / losses.length) : null,
    expectancy: pnls.length ? r(pnls.reduce((a, b) => a + b, 0) / pnls.length) : null,
  };
}

export function monthlyReturns(points: { d: string; equity: number }[]): { month: string; pct: number }[] {
  const out: { month: string; pct: number }[] = [];
  let prevEnd: number | null = null, curMonth = '', curEnd = 0;
  for (const p of points) {
    const m = p.d.slice(0, 7);
    if (m !== curMonth) {
      if (curMonth && prevEnd != null) out.push({ month: curMonth, pct: r((curEnd / prevEnd - 1) * 100) });
      prevEnd = curMonth ? curEnd : p.equity;
      curMonth = m;
    }
    curEnd = p.equity;
  }
  if (curMonth && prevEnd != null) out.push({ month: curMonth, pct: r((curEnd / prevEnd - 1) * 100) });
  return out;
}
