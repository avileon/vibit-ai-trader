'use client';
import Shell, { DemoBanner } from '@/components/Shell';
import { dt, pct, signedUsd, tone, usd, useApi } from '@/lib/api';

export default function Portfolio() {
  const { data, error } = useApi<any>('/api/portfolio', 30_000);
  return (
    <Shell title="תיק השקעות">
      {error && <div className="banner danger">{error}</div>}
      {data && (
        <>
          <DemoBanner show={data.isDemo} />
          <div className="card">
            {data.positions.length === 0 ? <p className="muted">אין פוזיציות פתוחות.</p> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>סימול</th><th>כמות</th><th>מחיר קנייה</th><th>מחיר נוכחי</th><th>שווי</th><th>תשואה</th><th>חשיפה מהתיק</th><th>סטופ</th><th>סיכון עד הסטופ*</th><th>נפתח</th></tr></thead>
                  <tbody>
                    {data.positions.map((p: any) => (
                      <tr key={p.symbol}>
                        <td><b>{p.symbol}</b></td>
                        <td className="num">{p.qty}</td>
                        <td className="num">{usd(p.avgEntry)}</td>
                        <td className="num">{usd(p.current)}</td>
                        <td className="num">{usd(p.value)}</td>
                        <td className={`num ${tone(p.pl)}`}>{signedUsd(p.pl)} ({pct(p.plPct)})</td>
                        <td className="num">{p.exposurePct}%</td>
                        <td className="num">{p.stop ? usd(p.stop) : <span className="neg">אין!</span>}</td>
                        <td className="num">{p.riskToStop != null ? usd(p.riskToStop) : '—'}</td>
                        <td>{dt(p.openedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted small" style={{ marginBottom: 0 }}>
              * "סיכון עד הסטופ" = כמה יאבד אם המחיר יירד בדיוק לסטופ. זו <b>לא</b> הבטחה: בפער פתיחה (Gap) או בחוסר נזילות היציאה יכולה להיות במחיר נמוך יותר.
            </p>
          </div>
        </>
      )}
    </Shell>
  );
}
