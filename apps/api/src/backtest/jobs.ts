import { z } from 'zod';
import { getPool, type Row } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import type { BrokerTrader } from '../broker/alpacaClient.js';
import { currentLimits } from '../routes/control.js';
import { STRATEGY_PARAMS, STRATEGY_VERSION } from '../strategy/momentumTrend.js';
import { BENCHMARK, UNIVERSE } from '../strategy/universe.js';
import { addDays, ensureBars, loadBars } from './data.js';
import { Worker } from 'node:worker_threads';
import { fullReport } from './report.js';
import type { BacktestConfig } from './engine.js';
import type { DailyBar } from '../strategy/indicators.js';

/** In production (compiled .js) run in a worker thread; under tsx/tests run inline. */
function runReport(bars: Record<string, DailyBar[]>, cfg: BacktestConfig, wf: boolean, progress: (s: string) => void): Promise<ReturnType<typeof fullReport>> {
  if (!import.meta.url.endsWith('.js')) return Promise.resolve(fullReport(bars, cfg, wf, progress));
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./thread.js', import.meta.url), { workerData: { bars, cfg, withWalkForward: wf } });
    w.on('message', (m: { type: string; s?: string; report?: ReturnType<typeof fullReport> }) => {
      if (m.type === 'progress') progress(m.s!);
      if (m.type === 'done') resolve(m.report!);
    });
    w.on('error', reject);
    w.on('exit', (code) => { if (code !== 0) reject(new Error(`backtest thread exited ${code}`)); });
  });
}

export const backtestRequestSchema = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default('2017-01-01'),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  slippageBps: z.number().min(0).max(100).default(5),
  feePerOrder: z.number().min(0).max(5).default(0.02),
  walkForward: z.boolean().default(true),
});
export type BacktestRequest = z.infer<typeof backtestRequestSchema>;

export async function enqueueBacktest(req: BacktestRequest, user: string): Promise<number> {
  const [r] = await getPool().query("INSERT INTO backtest_runs (status, config, created_by) VALUES ('queued', ?, ?)", [JSON.stringify(req), user]);
  return (r as { insertId: number }).insertId;
}

/** Called from the worker: runs at most one queued job. */
export async function runNextBacktest(broker: BrokerTrader): Promise<number | null> {
  const pool = getPool();
  const [q] = await pool.query<Row[]>("SELECT id, config FROM backtest_runs WHERE status='queued' ORDER BY id LIMIT 1");
  if (!q.length) return null;
  const id = q[0].id as number;
  const [claimed] = await pool.query("UPDATE backtest_runs SET status='running', progress='מתחיל' WHERE id=? AND status='queued'", [id]);
  if ((claimed as { affectedRows: number }).affectedRows === 0) return null;
  const progress = (s: string) => { pool.query('UPDATE backtest_runs SET progress=? WHERE id=?', [s.slice(0, 250), id]).catch(() => {}); };
  try {
    const req = backtestRequestSchema.parse(typeof q[0].config === 'string' ? JSON.parse(q[0].config) : q[0].config);
    const yesterday = addDays(new Date().toISOString().slice(0, 10), -1);
    const end = req.end && req.end < yesterday ? req.end : yesterday;
    const dataFrom = addDays(req.start, -400); // warm-up for SMA200 / momentum
    const symbols = [...UNIVERSE, BENCHMARK];
    await ensureBars(broker, symbols, dataFrom < '2016-01-01' ? '2016-01-01' : dataFrom, yesterday, progress);
    const bars = await loadBars(symbols, '2015-01-01', yesterday);
    const { limits } = await currentLimits();
    progress('מריץ סימולציה');
    const report = await runReport(bars, {
      start: req.start, end, capital: limits.capitalBaseUsd, limits, params: STRATEGY_PARAMS, slippageBps: req.slippageBps,
      feePerOrder: req.feePerOrder, maxChase: 0.02, universe: [...UNIVERSE], benchmark: BENCHMARK, haltOnDrawdown: true,
    }, req.walkForward, progress);
    const result = {
      strategyVersion: STRATEGY_VERSION, params: STRATEGY_PARAMS, period: { start: req.start, end }, dataFeed: 'SIP (Alpaca), adjusted for splits+dividends',
      assumptions: {
        timing: 'החלטה בסגירת יום t עם נתונים עד t בלבד; ביצוע בפתיחת יום t+1',
        slippageBps: req.slippageBps, feePerOrder: req.feePerOrder,
        stops: 'סטופ שנפרץ בפער פתיחה מבוצע במחיר הפתיחה (לא במחיר הסטופ)',
        sameDay: 'אם סטופ ויעד נגעו באותו יום — מניחים סטופ (שמרני)',
      },
      caveats: [
        'הטיית שרידות (Survivorship): רשימת הנכסים נבחרה היום — אלה חברות/קרנות ששרדו. תוצאות העבר עלולות להיות אופטימיות.',
        'בדיקה היסטורית אינה תחזית. שווקים משתנים; תוצאה טובה בעבר לא מבטיחה עתיד.',
        'מסחר אמיתי כולל עיכובים, מילוי חלקי ופערים שהסימולציה לא תופסת במלואם.',
      ],
      ...report,
    };
    await pool.query("UPDATE backtest_runs SET status='done', result=?, progress='הסתיים', finished_at=UTC_TIMESTAMP() WHERE id=?", [JSON.stringify(result), id]);
    await audit('worker', 'backtest.done', { id });
  } catch (e) {
    await pool.query("UPDATE backtest_runs SET status='error', error=?, finished_at=UTC_TIMESTAMP() WHERE id=?", [(e as Error).message.slice(0, 490), id]);
  }
  return id;
}
