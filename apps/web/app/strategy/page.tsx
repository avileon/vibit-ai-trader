'use client';
import { useState } from 'react';
import Shell from '@/components/Shell';
import EquityChart from '@/components/EquityChart';
import { api, dt, pct, usd, useApi } from '@/lib/api';

const REASON: Record<string, string> = { stop: 'סטופ', gap_stop: 'פער מתחת לסטופ', target: 'יעד', trend: 'שבירת מגמה', max_hold: 'זמן מקסימלי', end: 'סוף תקופה' };

function M({ label, s, b, fmt = pct, better = 'high' }: { label: string; s: number | null | undefined; b?: number | null; fmt?: (n: number | null | undefined) => string; better?: 'high' | 'low' }) {
  const win = s != null && b != null ? (better === 'high' ? s > b : s < b) : null;
  return <tr><td>{label}</td><td className={`num ${win == null ? '' : win ? 'pos' : 'neg'}`}>{fmt(s)}</td><td className="num muted">{b === undefined ? '' : fmt(b)}</td></tr>;
}
const num = (n: number | null | undefined) => (n == null ? '—' : String(n));
const pctAbs = (n: number | null | undefined) => (n == null ? '—' : `${n}%`);

export default function StrategyLab() {
  const { data, reload } = useApi<any>('/api/backtests', 10_000);
  const [sel, setSel] = useState<number | null>(null);
  const runId = sel ?? data?.runs?.find((r: any) => r.status === 'done')?.id ?? null;
  const { data: run } = useApi<any>(runId ? `/api/backtests/${runId}` : null);
  const [form, setForm] = useState({ start: '2017-01-01', slippageBps: 5, feePerOrder: 0.02, walkForward: true });
  const [msg, setMsg] = useState<string | null>(null);

  const start = async (kind: 'single' | 'compare' = 'single') => {
    setMsg(null);
    try { const r = await api<any>('/api/backtests', { method: 'POST', body: JSON.stringify({ ...form, kind }) }); setMsg(`נוצרה בדיקה #${r.id} — רצה ברקע (כמה דקות)`); setSel(r.id); reload(); }
    catch (e) { setMsg((e as Error).message); }
  };
  const R = run?.result;
  const S = R?.summary?.strategy, B = R?.summary?.benchmark;

  return (
    <Shell title="Strategy Lab — בדיקה היסטורית">
      <div className="banner warn">
        בדיקה היסטורית מריצה את <b>אותו קוד בדיוק</b> של הבוט על נתוני עבר (SIP, מותאם לפיצולים ודיבידנדים), עם עלויות ו-Slippage.
        היא עונה על שאלה אחת: האם היה לאסטרטגיה יתרון על פני קנייה והחזקה של SPY? זו לא תחזית.
      </div>

      <div className="grid two" style={{ marginBottom: 14 }}>
        <div className="card">
          <h2>הרצת בדיקה חדשה</h2>
          <div className="row">
            <div className="field"><label>מתאריך</label><input className="input num" type="date" value={form.start} min="2017-01-01" onChange={(e) => setForm({ ...form, start: e.target.value })} /></div>
            <div className="field"><label>Slippage לכל צד (bps)</label><input className="input num" type="number" min={0} max={100} value={form.slippageBps} onChange={(e) => setForm({ ...form, slippageBps: Number(e.target.value) })} style={{ maxWidth: 100 }} /></div>
            <div className="field"><label>עמלה להוראה ($)</label><input className="input num" type="number" step="0.01" min={0} value={form.feePerOrder} onChange={(e) => setForm({ ...form, feePerOrder: Number(e.target.value) })} style={{ maxWidth: 100 }} /></div>
          </div>
          <label className="small row"><input type="checkbox" checked={form.walkForward} onChange={(e) => setForm({ ...form, walkForward: e.target.checked })} /> כולל Walk-Forward (איטי יותר, ~2–5 דק׳)</label>
          <div className="row" style={{ marginTop: 10 }}><button className="btn primary" onClick={() => start('single')}>הרץ בדיקה (v1)</button><button className="btn" onClick={() => start('compare')}>השווה 6 אסטרטגיות</button>{msg && <span className="small">{msg}</span>}</div>
        </div>
        <div className="card">
          <h2>בדיקות קודמות</h2>
          <div className="table-wrap"><table><thead><tr><th>#</th><th>סוג</th><th>מתי</th><th>סטטוס</th><th>אסטרטגיה</th><th>SPY</th></tr></thead><tbody>
            {data?.runs?.map((r: any) => (
              <tr key={r.id} onClick={() => setSel(r.id)} style={{ cursor: 'pointer', background: r.id === runId ? 'var(--panel-2)' : undefined }}>
                <td>{r.id}</td><td>{r.kind === 'compare' ? 'השוואה' : 'v1'}</td><td>{dt(r.created_at)}</td>
                <td>{r.status === 'done' ? 'הסתיים' : r.status === 'error' ? <span className="neg">שגיאה</span> : <span className="muted">{r.progress ?? r.status}</span>}</td>
                <td className="num">{r.ret != null ? `${r.ret}%` : '—'}</td><td className="num">{r.bench != null ? `${r.bench}%` : '—'}</td>
              </tr>
            ))}
          </tbody></table></div>
        </div>
      </div>

      {run?.status === 'error' && <div className="banner danger">הבדיקה נכשלה: {run.error}</div>}
      {R?.kind === 'compare' && <CompareView R={R} id={run.id} />}
      {R && R.kind !== 'compare' && (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <h2>בדיקה #{run.id}: {R.period.start} → {R.period.end} · {R.strategyVersion}</h2>
            <EquityChart series={R.curve} benchLabel="SPY קנה והחזק (אותו הון)" />
          </div>

          <div className="grid two" style={{ marginBottom: 14 }}>
            <div className="card">
              <h2>אסטרטגיה מול SPY</h2>
              <table><thead><tr><th /><th>אסטרטגיה</th><th>SPY</th></tr></thead><tbody>
                <M label="תשואה כוללת" s={S.totalReturnPct} b={B.totalReturnPct} />
                <M label="תשואה שנתית (CAGR)" s={S.cagrPct} b={B.cagrPct} />
                <M label="Max Drawdown" s={S.maxDrawdownPct} b={B.maxDrawdownPct} fmt={pctAbs} better="low" />
                <M label="Sharpe" s={S.sharpe} b={B.sharpe} fmt={num} />
                <M label="תנודתיות שנתית" s={S.volatilityPct} b={B.volatilityPct} fmt={pctAbs} better="low" />
                <tr><td>שווי סופי</td><td className="num">{usd(S.endEquity)}</td><td className="num muted">{usd(B.endEquity)}</td></tr>
              </tbody></table>
            </div>
            <div className="card">
              <h2>עסקאות</h2>
              <table><tbody>
                <tr><td>מספר עסקאות</td><td className="num">{S.trades}</td></tr>
                <tr><td>Win Rate</td><td className="num">{pctAbs(S.winRatePct)}</td></tr>
                <tr><td>Profit Factor</td><td className="num">{num(S.profitFactor)}</td></tr>
                <tr><td>רווח ממוצע / הפסד ממוצע</td><td className="num">{usd(S.avgWin)} / {usd(S.avgLoss)}</td></tr>
                <tr><td>תוחלת לעסקה</td><td className="num">{usd(S.expectancy)}</td></tr>
                <tr><td>זמן בשוק</td><td className="num">{S.exposurePct}%</td></tr>
                <tr><td>סיבות יציאה</td><td className="small">{Object.entries(R.summary.exitReasons).map(([k, v]) => `${REASON[k] ?? k}: ${v}`).join(' · ')}</td></tr>
                {R.summary.haltedOn && <tr><td>Kill Switch</td><td className="neg">הופעל ב-{R.summary.haltedOn} (הפסד 5%) — מכאן אין כניסות</td></tr>}
              </tbody></table>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <h2>חלוקה לתקופות (Train / Validation / Test)</h2>
            <p className="muted small">הפרמטרים נקבעו מראש ולא כוילו על אף תקופה. החלוקה בודקת אם התוצאה יציבה לאורך זמן או נובעת מתקופה אחת.</p>
            <div className="table-wrap"><table><thead><tr><th>תקופה</th><th>מ-</th><th>עד</th><th>אסטרטגיה</th><th>SPY</th><th>DD אסטרטגיה</th><th>Sharpe</th></tr></thead><tbody>
              {R.segments.map((s: any) => (
                <tr key={s.name}><td>{s.name}</td><td className="num">{s.from}</td><td className="num">{s.to}</td>
                  <td className={`num ${s.strategy.totalReturnPct > s.benchmark.totalReturnPct ? 'pos' : 'neg'}`}>{pct(s.strategy.totalReturnPct)}</td>
                  <td className="num">{pct(s.benchmark.totalReturnPct)}</td><td className="num">{s.strategy.maxDrawdownPct}%</td><td className="num">{num(s.strategy.sharpe)}</td></tr>
              ))}
            </tbody></table></div>
          </div>

          {R.walkForward && (
            <div className="card" style={{ marginBottom: 14 }}>
              <h2>Walk-Forward (מחוץ למדגם)</h2>
              <p className="muted small">בכל חלון: בוחרים את הפרמטרים הטובים ביותר על 24 חודשים, ובודקים אותם על 6 החודשים הבאים שלא נראו. זו ההערכה הכנה ביותר.</p>
              <div className="grid stats" style={{ marginBottom: 10 }}>
                <div className="card"><div className="stat-label">אופטימיזציה (מחוץ למדגם)</div><div className="stat-value num">{pct(R.walkForward.stitched.optimizedPct)}</div></div>
                <div className="card"><div className="stat-label">פרמטרים קבועים v1</div><div className="stat-value num">{pct(R.walkForward.stitched.defaultPct)}</div></div>
                <div className="card"><div className="stat-label">SPY באותם חלונות</div><div className="stat-value num">{pct(R.walkForward.stitched.benchmarkPct)}</div></div>
                <div className="card"><div className="stat-label">חלונות שניצחו את SPY</div><div className="stat-value num">{R.walkForward.stitched.windowsBeatingBenchmark}/{R.walkForward.windows.length}</div></div>
              </div>
              <div className="table-wrap"><table><thead><tr><th>מבחן</th><th>פרמטרים שנבחרו</th><th>אופט׳</th><th>v1</th><th>SPY</th></tr></thead><tbody>
                {R.walkForward.windows.map((w: any) => (
                  <tr key={w.testFrom}><td className="num">{w.testFrom} → {w.testTo}</td><td className="num small">stop {w.chosen.stopAtr}×ATR · mom {w.chosen.momentumLookback}</td>
                    <td className="num">{pct(w.testReturnPct)}</td><td className="num">{pct(w.testReturnDefaultPct)}</td><td className="num muted">{pct(w.testBenchPct)}</td></tr>
                ))}
              </tbody></table></div>
            </div>
          )}

          <div className="grid two" style={{ marginBottom: 14 }}>
            <div className="card">
              <h2>הנחות</h2>
              <ul className="clean small">{Object.entries(R.assumptions).map(([k, v]) => <li key={k}>{String(v)}{k === 'slippageBps' ? ' bps Slippage' : k === 'feePerOrder' ? '$ עמלה להוראה' : ''}</li>)}<li>מקור נתונים: {R.dataFeed}</li></ul>
            </div>
            <div className="card">
              <h2>מגבלות — חשוב לקרוא</h2>
              <ul className="clean small">{R.caveats.map((c: string) => <li key={c}>{c}</li>)}</ul>
            </div>
          </div>

          <div className="card">
            <h2>עסקאות אחרונות ({R.trades.length} סה״כ)</h2>
            <div className="table-wrap"><table><thead><tr><th>סימול</th><th>כניסה</th><th>מחיר</th><th>יציאה</th><th>מחיר</th><th>כמות</th><th>סיבה</th><th>רווח/הפסד</th><th>R</th></tr></thead><tbody>
              {R.trades.slice(-60).reverse().map((t: any, i: number) => (
                <tr key={i}><td><b>{t.symbol}</b></td><td className="num">{t.entryDate}</td><td className="num">{t.entryPrice}</td><td className="num">{t.exitDate}</td><td className="num">{t.exitPrice}</td>
                  <td className="num">{t.qty}</td><td>{REASON[t.reason] ?? t.reason}</td><td className={`num ${t.pnl > 0 ? 'pos' : 'neg'}`}>{usd(t.pnl)}</td><td className="num">{t.r}</td></tr>
              ))}
            </tbody></table></div>
          </div>
        </>
      )}
    </Shell>
  );
}

