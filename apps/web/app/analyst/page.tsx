'use client';
import Shell from '@/components/Shell';
import { dt, usd, useApi } from '@/lib/api';

const STATUS: Record<string, string> = { pending: 'ממתין', approved: 'אושר', rejected: 'נדחה', submitted: 'נשלח לברוקר', expired: 'לא נשלח' };
const RES: Record<string, string> = {
  submitted: 'נשלח', rejected_by_risk: 'נחסם ע״י מנוע הסיכון', duplicate: 'כפול — דולג', broker_rejected: 'נדחה ע״י הברוקר',
  unknown_failed: 'שליחה נכשלה', skipped: 'דולג',
};

export default function Analyst() {
  const { data, error } = useApi<any>('/api/engine', 60_000);
  const rep = data?.report;
  return (
    <Shell title="ניתוח המנוע">
      <div className="banner warn">
        הניתוח כאן מחושב ע״י חוקים קבועים ושקופים (ללא AI) מנתוני מחיר אמיתיים של Alpaca (IEX). אין כאן חדשות ואין תחזיות.
        הסבר בשפה טבעית ע״י Claude יתווסף בשלב ה — ו-Claude לעולם לא יאשר עסקה.
      </div>
      {error && <div className="banner danger">{error}</div>}
      {data && !rep && <div className="card"><p className="muted">המנוע עוד לא רץ. הוא רץ פעם ביום במצב פעיל בלבד (מרכז סיכונים → הפעל מסחר מדומה), בשעות 17:00–22:30 שעון ישראל.</p></div>}
      {rep && (
        <>
          <div className="grid stats" style={{ marginBottom: 14 }}>
            <div className="card"><div className="stat-label">ריצה אחרונה</div><div className="stat-value" style={{ fontSize: 18 }}>{dt(rep.at)}</div><div className="stat-sub">{rep.strategy}</div></div>
            <div className="card"><div className="stat-label">מצב שוק (SPY מול ממוצע 200)</div>
              <div className={`stat-value ${rep.regimeOk ? 'pos' : 'neg'}`} style={{ fontSize: 18 }}>{rep.regimeOk ? 'מגמה עולה — מותר להיכנס' : 'מתחת לממוצע — אין כניסות'}</div>
              <div className="stat-sub num">SPY {rep.regime.spyClose} / SMA200 {rep.regime.spySma200}</div></div>
            <div className="card"><div className="stat-label">שווי וירטואלי</div><div className="stat-value num">{usd(rep.virtualEquity)}</div><div className="stat-sub">תקציב סיכון לעסקה {usd(rep.riskBudgetUsd)}</div></div>
          </div>

          <div className="grid two" style={{ marginBottom: 14 }}>
            <div className="card">
              <h2>מועמדים מדורגים (מומנטום 6 חודשים, רק במגמה עולה)</h2>
              {rep.ranked.length === 0 ? <p className="muted small">אין מועמדים שעומדים בתנאי המגמה.</p> : (
                <table><thead><tr><th>#</th><th>סימול</th><th>תשואה 6 ח׳</th></tr></thead>
                  <tbody>{rep.ranked.map((r: any, i: number) => <tr key={r.symbol}><td>{i + 1}</td><td><b>{r.symbol}</b></td><td className="num pos">{r.roc126}%</td></tr>)}</tbody></table>
              )}
            </div>
            <div className="card">
              <h2>תוצאות הריצה</h2>
              {rep.results.length === 0 ? <p className="muted small">לא היו הצעות (אין מקום פנוי או אין מועמד מתאים).</p> : (
                <ul className="clean small">{rep.results.map((r: any, i: number) => <li key={i}><b>{r.symbol}</b> ({r.kind === 'entry' ? 'כניסה' : 'יציאה'}) — {RES[r.status] ?? r.status}{r.message ? `: ${r.message}` : ''}</li>)}</ul>
              )}
              <h2 style={{ marginTop: 14 }}>מה סונן ולמה</h2>
              <ul className="clean small" style={{ maxHeight: 220, overflow: 'auto' }}>{rep.skipped.map((s: any, i: number) => <li key={i}><b>{s.symbol}</b>: {s.reason}</li>)}</ul>
            </div>
          </div>
        </>
      )}
      {data?.proposals?.length > 0 && (
        <div className="card">
          <h2>הצעות עסקה והחלטות סיכון</h2>
          {data.proposals.map((p: any) => (
            <details key={p.id} className="term">
              <summary>
                {dt(p.created_at)} · {p.kind === 'entry' ? 'כניסה' : 'יציאה'} <b>{p.symbol}</b> × {p.qty} · {STATUS[p.status] ?? p.status}
                {p.approved != null && <> · סיכון: {p.approved ? <span className="pos">אושר</span> : <span className="neg">נדחה</span>}</>}
              </summary>
              <ul className="clean small">{p.rationale?.reasons?.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul>
              {p.checks && (
                <div className="table-wrap"><table><tbody>
                  {p.checks.map((c: any) => <tr key={c.id}><td>{c.ok ? '✓' : '✗'}</td><td className="num">{c.id}</td><td className={c.ok ? '' : 'neg'}>{c.detail}</td></tr>)}
                </tbody></table></div>
              )}
              <p className="muted small">גרסת אסטרטגיה: {p.strategy_version} · מזהה הוראה: <span className="num">{p.client_order_id ?? '—'}</span></p>
            </details>
          ))}
        </div>
      )}
    </Shell>
  );
}
