'use client';
import Shell, { DemoBanner } from '@/components/Shell';
import EquityChart from '@/components/EquityChart';
import { dt, ils, signedUsd, tone, usd, useApi } from '@/lib/api';

const MODE_LABEL: Record<string, string> = { SAFE: 'מצב בטוח — לא פותח עסקאות', ACTIVE: 'פעיל', HALTED: 'עצור (Kill Switch)' };
const BROKER_LABEL: Record<string, string> = { not_configured: 'לא הוגדרו מפתחות (הגדרות)', ok: 'מחובר — Paper', error: 'שגיאת חיבור', unknown: 'לא ידוע' };

function Stat({ label, value, sub, cls = '' }: { label: string; value: string; sub?: string | null; cls?: string }) {
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className={`stat-value num ${cls}`}>{value}</div>
      {sub && <div className="stat-sub num">{sub}</div>}
    </div>
  );
}

export default function Dashboard() {
  const { data, error, loading } = useApi<any>('/api/dashboard', 30_000);
  const s = data?.summary;
  const rate = data?.ilsRate;

  return (
    <Shell title="דשבורד" actions={data?.isDemo && <span className="demo-badge">DEMO</span>}>
      {loading && <p className="muted">טוען…</p>}
      {error && <div className="banner danger">שגיאה בטעינה: {error}</div>}
      {data && (
        <>
          <DemoBanner show={data.isDemo} />
          {data.bot.killSwitch && <div className="banner danger"><b>Kill Switch פעיל.</b> {data.bot.killReason} — לא נשלחות פקודות חדשות.</div>}

          <div className="grid stats" style={{ marginBottom: 14 }}>
            <Stat label="שווי תיק" value={usd(s?.equity)} sub={ils(s?.equity, rate)} />
            <Stat label="מזומן זמין" value={usd(s?.cash)} sub={ils(s?.cash, rate)} />
            <Stat label="רווח/הפסד יומי" value={signedUsd(s?.dayPl)} cls={tone(s?.dayPl)} />
            <Stat label="רווח/הפסד החודש" value={signedUsd(s?.monthPl)} cls={tone(s?.monthPl)} />
            <Stat label="ממומש (מצטבר)" value={signedUsd(s?.realizedPl)} cls={tone(s?.realizedPl)} />
            <Stat label="לא ממומש" value={signedUsd(s?.unrealizedPl)} cls={tone(s?.unrealizedPl)} sub={`${s?.openPositions ?? 0} פוזיציות פתוחות`} />
          </div>

          <div className="grid two" style={{ marginBottom: 14 }}>
            <div className="card" style={{ gridColumn: '1 / -1' }}>
              <h2>שווי התיק לאורך זמן</h2>
              <EquityChart series={data.series} benchLabel={data.isDemo ? 'בנצ׳מרק DEMO (בדוי)' : 'SPY (מנורמל)'} />
              {s && <p className="muted small" style={{ marginBottom: 0 }}>עודכן: {dt(s.asOf)}</p>}
            </div>
          </div>

          <div className="grid two">
            <div className="card">
              <h2>מצב המערכת</h2>
              <div className="grid" style={{ gap: 10 }}>
                <div className="row"><span className="muted" style={{ width: 120 }}>סביבה</span><span className="pill"><span className="dot ok" />Paper בלבד</span></div>
                <div className="row"><span className="muted" style={{ width: 120 }}>Alpaca</span>
                  <span className="pill"><span className={`dot ${data.broker.status === 'ok' ? 'ok' : data.broker.status === 'error' ? 'bad' : 'warn'}`} />{BROKER_LABEL[data.broker.status]}</span></div>
                <div className="row"><span className="muted" style={{ width: 120 }}>מצב בוט</span>
                  <span className="pill"><span className={`dot ${data.bot.mode === 'ACTIVE' ? 'ok' : data.bot.mode === 'HALTED' ? 'bad' : 'warn'}`} />{MODE_LABEL[data.bot.mode]}</span></div>
                {data.lastSyncAt && <div className="row"><span className="muted" style={{ width: 120 }}>סנכרון אחרון</span><span className="small">{dt(data.lastSyncAt)}</span></div>}
                <div className="row"><span className="muted" style={{ width: 120 }}>מנוע (Worker)</span>
                  <span className="pill"><span className={`dot ${data.bot.workerAlive ? 'ok' : 'bad'}`} />{data.bot.workerAlive ? 'רץ' : 'לא מגיב'}</span>
                  <span className="muted small">דופק אחרון: {dt(data.bot.workerHeartbeatAt)}</span></div>
              </div>
            </div>
            <div className="card">
              <h2>שעות מסחר (ארה״ב)</h2>
              <div className="row" style={{ marginBottom: 8 }}>
                <span className="pill"><span className={`dot ${data.market.isOpen ? 'ok' : 'warn'}`} />{data.market.isOpen ? 'השוק פתוח' : 'השוק סגור'}</span>
              </div>
              <div className="small">שעה בניו יורק: <span className="num">{data.market.nyTime}</span> · בישראל: <span className="num">{data.market.ilTime}</span></div>
              {data.market.source === 'alpaca' ? (
                <div className="small">{data.market.isOpen ? <>נסגר: <span className="num">{data.market.nextCloseIL}</span></> : <>נפתח: <span className="num">{data.market.nextOpenIL}</span></>} (שעון ישראל)</div>
              ) : (
                <div className="small">מסחר רגיל היום (שעון ישראל): <span className="num">{data.market.opensAtIL}–{data.market.closesAtIL}</span></div>
              )}
              <p className="muted small" style={{ marginBottom: 0 }}>{data.market.note}</p>
            </div>
          </div>
          {!rate && <p className="muted small">להצגת ערכים בש״ח — הגדר שער ידני בהגדרות (מידע בלבד).</p>}
        </>
      )}
    </Shell>
  );
}
