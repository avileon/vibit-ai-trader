/** Pure indicator functions over arrays ordered oldest → newest. Return null when there is not enough data. */

export interface DailyBar { t: string; o: number; h: number; l: number; c: number; v: number }

export function sma(values: number[], n: number): number | null {
  if (values.length < n || n <= 0) return null;
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += values[i];
  return s / n;
}

/** Rate of change over n bars: close[t]/close[t-n] - 1 */
export function roc(values: number[], n: number): number | null {
  if (values.length < n + 1) return null;
  const prev = values[values.length - 1 - n];
  return prev > 0 ? values[values.length - 1] / prev - 1 : null;
}

/** Average True Range (simple average of TR over n bars). */
export function atr(bars: DailyBar[], n = 14): number | null {
  if (bars.length < n + 1) return null;
  let s = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i], prevClose = bars[i - 1].c;
    s += Math.max(b.h - b.l, Math.abs(b.h - prevClose), Math.abs(b.l - prevClose));
  }
  return s / n;
}

/** Average dollar volume over n bars (close × volume). */
export function avgDollarVolume(bars: DailyBar[], n = 20): number | null {
  if (bars.length < n) return null;
  let s = 0;
  for (let i = bars.length - n; i < bars.length; i++) s += bars[i].c * bars[i].v;
  return s / n;
}

/**
 * Keeps only bars from COMPLETED sessions strictly before `beforeDay` (YYYY-MM-DD, New York date).
 * This is the look-ahead guard: today's partial bar is never used for a decision made today.
 */
export function completedBars(bars: DailyBar[], beforeDay: string): DailyBar[] {
  return bars.filter((b) => nyDate(new Date(b.t)) < beforeDay);
}

export function nyDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function nyMinutes(d: Date): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const h = Number(p.find((x) => x.type === 'hour')!.value), m = Number(p.find((x) => x.type === 'minute')!.value);
  return h * 60 + m;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
