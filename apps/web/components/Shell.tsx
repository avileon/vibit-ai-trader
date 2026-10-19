'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api } from '@/lib/api';

const NAV = [
  { href: '/', label: 'דשבורד', icon: '◧' },
  { href: '/portfolio', label: 'תיק השקעות', icon: '◫' },
  { href: '/orders', label: 'הוראות ועסקאות', icon: '⇄' },
  { href: '/risk', label: 'מרכז סיכונים', icon: '⛨' },
  { href: '/analyst', label: 'AI Analyst', icon: '✦', soon: 'שלב ה' },
  { href: '/strategy', label: 'Strategy Lab', icon: '⚗', soon: 'שלב ו' },
  { href: '/reports', label: 'דוחות', icon: '▤', soon: 'שלב ו' },
  { href: '/learn', label: 'מרכז למידה', icon: '✎' },
  { href: '/settings', label: 'הגדרות', icon: '⚙' },
];

export default function Shell({ title, actions, children }: { title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    router.replace('/login');
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">VIBIT AI Trader</div>
        <div className="brand-sub">Paper Trading בלבד · אין כסף אמיתי</div>
        <nav className="nav">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={path === n.href ? 'active' : ''}>
              <span aria-hidden>{n.icon}</span>
              {n.label}
              {n.soon && <span className="soon">{n.soon}</span>}
            </Link>
          ))}
        </nav>
        <button className="btn" style={{ marginTop: 18, width: '100%' }} onClick={logout}>התנתקות</button>
      </aside>
      <div>
        <nav className="mobile-nav">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={path === n.href ? 'active' : ''}>{n.label}</Link>
          ))}
          <a href="#" onClick={(e) => { e.preventDefault(); logout(); }}>התנתקות</a>
        </nav>
        <main className="main">
          <div className="topbar">
            <h1>{title}</h1>
            {actions}
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}

export function Soon({ phase, what }: { phase: string; what: string[] }) {
  return (
    <div className="card">
      <div className="banner warn" style={{ marginBottom: 12 }}>
        המסך הזה <b>עדיין לא פעיל</b> — ייבנה ב{phase}. לא מוצגים כאן נתונים מדומים כדי לא ליצור רושם שהרכיב עובד.
      </div>
      <h2>מה ייכלל</h2>
      <ul className="clean">{what.map((w) => <li key={w}>{w}</li>)}</ul>
    </div>
  );
}

export function DemoBanner({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="banner demo">
      <span className="demo-badge">DEMO</span>{' '}
      הנתונים במסך הם <b>נתוני הדגמה בדויים</b> (סמלים DEMO-A/B/C). הם לא מחירי שוק ולא תוצאות של הבוט.
      נתונים אמיתיים יופיעו אחרי הזנת מפתחות Alpaca Paper בהגדרות ובדיקת חיבור.
    </div>
  );
}
