import type { DailyBar } from '../src/strategy/indicators.js';

/** Synthetic daily bars ending the weekday before `end`. drift = daily % change. Deterministic. */
export function makeBars(n: number, start: number, drift: number, end: Date, wiggle = 0.004): DailyBar[] {
  const days: Date[] = [];
  const d = new Date(end); d.setUTCHours(4, 0, 0, 0); d.setUTCDate(d.getUTCDate() - 1);
  while (days.length < n) { if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.unshift(new Date(d)); d.setUTCDate(d.getUTCDate() - 1); }
  let p = start;
  return days.map((t, i) => {
    p = p * (1 + drift + (i % 2 ? wiggle : -wiggle) / 2);
    const o = p * 0.999, h = p * 1.006, l = p * 0.994;
    return { t: t.toISOString(), o: +o.toFixed(2), h: +h.toFixed(2), l: +l.toFixed(2), c: +p.toFixed(2), v: 2_000_000 };
  });
}
