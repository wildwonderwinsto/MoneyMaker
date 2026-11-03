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
  /** Taker fee applied to simulated fills, in basis points. */
  takerFeeBps: z.number().min(0).max(1000).default(0),
});

export type RiskConfig = z.infer<typeof RiskConfigSchema>;
export const DEFAULT_RISK_CONFIG: RiskConfig = RiskConfigSchema.parse({});
