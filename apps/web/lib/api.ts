'use client';
import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error {
  constructor(public status: number, public body: any) {
    super(body?.message || body?.error || `HTTP ${status}`);
  }
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-vibit-csrf': '1', ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && typeof window !== 'undefined' && !path.includes('/auth/login')) {
    window.location.href = '/login';
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export function useApi<T = any>(path: string | null, refreshMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    load();
    if (!refreshMs) return;
    const t = setInterval(load, refreshMs);
    return () => clearInterval(t);
  }, [load, refreshMs]);
  return { data, error, loading, reload: load };
}

const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
const ilsFmt = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });

export const usd = (n: number | null | undefined) => (n == null ? '—' : usdFmt.format(n));
export const signedUsd = (n: number | null | undefined) => (n == null ? '—' : `${n > 0 ? '+' : ''}${usdFmt.format(n)}`);
export const ils = (n: number | null | undefined, rate: number | null | undefined) =>
  n == null || !rate ? null : ilsFmt.format(n * rate);
export const pct = (n: number | null | undefined) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`);
export const dt = (s: string | null | undefined) =>
  s ? new Intl.DateTimeFormat('he-IL', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Jerusalem' }).format(new Date(s)) : '—';
export const tone = (n: number | null | undefined) => (n == null || n === 0 ? '' : n > 0 ? 'pos' : 'neg');
