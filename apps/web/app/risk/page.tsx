'use client';
import { useState } from 'react';
import Shell from '@/components/Shell';
import { api, dt, usd, useApi } from '@/lib/api';

const EVENT: Record<string, string> = {
  'bot.kill_switch_on': 'Kill Switch הופעל', 'bot.kill_switch_off': 'Kill Switch שוחרר → מצב בטוח',
  'bot.worker_start': 'המנוע הופעל מחדש (מצב בטוח)', 'bot.activate_denied': 'בקשת הפעלה נחסמה', 'bot.mode_safe': 'מעבר למצב בטוח',
};

export default function Risk() {
  const { data, error, reload } = useApi<any>('/api/risk', 30_000);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<string[] | null>(null);

  const run = async (fn: () => Promise<any>) => {
    setMsg(null);
    setBlockers(null);
    try { await fn(); await reload(); } catch (e: any) { if (e.body?.blockers) setBlockers(e.body.blockers); else setMsg(e.message); }
  };
  const L = data?.limits, D = data?.derived;

  return (
    <Shell title="מרכז סיכונים">
      {error && <div className="banner danger">{error}</div>}
      {data && (
        <>
          <div className={`banner ${data.state.killSwitch ? 'danger' : 'warn'}`}>
            מצב נוכחי: <b>{data.state.mode}</b>
            {data.state.killSwitch && <> · Kill Switch פעיל מאז {dt(data.state.killAt)} — {data.state.killReason}</>}
          </div>

          <div className="grid two" style={{ marginBottom: 14 }}>
            <div className="card">
              <h2>מתג חירום (Kill Switch)</h2>
              {!data.state.killSwitch ? (
                <>
                  <p className="small">הפעלה חוסמת מיידית שליחת פקודות חדשות. הבוט עובר ל-HALTED.</p>
                  <div className="field"><label htmlFor="r">סיבה (חובה)</label>
                    <input id="r" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="למשל: תקלה בנתונים" /></div>
                  <button className="btn danger" disabled={reason.trim().length < 3}
                    onClick={() => run(() => api('/api/risk/kill', { method: 'POST', body: JSON.stringify({ reason }) }))}>הפעל Kill Switch</button>
                </>
              ) : (
                <>
                  <p className="small">שחרור מחזיר ל<b>מצב בטוח</b> בלבד (לא לפעיל). הקלד <b>אני מאשר</b>:</p>
                  <div className="field"><input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></div>
                  <button className="btn" disabled={confirm !== 'אני מאשר'}
                    onClick={() => run(() => api('/api/risk/resume', { method: 'POST', body: JSON.stringify({ confirm }) }))}>שחרר ל-SAFE</button>
                </>
              )}
              <h2 style={{ marginTop: 18 }}>מה קורה לפוזיציות קיימות?</h2>
              <ul className="clean small">
                <li>Kill Switch <b>לא מוכר אוטומטית</b>. מכירה בלחץ בזמן תקלה עלולה להיות גרועה יותר.</li>
                <li>פקודות הסטופ שכבר יושבות אצל Alpaca (GTC) <b>נשארות פעילות</b> ומגנות על הפוזיציה גם כשהשרת שלנו כבוי.</li>
                <li>סגירה ידנית: ממסך Alpaca Paper → Positions → Close, או (בשלב ד) כפתור "סגור הכל" עם אישור כפול.</li>
              </ul>
              {msg && <p className="error">{msg}</p>}
            </div>

            <div className="card">
              <h2>הפעלת הבוט</h2>
              <p className="small">הבוט עולה תמיד ב<b>מצב בטוח</b> (גם אחרי קריסה). מעבר לפעיל דורש שכל התנאים יתקיימו:</p>
              <button className="btn primary" onClick={() => run(() => api('/api/bot/mode', { method: 'POST', body: JSON.stringify({ mode: 'ACTIVE' }) }))}>בקש הפעלה</button>
              {blockers && (
                <div className="banner warn" style={{ marginTop: 12 }}>
                  ההפעלה נחסמה:
                  <ul className="clean">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
                </div>
              )}
            </div>
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <h2>ספי סיכון פעילים (גרסה {data.limitsVersion})</h2>
            <div className="table-wrap"><table><tbody>
              <tr><td>הון בסיס לחישוב</td><td className="num">{usd(L.capitalBaseUsd)}</td><td className="muted small">גם אם חשבון ה-Paper גדול יותר</td></tr>
              <tr><td>סיכון מתוכנן לעסקה</td><td className="num">{L.riskPerTradePct}% = {usd(D.riskPerTradeUsd)}</td><td className="muted small">לא גבול הפסד מובטח (Gap/Slippage)</td></tr>
              <tr><td>גודל פוזיציה מקסימלי</td><td className="num">{L.maxPositionPct}% = {usd(D.maxPositionUsd)}</td><td className="muted small">מניעת ריכוזיות</td></tr>
              <tr><td>חשיפה כוללת מקסימלית</td><td className="num">{L.maxTotalExposurePct}% = {usd(D.maxExposureUsd)}</td><td className="muted small">תמיד נשאר מזומן</td></tr>
              <tr><td>פוזיציות פתוחות</td><td className="num">עד {L.maxOpenPositions}</td><td /></tr>
              <tr><td>הפסד יומי</td><td className="num">{L.dailyLossLimitPct}% = {usd(D.dailyLossUsd)}</td><td className="muted small">אין עסקאות חדשות עד מחר</td></tr>
              <tr><td>Kill Switch אוטומטי</td><td className="num">שווי ≤ {usd(D.killSwitchEquity)}</td><td className="muted small">-{L.killSwitchDrawdownPct}% מההון ההתחלתי</td></tr>
              <tr><td>מחיר מניה מינימלי</td><td className="num">{usd(L.minPriceUsd)}</td><td /></tr>
              <tr><td>מחזור דולרי יומי מינימלי</td><td className="num">{usd(L.minAvgDollarVolumeUsd)}</td><td className="muted small">נזילות</td></tr>
              <tr><td>Spread מקסימלי</td><td className="num">{L.maxSpreadPct}%</td><td /></tr>
              <tr><td>גיל ציטוט מקסימלי</td><td className="num">{L.maxQuoteAgeSec} שנ׳</td><td className="muted small">נתון ישן = אין מסחר</td></tr>
              <tr><td>מניות שלמות בלבד</td><td>{L.wholeSharesOnly ? 'כן' : 'לא'}</td><td className="muted small">Alpaca: חלקי = DAY בלבד, ללא Bracket</td></tr>
              <tr><td>שורט / מינוף / אופציות / קריפטו</td><td>חסום</td><td className="muted small">קבוע בקוד, לא ניתן לשינוי מהממשק</td></tr>
            </tbody></table></div>
          </div>

          <div className="grid two">
            <div className="card">
              <h2>החלטות סיכון אחרונות</h2>
              {data.decisions.length === 0 ? <p className="muted small">אין עדיין — המנוע ייבנה בשלב ד.</p> : (
                <ul className="clean small">{data.decisions.map((d: any) => <li key={d.id}>{dt(d.created_at)} · {d.approved ? 'אושר' : 'נדחה'}</li>)}</ul>
              )}
            </div>
            <div className="card">
              <h2>יומן אירועים</h2>
              <ul className="clean small">
                {data.events.map((e: any, i: number) => (
                  <li key={i}>{dt(e.created_at)} · {EVENT[e.action] ?? e.action} <span className="muted">({e.actor})</span></li>
                ))}
              </ul>
            </div>
          </div>
        </>
      )}
    </Shell>
  );
}
