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
  /**
   * Wins vs. price-implied expectation, in standard deviations. Shown and part of the score;
   * no longer a pass/fail check (the sequential skill test decides, audit R2).
   */
  minZ: z.number().default(2),
  /**
   * Sequential skill test (owner decision 2026-11-09, design S2): smallest edge worth
   * copying, in win-probability points. A Candidate is Rejected once their post-pick bets
   * show, with 95% confidence, an edge below this.
   */
  minEdge: z.number().min(0.01).max(0.3).default(0.05),
  /** A Candidate not proven skilled this many days after the holdout began is Rejected. */
  maxCandidateDays: z.number().int().min(30).default(180),
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
  /** Added to the delayed mid price to approximate crossing the spread (price points). */
  copySlippage: z.number().min(0).max(0.1).default(0.01),
  minCopyAdjRoi: z.number().default(0),
  /**
   * The copy check uses a cautious copy return: the stake-weighted average minus this many
   * standard errors (1.28 ≈ 90% one-sided confidence; 0 = the plain average). A few big
   * bets can dominate the average, so it is noisy.
   */
  copyRoiZ: z.number().min(0).max(3).default(1.28),
  /**
   * Hard guard (owner decision 2026-11-09): Rejected when copying clearly loses money — the
   * stake-weighted copy return plus this many standard errors is still below 0. The skill
   * test counts bets, not dollars, so this is what catches "many small wins, big losses".
   */
  copyLossZ: z.number().min(0).max(4).default(2),
  /** Fewer replayed copies than this = not enough evidence; the copy check can't pass. */
  minCopyReplays: z.number().int().min(1).default(25),
  /** Replay only leader buys at least this big (the copy engine ignores smaller ones). */
  minReplayLeaderUsd: z.number().min(0).default(25),
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

/**
 * Bot check, recent part (owner decision 2026-11-08, "mostly"): a wallet whose last 30 days
 * are more than this share redeems / merges / conversions is a bot, not a copyable trader.
 * Shared by scoring and the backtest's baseline.
 */
export const MAX_REDEEM_MERGE_SHARE = 0.5;

export const DEFAULT_SCORING_CONFIG: ScoringConfig = ScoringConfigSchema.parse({});
