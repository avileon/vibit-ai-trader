'use client';
import { useState } from 'react';
import { api, dt, usd, useApi } from '@/lib/api';

const STATUS: Record<string, [string, string]> = {
  ok: ['ok', 'מחובר — Paper'], error: ['bad', 'שגיאה'], not_configured: ['warn', 'לא הוגדרו מפתחות'], unknown: ['warn', 'לא ידוע'],
};

export default function BrokerCard() {
  const { data, reload } = useApi<any>('/api/broker', 30_000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const sync = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api<any>('/api/broker/sync', { method: 'POST', body: '{}' });
      setMsg(r.ok ? `סונכרן: ${r.positions} פוזיציות, ${r.orders} הוראות${r.backfilled ? `, יובאו ${r.backfilled} ימי היסטוריה` : ''}` : `נכשל: ${r.error}`);
      reload();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  if (!data) return null;
  const [dot, label] = STATUS[data.status] ?? STATUS.unknown;
  const a = data.account;
  const big = a && a.equity > data.capitalBaseUsd * 1.5;
  return (
    <div className="card" style={{ gridColumn: '1 / -1' }}>
      <h2>חיבור Alpaca Paper</h2>
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="pill"><span className={`dot ${dot}`} />{label}</span>
        <span className="muted small">בדיקה אחרונה: {dt(data.checkedAt)} · {data.message ?? ''}</span>
        <button className="btn" disabled={busy} onClick={sync}>{busy ? 'בודק…' : 'בדוק וסנכרן עכשיו'}</button>
      </div>
      {msg && <p className="small">{msg}</p>}
      {data.syncError && <div className="banner danger small">{data.syncError}</div>}
      {a && (
        <div className="table-wrap"><table><tbody>
          <tr><td>סוג חשבון</td><td>{a.accountPrefix === 'PA' ? 'Paper (מאומת לפי מספר חשבון PA…)' : 'לא Paper — חסום'}</td></tr>
          <tr><td>סטטוס</td><td className="num">{a.status}{a.tradingBlocked ? ' · מסחר חסום' : ''}</td></tr>
          <tr><td>שווי חשבון</td><td className="num">{usd(a.equity)}</td></tr>
          <tr><td>מינוף (multiplier)</td><td className="num">{a.multiplier ?? '—'} <span className="muted small">— המערכת לא משתמשת במינוף בכל מקרה</span></td></tr>
          <tr><td>Pattern Day Trader</td><td className="num">{a.pdt ? 'כן' : 'לא'} · Day trades (5 ימים): {a.daytradeCount ?? '—'}</td></tr>
        </tbody></table></div>
      )}
      {big && (
        <div className="banner warn small" style={{ marginTop: 10 }}>
          שווי חשבון ה-Paper ({usd(a.equity)}) גדול בהרבה מהון הבסיס ({usd(data.capitalBaseUsd)}). המערכת תחשב סיכון רק לפי {usd(data.capitalBaseUsd)},
          אבל ה-Dashboard מציג את החשבון כולו. מומלץ ליצור ב-Alpaca חשבון Paper חדש עם $1,000 ולהזין את המפתחות החדשים.
        </div>
      )}
      <p className="muted small" style={{ marginBottom: 0 }}>הסנכרון רץ אוטומטית כל דקה (קריאה בלבד). שום פקודה לא נשלחת בשלב זה.</p>
    </div>
  );
}
