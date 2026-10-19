'use client';
import Shell, { Soon } from '@/components/Shell';
export default function Page() {
  return (
    <Shell title="דוחות">
      <Soon phase="שלב ו" what={[
        'דוח יומי ושבועי: תוצאה נטו אחרי עלויות',
        'Max Drawdown, Win Rate, Profit Factor',
        'Sharpe — רק כשיש מספיק נתונים',
        'השוואה לבנצ׳מרק SPY',
      ]} />
    </Shell>
  );
}