function CompareView({ R, id }: { R: any; id: number }) {
  const [pick, setPick] = useState<string>(R.variants[0].id);
  const v = R.variants.find((x: any) => x.id === pick);
  const cell = (m: any, b: any, key: string, lowBetter = false) => {
    const sv = m?.[key], bv = b?.[key];
    const win = sv != null && bv != null ? (lowBetter ? sv < bv : sv > bv) : null;
    return <td className={`num ${win == null ? '' : win ? 'pos' : 'neg'}`}>{sv == null ? '—' : key === 'sharpe' ? sv : `${sv}%`}</td>;
  };
  const spy = R.variants[0];
  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <h2>השוואה #{id}: {R.period.start} → {R.period.end} · Hold-out מ-{R.holdoutStart}</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>אסטרטגיה</th><th>פיתוח: תשואה</th><th>פיתוח: DD</th><th>Hold-out: תשואה</th><th>Hold-out: DD</th><th>Sharpe (מלא)</th><th>ממוצע $/חודש</th></tr></thead>
          <tbody>
            {R.variants.map((x: any) => (
              <tr key={x.id} onClick={() => setPick(x.id)} style={{ cursor: 'pointer', background: x.id === pick ? 'var(--panel-2)' : undefined }}>
                <td><b>{x.name}</b></td>
                {cell(x.development.strategy, x.development.benchmark, 'totalReturnPct')}
                {cell(x.development.strategy, x.development.benchmark, 'maxDrawdownPct', true)}
                {cell(x.holdout.strategy, x.holdout.benchmark, 'totalReturnPct')}
                {cell(x.holdout.strategy, x.holdout.benchmark, 'maxDrawdownPct', true)}
                {cell(x.full.strategy, x.full.benchmark, 'sharpe')}
                <td className="num">{usd(x.avgMonthlyUsd)}</td>
              </tr>
            ))}
            <tr className="muted"><td>SPY קנה והחזק (100%)</td><td className="num">{spy.development.benchmark.totalReturnPct}%</td><td className="num">{spy.development.benchmark.maxDrawdownPct}%</td>
              <td className="num">{spy.holdout.benchmark.totalReturnPct}%</td><td className="num">{spy.holdout.benchmark.maxDrawdownPct}%</td><td className="num">{spy.full.benchmark.sharpe ?? '—'}</td><td /></tr>
          </tbody>
        </table></div>
        <p className="muted small">ירוק = טוב מ-SPY באותה תקופה (בתשואה: גבוה יותר; ב-DD: נמוך יותר). לחץ על שורה לגרף.</p>
      </div>
      {v && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>{v.name}</h2>
          <p className="small">{v.desc}</p>
          <EquityChart series={v.curve} benchLabel="SPY קנה והחזק (אותו הון)" />
          <p className="muted small">עסקאות: {v.full.trades.trades} · Win Rate {v.full.trades.winRatePct ?? '—'}% · PF {v.full.trades.profitFactor ?? '—'}</p>
        </div>
      )}
      <div className="card"><h2>הערות מתודולוגיות</h2><ul className="clean small">{R.notes.map((n: string) => <li key={n}>{n}</li>)}</ul></div>
    </>
  );
}
