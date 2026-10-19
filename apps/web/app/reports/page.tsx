'use client';
import { useState } from 'react';
import Shell from '@/components/Shell';
import { dt, pct, signedUsd, tone, usd, useApi } from '@/lib/api';

const P: Record<string, string> = { day: 'יום', week: 'שבוע', month: 'חודש', all: 'מההתחלה' };

export default function Reports() {
  const [period, setPeriod] = useState('week');
  const { data, error } = useApi<any>(`/api/reports?period=${period}`, 60_000);
  return (
    <Shell title="דוחות — מסחר מדומה" actions={
      <div className="row">{Object.entries(P).map(([k, v]) => <button key={k} className={`btn ${k === period ? 'primary' : ''}`} onClick={() => setPeriod(k)}>{v}</button>)}</div>
    }>
      {error && <div className="banner danger">{error}</div>}
      {data && (
        <>
          <div className="grid stats" style={{ marginBottom: 14 }}>
            <div className="card"><div className="stat-label">רווח/הפסד נטו</div><div className={`stat-value num ${tone(data.netPnlUsd)}`}>{signedUsd(data.netPnlUsd)}</div><div className="stat-sub">{pct(data.netPnlPctOfCapitalBase)} מהון הבסיס</div></div>
            <div className="card"><div className="stat-label">SPY באותה תקופה</div><div className="stat-value num">{data.benchmarkPct == null ? '—' : pct(data.benchmarkPct)}</div></div>
            <div className="card"><div className="stat-label">Max Drawdown</div><div className="stat-value num">{usd(data.maxDrawdownUsd)}</div></div>
            <div className="card"><div className="stat-label">עסקאות שנסגרו</div><div className="stat-value num">{data.trades}</div><div className="stat-sub">Win Rate {data.winRatePct ?? '—'}% · PF {data.profitFactor ?? '—'}</div></div>
            <div className="card"><div className="stat-label">Sharpe</div><div className="stat-value num">{data.sharpe ?? '—'}</div><div className="stat-sub">{data.sharpe == null ? `צריך ≥60 ימי נתונים (יש ${data.dataPoints})` : ''}</div></div>
          </div>
          <div className="card">
            <h2>עסקאות סגורות</h2>
            {data.trips.length === 0 ? <p className="muted small">עוד אין עסקאות סגורות בתקופה.</p> : (
              <div className="table-wrap"><table><thead><tr><th>סימול</th><th>כמות</th><th>כניסה</th><th>מחיר</th><th>יציאה</th><th>מחיר</th><th>רווח/הפסד</th></tr></thead><tbody>
                {data.trips.map((t: any, i: number) => (
                  <tr key={i}><td><b>{t.symbol}</b></td><td className="num">{t.qty}</td><td>{dt(t.entryAt)}</td><td className="num">{usd(t.entryPrice)}</td><td>{dt(t.exitAt)}</td><td className="num">{usd(t.exitPrice)}</td><td className={`num ${tone(t.pnl)}`}>{signedUsd(t.pnl)}</td></tr>
                ))}
              </tbody></table></div>
            )}
            <p className="muted small" style={{ marginBottom: 0 }}>החישוב מבוסס על ביצועים בפועל ב-Alpaca Paper (FIFO). רווח/הפסד נטו מחושב משווי החשבון ולכן כולל גם פוזיציות פתוחות. מספר קטן של עסקאות = מסקנות לא אמינות.</p>
          </div>
        </>
      )}
    </Shell>
  );
}
