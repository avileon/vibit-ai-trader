'use client';
import { useMemo, useState } from 'react';
import { usd } from '@/lib/api';

type Pt = { t: string; equity: number; spy: number | null };

/** Equity curve vs. SPY-like benchmark normalized to the same starting value. Pure SVG, no deps. */
export default function EquityChart({ series, benchLabel = 'בנצ׳מרק (מנורמל)' }: { series: Pt[]; benchLabel?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 800, H = 260, P = { t: 12, r: 12, b: 24, l: 56 };
  const calc = useMemo(() => {
    if (series.length < 2) return null;
    const base = series[0].equity;
    const spy0 = series.find((s) => s.spy != null)?.spy ?? null;
    const bench = series.map((s) => (spy0 && s.spy ? (s.spy / spy0) * base : null));
    const vals = [...series.map((s) => s.equity), ...bench.filter((b): b is number => b != null)];
    const min = Math.min(...vals), max = Math.max(...vals);
    const pad = (max - min) * 0.08 || 1;
    const lo = min - pad, hi = max + pad;
    const x = (i: number) => P.l + (i / (series.length - 1)) * (W - P.l - P.r);
    const y = (v: number) => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
    const path = (arr: (number | null)[]) =>
      arr.map((v, i) => (v == null ? '' : `${i === 0 || arr[i - 1] == null ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join(' ');
    const ticks = [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1];
    return { x, y, eq: path(series.map((s) => s.equity)), bench: path(bench), benchVals: bench, ticks };
  }, [series]);

  if (!calc) return <div className="muted small">אין מספיק נקודות נתונים לגרף.</div>;
  const h = hover != null ? series[hover] : null;

  return (
    <div className="chart-wrap">
      <svg
        viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="גרף שווי תיק לאורך זמן" style={{ direction: 'ltr', display: 'block' }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const i = Math.round(((px - P.l) / (W - P.l - P.r)) * (series.length - 1));
          setHover(Math.max(0, Math.min(series.length - 1, i)));
        }}
      >
        {calc.ticks.map((t) => (
          <g key={t}>
            <line x1={P.l} x2={W - P.r} y1={calc.y(t)} y2={calc.y(t)} stroke="var(--line)" strokeDasharray="3 4" />
            <text x={P.l - 8} y={calc.y(t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{Math.round(t)}</text>
          </g>
        ))}
        <path d={calc.bench} fill="none" stroke="var(--muted)" strokeWidth="1.5" strokeDasharray="5 4" />
        <path d={calc.eq} fill="none" stroke="var(--accent)" strokeWidth="2.25" />
        {hover != null && (
          <>
            <line x1={calc.x(hover)} x2={calc.x(hover)} y1={P.t} y2={H - P.b} stroke="var(--line)" />
            <circle cx={calc.x(hover)} cy={calc.y(series[hover].equity)} r="4" fill="var(--accent)" />
          </>
        )}
      </svg>
      {h && (
        <div className="chart-tip">
          {new Date(h.t).toLocaleDateString('he-IL')} · <span className="num">{usd(h.equity)}</span>
          {calc.benchVals[hover!] != null && <> · בנצ׳מרק <span className="num">{usd(calc.benchVals[hover!])}</span></>}
        </div>
      )}
      <div className="legend">
        <span><i style={{ background: 'var(--accent)' }} />שווי התיק</span>
        <span><i style={{ background: 'var(--muted)' }} />{benchLabel}</span>
      </div>
    </div>
  );
}
