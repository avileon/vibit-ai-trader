'use client';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import BrokerCard from '@/components/BrokerCard';
import { api, dt, useApi } from '@/lib/api';

const SECRET_LABEL: Record<string, string> = {
  ALPACA_KEY_ID: 'Alpaca Paper — API Key ID',
  ALPACA_SECRET_KEY: 'Alpaca Paper — Secret Key',
  ANTHROPIC_API_KEY: 'Claude (Anthropic) API Key',
};

function SecretRow({ s, onSaved }: { s: any; onSaved: () => void }) {
  const [v, setV] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const save = async () => {
    setMsg(null);
    try { await api(`/api/secrets/${s.name}`, { method: 'PUT', body: JSON.stringify({ value: v.trim() }) }); setV(''); onSaved(); setMsg('נשמר מוצפן'); }
    catch (e) { setMsg((e as Error).message); }
  };
  return (
    <div className="field" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 12 }}>
      <label>{SECRET_LABEL[s.name]} · {s.configured ? <span className="pos">מוגדר ({s.masked}, {dt(s.updatedAt)})</span> : <span className="muted">לא מוגדר</span>}</label>
      <div className="row">
        <input className="input num" style={{ flex: 1, minWidth: 200 }} type="password" autoComplete="off" placeholder="הדבק ערך חדש" value={v} onChange={(e) => setV(e.target.value)} />
        <button className="btn" disabled={v.length < 10} onClick={save}>שמור</button>
      </div>
      {msg && <span className="small">{msg}</span>}
    </div>
  );
}

export default function Settings() {
  const { data, reload } = useApi<any>('/api/settings');
  const [rate, setRate] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (data?.ilsRate) setRate(String(data.ilsRate)); }, [data]);

  const saveRate = async () => {
    setMsg(null);
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ilsRate: rate ? Number(rate) : null }) });
      setMsg('נשמר'); reload();
    } catch (e) { setMsg((e as Error).message); }
  };

  return (
    <Shell title="הגדרות">
      {data && (
        <div className="grid two">
          <BrokerCard />
          <div className="card">
            <h2>סביבת מסחר</h2>
            <p className="small">מצב: <b>Paper בלבד</b> · כתובת: <span className="num">{data.brokerUrl}</span></p>
            <p className="small">הון בסיס לחישובי סיכון: <span className="num">${data.capitalBaseUsd}</span></p>
            <p className="muted small">חיבור Live חסום בקוד (paperGuard). מפתחות שמתחילים ב-AK (Live) נדחים.</p>
          </div>

          <div className="card">
            <h2>תצוגת ש״ח (מידע בלבד)</h2>
            <p className="muted small">שער ידני. המערכת לא שולפת שער אוטומטית בגרסה זו — כל הסכומים האמיתיים נשארים בדולר.</p>
            <div className="row">
              <input className="input num" style={{ maxWidth: 140 }} inputMode="decimal" placeholder="לדוגמה 3.70" value={rate} onChange={(e) => setRate(e.target.value)} />
              <button className="btn" onClick={saveRate}>שמור</button>
              {msg && <span className="small">{msg}</span>}
            </div>
          </div>

          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <h2>מפתחות API (צד שרת בלבד)</h2>
            <p className="muted small">
              הערך נשלח פעם אחת לשרת, מוצפן ב-AES-256-GCM ונשמר ב-DB. הוא לעולם לא מוחזר לדפדפן — רק 4 תווים אחרונים.
              אל תשתף מפתחות בצ׳אט, באימייל או ב-Git. אפשר במקום זה להגדיר אותם בקובץ <span className="num">.env</span> בשרת.
            </p>
            {data.secrets.map((s: any) => <SecretRow key={s.name} s={s} onSaved={reload} />)}
            <p className="muted small" style={{ marginBottom: 0 }}>אחרי שמירת שני מפתחות Alpaca — לחץ "בדוק וסנכרן עכשיו" למעלה.</p>
          </div>

          <div className="card">
            <h2>התראות</h2>
            <p className="muted small">ממשק מוכן ב-DB; שליחה בפועל (Email / WhatsApp דרך הגייטוויי שלך) תחובר בשלב ז ורק אחרי הגדרת ספק מאושר. כרגע לא נשלחות הודעות.</p>
          </div>
          <div className="card">
            <h2>שעות פעילות</h2>
            <p className="small">ברירת מחדל: <span className="num">{data.activeHours.from}–{data.activeHours.to}</span> (שעון ישראל). המנוע יכבד גם את שעון הבורסה של Alpaca.</p>
          </div>
        </div>
      )}
    </Shell>
  );
}
