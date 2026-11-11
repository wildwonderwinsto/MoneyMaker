import { z } from "zod";

/**
 * Thresholds for verifying a trader. Stored in app_settings ("scoring") and editable
 * from the Settings page; every field has a sensible default.
 */
export const ScoringConfigSchema = z
  .object({
    /** Minimum resolved markets (sample size). */
    minResolved: z.number().int().min(1).default(50),
    /** Minimum distinct events, so 40 bets on one election don't count as 40 samples. */
    minEvents: z.number().int().min(1).default(25),
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
    /** Entry prices outside this band are near-certain and excluded from skill tests. */
    minEntryPrice: z.number().min(0).max(1).default(0.02),
    maxEntryPrice: z.number().min(0).max(1).default(0.98),
    /** ROI shrinkage strength: roiShrunk = roi * n / (n + k). */
    roiShrinkK: z.number().min(0).max(1000).default(30),
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
    /** Above 0: at 0 or below every trader would count as a bot. */
    maxTradesPerDay: z.number().gt(0).default(200),
    maxBothSidesRatio: z.number().min(0).max(1).default(0.3),
    minMedianHoldHours: z.number().min(0).default(2),
    /** Recent performance (out of sample) and activity. */
    oosDays: z.number().int().min(7).default(60),
    minOosRoi: z.number().default(0),
    maxDaysSinceTrade: z.number().int().min(1).default(14),
    /** Composite score needed for the Elite tier (0–100). */
    eliteScore: z.number().min(0).max(100).default(70),
    /**
     * Proven tier (owner, 2026-11-10): a Verified/Elite trader whose copies since they became
     * Verified (replayed like the copy check) cover at least this many days…
     */
    provenMinDays: z.number().int().min(14).max(365).default(30),
    /**
     * …and at least this many copied bets, with a cautious copy return (copyRoiZ) above 0.
     * At most 150: the since-Verified sample is capped at the job's replaysPerTrader (150),
     * so a higher bar could never be met.
     */
    provenMinCopies: z.number().int().min(20).max(150).default(50),
  })
  .refine((c) => c.minEntryPrice <= c.maxEntryPrice, {
    message: "Minimum entry price can't be above the maximum entry price",
    path: ["minEntryPrice"],
  });

export type ScoringConfig = z.infer<typeof ScoringConfigSchema> & {
  /**
   * Not a setting (removed in batch 6: nothing depends on it): Monte Carlo draws for the
   * display-only luck p-value. Defaults to MC_SIMULATIONS; quick internal runs pass fewer.
   */
  simulations?: number;
};

/**
 * Bot check, recent part (owner decision 2026-11-08, "mostly"): a wallet whose last 30 days
 * are more than this share redeems / merges / conversions is a bot, not a copyable trader.
 * Shared by scoring and the backtest's baseline.
 */
export const MAX_REDEEM_MERGE_SHARE = 0.5;

export const DEFAULT_SCORING_CONFIG: ScoringConfig = ScoringConfigSchema.parse({});
