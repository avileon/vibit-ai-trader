import { parentPort, workerData } from 'node:worker_threads';
import { fullReport } from './report.js';

// Runs a CPU-heavy backtest off the main event loop so the trading worker keeps its heartbeat and duties.
const { bars, cfg, withWalkForward } = workerData;
const report = fullReport(bars, cfg, withWalkForward, (s) => parentPort?.postMessage({ type: 'progress', s }));
parentPort?.postMessage({ type: 'done', report });
