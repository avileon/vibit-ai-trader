import { z } from 'zod';

/** ספי סיכון ראשוניים. ראו docs/ARCHITECTURE.md §5 לנימוקים. */
export const riskLimitsSchema = z.object({
  capitalBaseUsd: z.number().positive(),
  riskPerTradePct: z.number().positive().max(2),
  maxPositionPct: z.number().positive().max(50),
  maxTotalExposurePct: z.number().positive().max(100),
  maxOpenPositions: z.number().int().positive().max(10),
  dailyLossLimitPct: z.number().positive().max(10),
  killSwitchDrawdownPct: z.number().positive().max(20),
  minPriceUsd: z.number().nonnegative(),
  minAvgDollarVolumeUsd: z.number().nonnegative(),
  maxSpreadPct: z.number().positive(),
  maxQuoteAgeSec: z.number().int().positive(),
  noTradeOpenCloseMinutes: z.number().int().nonnegative(),
  wholeSharesOnly: z.boolean(),
  allowShort: z.literal(false),
  allowMargin: z.literal(false),
  allowOptions: z.literal(false),
  allowCrypto: z.literal(false),
  allowExtendedHours: z.literal(false),
  /** Limits for allocation strategies (SPY + trend filter). Older stored versions lack it → conservative default. */
  allocation: z.object({
    maxExposurePct: z.number().positive().max(100),
    fractional: z.boolean(),
    symbols: z.array(z.string().regex(/^[A-Z]{1,5}$/)).min(1).max(5),
  }).default({ maxExposurePct: 60, fractional: false, symbols: ['SPY'] }),
});
export type RiskLimits = z.infer<typeof riskLimitsSchema>;

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  capitalBaseUsd: 1000,
  riskPerTradePct: 1,
  maxPositionPct: 20,
  maxTotalExposurePct: 60,
  maxOpenPositions: 3,
  dailyLossLimitPct: 2,
  killSwitchDrawdownPct: 5,
  minPriceUsd: 5,
  minAvgDollarVolumeUsd: 20_000_000,
  maxSpreadPct: 0.15,
  maxQuoteAgeSec: 60,
  noTradeOpenCloseMinutes: 15,
  wholeSharesOnly: true,
  allowShort: false,
  allowMargin: false,
  allowOptions: false,
  allowCrypto: false,
  allowExtendedHours: false,
  allocation: { maxExposurePct: 60, fractional: false, symbols: ['SPY'] },
};

export function killSwitchThreshold(l: RiskLimits): number {
  return +(l.capitalBaseUsd * (1 - l.killSwitchDrawdownPct / 100)).toFixed(2);
}

export function riskBudgetPerTrade(l: RiskLimits, equity: number): number {
  return +(Math.min(equity, l.capitalBaseUsd) * (l.riskPerTradePct / 100)).toFixed(2);
}
