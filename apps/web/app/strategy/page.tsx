'use client';
import Shell, { Soon } from '@/components/Shell';
export default function Page() {
  return (
    <Shell title="Strategy Lab">
      <Soon phase="שלב ו" what={[
        'Momentum + פילטר מגמה (גרסה v1) עם פרמטרים קבועים ושקופים',
        'Backtest ב-Python ללא Look-Ahead Bias',
        'Train / Validation / Test ו-Walk-Forward',
        'עלויות, Spread ו-Slippage מפורשים',
        'השוואה ל-SPY Buy & Hold',
      ]} />
    </Shell>
  );
}
