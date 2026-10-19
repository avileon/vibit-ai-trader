import { parentPort, workerData } from 'node:worker_threads';
import { fullReport } from './report.js';
import { runCompare } from './compare.js';

// Runs a CPU-heavy backtest off the main event loop so the trading worker keeps its heartbeat and duties.
const { bars, cfg, withWalkForward, kind } = workerData;
const progress = (s: string) => parentPort?.postMessage({ type: 'progress', s });
const report = kind === 'compare'
  ? runCompare(bars, { start: cfg.start, end: cfg.end, capital: cfg.capital, limits: cfg.limits, slippageBps: cfg.slippageBps, feePerOrder: cfg.feePerOrder, universe: cfg.universe, benchmark: cfg.benchmark }, progress)
  : fullReport(bars, cfg, withWalkForward, progress);
parentPort?.postMessage({ type: 'done', report });
