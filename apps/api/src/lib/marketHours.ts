/**
 * הערכת שעות מסחר רגילות של NYSE/NASDAQ (9:30–16:00 שעון ניו יורק, ב'–ו').
 * לא כולל חגים וימים מקוצרים! בשלב ג המקור הקובע יהיה Alpaca /v2/clock + /v2/calendar.
 * לכן התוצאה מסומנת source: 'estimate'.
 */
export interface MarketSession {
  isOpen: boolean;
  source: 'estimate' | 'alpaca';
  nyTime: string;
  ilTime: string;
  opensAtIL: string;
  closesAtIL: string;
  note: string;
}

function partsIn(tz: string, d: Date) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return o;
}

/** offset (minutes) of tz relative to UTC at instant d */
function tzOffsetMin(tz: string, d: Date): number {
  const p = partsIn(tz, d);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return Math.round((asUtc - Math.floor(d.getTime() / 60000) * 60000) / 60000);
}

function fmt(tz: string, d: Date): string {
  return new Intl.DateTimeFormat('he-IL', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

export function estimateMarketSession(now = new Date()): MarketSession {
  const ny = partsIn('America/New_York', now);
  const minutes = +ny.hour * 60 + +ny.minute;
  const weekday = ny.weekday;
  const isWeekday = !['Sat', 'Sun'].includes(weekday);
  const isOpen = isWeekday && minutes >= 9 * 60 + 30 && minutes < 16 * 60;

  // build today's open/close instants in NY
  const off = tzOffsetMin('America/New_York', now);
  const dayUtc = Date.UTC(+ny.year, +ny.month - 1, +ny.day);
  const openAt = new Date(dayUtc + (9 * 60 + 30 - off) * 60000);
  const closeAt = new Date(dayUtc + (16 * 60 - off) * 60000);

  return {
    isOpen,
    source: 'estimate',
    nyTime: fmt('America/New_York', now),
    ilTime: fmt('Asia/Jerusalem', now),
    opensAtIL: fmt('Asia/Jerusalem', openAt),
    closesAtIL: fmt('Asia/Jerusalem', closeAt),
    note: 'הערכה בלבד — לא כולל חגים וימים מקוצרים. יוחלף בשעון Alpaca בשלב ג.',
  };
}
