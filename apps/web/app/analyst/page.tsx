'use client';
import Shell, { Soon } from '@/components/Shell';
export default function Page() {
  return (
    <Shell title="AI Analyst">
      <Soon phase="שלב ה" what={[
        'רשימת מועמדים מתוך ה-Screener (נתונים מאומתים מ-Alpaca בלבד)',
        'נתוני שוק לכל מועמד + גיל הנתון',
        'הסבר Claude בעברית בפורמט JSON מאומת (Schema)',
        'רמת ביטחון מחושבת על ידי חוקים — לא "תחושה" של המודל',
        'מגבלות הניתוח: מה לא ידוע, מה חסר',
        'תיעוד Prompt Version, Model, נתוני קלט ועלות',
      ]} />
    </Shell>
  );
}
