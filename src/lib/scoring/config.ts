import { z } from "zod";

/**
 * Thresholds for verifying a trader. Stored in app_settings ("scoring") and editable
 * from the Settings page; every field has a sensible default.
 */
export const ScoringConfigSchema = z.object({
  /** Minimum resolved markets (sample size). */
  minResolved: z.number().int().min(1).default(50),
  /** Minimum distinct events, so 40 bets on one election don't count as 40 samples. */
  minEvents: z.number().int().min(1).default(25),
  /** Wins vs. price-implied expectation, in standard deviations. */
  minZ: z.number().default(2),
  /** False discovery rate for the Monte Carlo skill test across all candidates. */
  fdrQ: z.number().min(0).max(1).default(0.1),
  /** Outcome simulations per trader for the randomization test. */
  simulations: z.number().int().min(100).max(20000).default(2000),
  /** Entry prices outside this band are near-certain and excluded from skill tests. */
  minEntryPrice: z.number().default(0.02),
  maxEntryPrice: z.number().default(0.98),
  /** ROI shrinkage strength: roiShrunk = roi * n / (n + k). */
  roiShrinkK: z.number().min(0).default(30),
  minRoiShrunk: z.number().default(0.05),
  /** One-hit-wonder guards (share of gross profit). */
  maxTopMarketShare: z.number().min(0).max(1).default(0.25),
  maxTop3Share: z.number().min(0).max(1).default(0.5),
  /** Consistency. */
  minMonths: z.number().int().min(1).default(3),
  minProfitableMonthsPct: z.number().min(0).max(1).default(0.6),
  /** Net profit / worst peak-to-trough drawdown (scale-free). */
  minRecoveryFactor: z.number().default(2),
  /** Copyability. */
  copyDelaySeconds: z.number().int().min(0).default(120),
  minCopyAdjRoi: z.number().default(0),
  maxTradesPerDay: z.number().default(200),
  maxBothSidesRatio: z.number().min(0).max(1).default(0.3),
  minMedianHoldHours: z.number().min(0).default(2),
  /** Recent performance (out of sample) and activity. */
  oosDays: z.number().int().min(7).default(60),
  minOosRoi: z.number().default(0),
  maxDaysSinceTrade: z.number().int().min(1).default(14),
  /** Composite score needed for the Elite tier (0–100). */
  eliteScore: z.number().min(0).max(100).default(70),
});

export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;

export const DEFAULT_SCORING_CONFIG: ScoringConfig = ScoringConfigSchema.parse({});
