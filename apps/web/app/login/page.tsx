'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      router.replace('/');
    } catch (e) {
      const m = (e as Error).message;
      setErr(m.includes('Rate limit') || m.includes('429') ? 'יותר מדי ניסיונות. נסה שוב בעוד דקה.' : m);
    } finally { setBusy(false); }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand" style={{ margin: 0 }}>VIBIT AI Trader</div>
        <p className="muted small" style={{ marginTop: 4 }}>מערכת Paper Trading בלבד — ללא כסף אמיתי</p>
        <div className="field">
          <label htmlFor="email">אימייל</label>
          <input id="email" className="input num" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pw">סיסמה</label>
          <input id="pw" className="input num" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn primary" style={{ width: '100%' }} disabled={busy}>{busy ? 'מתחבר…' : 'התחברות'}</button>
      </form>
    </div>
  );
}
