/**
 * Turns metrics into pass/fail checks, a 0–100 composite score and a tier.
 * Every check carries a plain-English label so the UI can explain each decision.
 */
import type { ScoreCheck, ScoreTier } from "@/lib/db/schema";

import type { ScoringConfig } from "./config";
import type { TraderMetrics } from "./metrics";
import { clamp } from "./stats";

export interface ScoreContext {
  /** Benjamini–Hochberg p-value threshold for this scoring run (0 = nothing significant). */
  mcPThreshold: number;
  /** Number of traders tested in this run (shown in the label). */
  candidates: number;
}

export interface ScoreResult {
  tier: ScoreTier;
  score: number;
  passed: boolean;
  checks: ScoreCheck[];
}

/** Failing any of these is disqualifying even for the watchlist. */
const HARD_CHECKS = new Set(["top_market", "bot_activity", "both_sides", "hold_time", "skill_z"]);

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function buildChecks(m: TraderMetrics, cfg: ScoringConfig, ctx: ScoreContext): ScoreCheck[] {
  const atLeast = (
    code: string,
    label: string,
    value: number | null,
    threshold: number,
    whenNull = false,
  ): ScoreCheck => ({
    code,
    label,
    value,
    threshold,
    ok: value === null ? whenNull : value >= threshold,
  });
  const atMost = (
    code: string,
    label: string,
    value: number | null,
    threshold: number,
    whenNull = false,
  ): ScoreCheck => ({
    code,
    label,
    value,
    threshold,
    ok: value === null ? whenNull : value <= threshold,
  });

  const oosValue = m.oosRoi ?? (m.oosPnl === null ? null : Math.sign(m.oosPnl));

  return [
    atLeast("sample", `At least ${cfg.minResolved} resolved markets`, m.nResolved, cfg.minResolved),
    atLeast(
      "events",
      `Spread over at least ${cfg.minEvents} different events`,
      m.nEvents,
      cfg.minEvents,
    ),
    atLeast(
      "skill_z",
      `Wins more often than prices predicted (z ≥ ${cfg.minZ})`,
      m.zSkill,
      cfg.minZ,
    ),
    {
      code: "skill_luck",
      label: `Profit beats random luck after testing ${ctx.candidates} traders (FDR ${pct(cfg.fdrQ)})`,
      value: m.mcPValue,
      threshold: ctx.mcPThreshold,
      ok: m.mcPValue !== null && ctx.mcPThreshold > 0 && m.mcPValue <= ctx.mcPThreshold,
    },
    atLeast(
      "roi",
      `Return on money risked ≥ ${pct(cfg.minRoiShrunk)} (adjusted for sample size)`,
      m.roiShrunk,
      cfg.minRoiShrunk,
    ),
    atMost(
      "top_market",
      `Biggest single win ≤ ${pct(cfg.maxTopMarketShare)} of all profits`,
      m.topMarketShare,
      cfg.maxTopMarketShare,
    ),
    atMost(
      "top3_markets",
      `Top 3 wins ≤ ${pct(cfg.maxTop3Share)} of all profits`,
      m.top3Share,
      cfg.maxTop3Share,
    ),
    atLeast("months", `Active for at least ${cfg.minMonths} months`, m.months, cfg.minMonths),
    atLeast(
      "profitable_months",
      `Profitable in ≥ ${pct(cfg.minProfitableMonthsPct)} of months`,
      m.profitableMonthsPct,
      cfg.minProfitableMonthsPct,
    ),
    atLeast(
      "recovery",
      `Net profit ≥ ${cfg.minRecoveryFactor}× the worst drawdown`,
      m.recoveryFactor,
      cfg.minRecoveryFactor,
    ),
    atMost(
      "bot_activity",
      `Not a high-frequency bot (≤ ${cfg.maxTradesPerDay} trades/day)`,
      m.tradesPerDay,
      cfg.maxTradesPerDay,
      true,
    ),
    atMost(
      "both_sides",
      `Not a market maker (buys both sides in ≤ ${pct(cfg.maxBothSidesRatio)} of markets)`,
      m.bothSidesRatio,
      cfg.maxBothSidesRatio,
    ),
    atLeast(
      "hold_time",
      `Holds positions long enough to copy (median ≥ ${cfg.minMedianHoldHours}h)`,
      m.medianHoldHours,
      cfg.minMedianHoldHours,
    ),
    atLeast(
      "copy_roi",
      `Still profitable when copied ${Math.round(cfg.copyDelaySeconds / 60)} min late`,
      m.copyAdjRoi,
      cfg.minCopyAdjRoi + Number.EPSILON,
    ),
    atLeast(
      "recent",
      `Still winning in the last ${cfg.oosDays} days (out of sample)`,
      oosValue,
      cfg.minOosRoi + Number.EPSILON,
    ),
    atMost(
      "active",
      `Traded in the last ${cfg.maxDaysSinceTrade} days`,
      m.daysSinceTrade,
      cfg.maxDaysSinceTrade,
    ),
  ];
}

/** Weighted composite (0–100). Higher = stronger, more reliable edge. */
export function compositeScore(m: TraderMetrics): number {
  const parts = [
    30 * clamp((m.zSkill ?? 0) / 4),
    20 * clamp((m.roiShrunk ?? 0) / 0.3),
    15 * (m.profitableMonthsPct ?? 0),
    10 * clamp((m.sharpe ?? 0) / 3),
    10 * (1 - (m.topMarketShare ?? 1)),
    10 * (m.copyAdjRoi === null ? 0.5 : clamp(m.copyAdjRoi / 0.2)),
    5 * clamp(Math.log(Math.max(1, m.nResolved)) / Math.log(500)),
  ];
  return Math.round(parts.reduce((a, b) => a + b, 0) * 10) / 10;
}

export function scoreTrader(m: TraderMetrics, cfg: ScoringConfig, ctx: ScoreContext): ScoreResult {
  const checks = buildChecks(m, cfg, ctx);
  const failed = checks.filter((c) => !c.ok);
  const passed = failed.length === 0;
  const score = compositeScore(m);

  let tier: ScoreTier;
  if (passed) tier = score >= cfg.eliteScore ? "elite" : "verified";
  else if (failed.length <= 3 && !failed.some((c) => HARD_CHECKS.has(c.code))) tier = "watchlist";
  else tier = "rejected";

  return { tier, score, passed, checks };
}
