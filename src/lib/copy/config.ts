import { z } from "zod";

/** Risk & sizing rules for the copy engine. Stored in app_settings ("risk"). */
export const RiskConfigSchema = z.object({
  /** Skip buys above this price (little upside left, bad risk/reward). */
  maxEntryPrice: z.number().min(0).max(1).default(0.92),
  /** Skip buys below this price (lottery tickets; thin books). */
  minEntryPrice: z.number().min(0).max(1).default(0.03),
  /** Max price move (in price points) we accept vs. the leader's fill. */
  maxPriceDrift: z.number().min(0).max(0.5).default(0.03),
  /** Don't open positions in markets ending sooner than this. */
  minMinutesToEnd: z.number().min(0).default(10),
  /** Ignore leader trades older than this (e.g. after downtime). */
  maxSignalAgeSeconds: z.number().int().min(30).default(600),
  /**
   * proportional: our stake = equity × (leader stake ÷ leader portfolio) × multiplier × weight
   * fixed: always `fixedUsd` × weight
   */
  sizingMode: z.enum(["proportional", "fixed"]).default("proportional"),
  proportionalMultiplier: z.number().min(0).max(10).default(1),
  fixedUsd: z.number().min(1).default(25),
  /** Smallest order worth placing. */
  minOrderUsd: z.number().min(0).default(1),
  /** Ignore leader trades smaller than this (dust / order-splitting noise). */
  minLeaderUsd: z.number().min(0).default(25),
  /**
   * Floor for proportional copies of meaningful trades. Whales commit tiny fractions of
   * huge books, which would round to $0 on a small bankroll. Risk caps still apply.
   */
  minCopyUsd: z.number().min(0).default(5),
  /** Caps as fractions of current equity. */
  maxPositionPct: z.number().min(0).max(1).default(0.1),
  maxTraderExposurePct: z.number().min(0).max(1).default(0.3),
  /** Stop opening new positions after losing this fraction of equity today (UTC). */
  maxDailyLossPct: z.number().min(0).max(1).default(0.1),
  /** Mirror leader sells proportionally. */
  copySells: z.boolean().default(true),
  /** Extra flat fee on simulated fills, in bps, on top of each market's Polymarket taker fee. */
  takerFeeBps: z.number().min(0).max(1000).default(0),

  // --- Speed -------------------------------------------------------------------------
  /** How often the engine polls every leader (the safety net behind the live feed). */
  tickIntervalSeconds: z.union([z.literal(15), z.literal(30), z.literal(60)]).default(30),
  /** Copy from Polymarket's real-time trade feed (seconds) instead of only polling. */
  realtime: z.boolean().default(true),
  /**
   * Re-check trades skipped because the price ran away or the book was empty. Big leader
   * orders often sweep a thin book; sellers usually return within minutes. Retries stop
   * once the trade is older than `maxSignalAgeSeconds`.
   */
  retrySkipped: z.boolean().default(true),

  // --- Hedging ("cancel out" a losing copy) -------------------------------------------
  /**
   * off: never hedge automatically.
   * lock: buy as many opposite shares as we hold, so the result no longer depends on the
   *       outcome (locks in today's loss, stops it growing).
   * breakeven: buy enough opposite shares that we lose nothing if the market flips.
   */
  autoHedge: z.enum(["off", "lock", "breakeven"]).default("off"),
  /** Hedge once a copied position is down this fraction of what it cost. */
  hedgeTriggerLossPct: z.number().min(0.05).max(1).default(0.3),
  /** Never spend more than this fraction of equity on one hedge. */
  hedgeMaxCostPct: z.number().min(0).max(1).default(0.05),
  /** Don't hedge when the opposite side costs more than this (too expensive to help). */
  hedgeMaxPrice: z.number().min(0.05).max(0.99).default(0.85),
});

export type RiskConfig = z.infer<typeof RiskConfigSchema>;
export const DEFAULT_RISK_CONFIG: RiskConfig = RiskConfigSchema.parse({});
export const TICK_INTERVALS = [15, 30, 60] as const;
