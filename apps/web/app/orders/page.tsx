'use client';
import Shell, { DemoBanner } from '@/components/Shell';
import { dt, usd, useApi } from '@/lib/api';

const STATUS: Record<string, string> = { filled: 'בוצע', partially_filled: 'בוצע חלקית', canceled: 'בוטל', rejected: 'נדחה', new: 'חדש', accepted: 'התקבל', expired: 'פג תוקף' };

export default function Orders() {
  const { data, error } = useApi<any>('/api/orders', 30_000);
  return (
    <Shell title="הוראות ועסקאות">
      {error && <div className="banner danger">{error}</div>}
      {data && (
        <>
          <DemoBanner show={data.isDemo} />
          <div className="card">
            {data.orders.length === 0 ? <p className="muted">אין הוראות עדיין.</p> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>זמן</th><th>סימול</th><th>צד</th><th>סוג</th><th>כמות</th><th>בוצע</th><th>לימיט</th><th>סטופ</th><th>מחיר ביצוע</th><th>סטטוס</th><th>עמלה משוערת</th><th>סיבה</th><th>מזהה (client / Alpaca)</th></tr></thead>
                  <tbody>
                    {data.orders.map((o: any) => (
                      <tr key={o.client_order_id}>
                        <td>{dt(o.submitted_at)}</td>
                        <td><b>{o.symbol}</b></td>
                        <td>{o.side === 'buy' ? 'קנייה' : 'מכירה'}</td>
                        <td className="num">{o.type}{o.order_class ? ` / ${o.order_class}` : ''} · {o.time_in_force}</td>
                        <td className="num">{o.qty}</td>
                        <td className="num">{o.filled_qty}</td>
                        <td className="num">{usd(o.limit_price)}</td>
                        <td className="num">{usd(o.stop_price)}</td>
                        <td className="num">{usd(o.filled_avg_price)}</td>
                        <td>{STATUS[o.status] ?? o.status}</td>
                        <td className="num">{usd(o.est_fees)}</td>
                        <td style={{ whiteSpace: 'normal', minWidth: 220 }}>{o.reason}</td>
                        <td className="num small muted">{o.client_order_id}{o.alpaca_order_id ? ` / ${o.alpaca_order_id}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted small" style={{ marginBottom: 0 }}>Alpaca לא גובה עמלת מסחר על מניות, אך יש עמלות רגולטוריות קטנות במכירה (SEC/FINRA TAF). "עמלה משוערת" היא הערכה בלבד.</p>
          </div>
        </>
      )}
    </Shell>
  );
}
