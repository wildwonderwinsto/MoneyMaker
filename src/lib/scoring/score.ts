/**
 * Turns metrics into pass/fail checks, a 0–100 composite score and a tier.
 * Every check carries a plain-English label so the UI can explain each decision.
 */
import type { ScoreCheck, ScoreTier } from "@/lib/db/schema";

import type { ScoringConfig } from "./config";
import { NO_EDGE_EVIDENCE, type TraderMetrics } from "./metrics";
import { clamp, normalCdf } from "./stats";

export interface ScoreContext {
  /**
   * e-BH bar on the sequential skill evidence across everyone tested (pooled over the
   * last 30 days in the daily job); Infinity = nobody passes.
   */
  eThreshold: number;
  /** Number of traders tested (shown in the label). */
  candidates: number;
}

export interface ScoreResult {
  tier: ScoreTier;
  score: number;
  passed: boolean;
  checks: ScoreCheck[];
}

/** Failing any of these is disqualifying even for the watchlist. */
const HARD_CHECKS = new Set([
  "top_market",
  "bot_activity",
  "both_sides",
  "hold_time",
  "skill",
  "no_edge",
  "candidate_age",
  "copy_loss",
]);

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
    {
      code: "skill",
      label: `Wins more often than prices predicted, each event counted once (sequential test over ${ctx.candidates} traders, FDR ${pct(cfg.fdrQ)})`,
      value: m.eSkill,
      threshold: Number.isFinite(ctx.eThreshold) ? ctx.eThreshold : null,
      ok: (m.nHoldout ?? Infinity) >= cfg.minResolved && m.eSkill >= ctx.eThreshold,
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
      `Still profitable when copied ${Math.round(cfg.copyDelaySeconds / 60)} min late` +
        (cfg.copyRoiZ > 0 ? `, ${pct(normalCdf(cfg.copyRoiZ))} confident` : "") +
        (m.nCopyReplays >= cfg.minCopyReplays
          ? ` (${m.nCopyReplays} trades replayed)`
          : m.nCopyReplays > 0
            ? ` (only ${m.nCopyReplays} trades to replay; needs ${cfg.minCopyReplays})`
            : ""),
      m.copyAdjRoi,
      cfg.minCopyAdjRoi + Number.EPSILON,
    ),
    // Hard: copying clearly loses money (not measured = no verdict; copy_roi still has to pass).
    atLeast(
      "copy_loss",
      `Doesn't clearly lose money when copied (copy return + ${cfg.copyLossZ} standard errors ≥ 0)`,
      m.copyRoiUpper,
      0,
      true,
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
    // Forward holdout: skill is tested only on bets placed after the trader was first picked.
    ...(m.nHoldout === null || m.nHoldout === undefined
      ? []
      : [
          atLeast(
            "holdout_sample",
            `At least ${cfg.minResolved} resolved bets since first picked (skill is tested on these only)`,
            m.nHoldout,
            cfg.minResolved,
          ),
          // A Candidate stays one while evidence builds; these two end it (audit R2, R6).
          atMost(
            "no_edge",
            `Not shown to have an edge below ${Math.round(cfg.minEdge * 100)} points (95% confident)`,
            m.eNoEdge,
            NO_EDGE_EVIDENCE,
          ),
          {
            code: "candidate_age",
            label: `Skill proven within ${cfg.maxCandidateDays} days of being picked`,
            value: m.holdoutDays,
            threshold: cfg.maxCandidateDays,
            ok:
              (m.holdoutDays ?? 0) < cfg.maxCandidateDays ||
              ((m.nHoldout ?? 0) >= cfg.minResolved && m.eSkill >= ctx.eThreshold),
          },
        ]),
  ];
}

/** Skill checks that are still building evidence (they can't count against the tier yet). */
const PENDING_SKILL = new Set(["holdout_sample", "skill"]);

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

  // Skill not proven yet, but not disproven or timed out either: the skill checks are
  // pending (Candidate), and the tier is judged on the rest.
  const pending =
    m.nHoldout !== null &&
    m.nHoldout !== undefined &&
    failed.some((c) => PENDING_SKILL.has(c.code)) &&
    !failed.some((c) => c.code === "no_edge" || c.code === "candidate_age");
  const counted = pending ? failed.filter((c) => !PENDING_SKILL.has(c.code)) : failed;

  let tier: ScoreTier;
  if (passed) tier = score >= cfg.eliteScore ? "elite" : "verified";
  else if (pending && counted.length === 0) tier = "candidate";
  // CAPACITY rule, not a statistical one (audit R4): while skill is pending, at most 1 other
  // failed check (owner, 2026-11-08), because the 3-miss rule put 104 of 150 on the
  // Watchlist and Watchlist re-checks crowd out Candidates and new wallets. The 1 is not a
  // confidence level; it trades some skilled traders for slots — in the power sim most
  // skilled traders not found were rejected here (copy_roi and recent both noisy).
  else if (counted.length <= (pending ? 1 : 3) && !counted.some((c) => HARD_CHECKS.has(c.code)))
    tier = "watchlist";
  else tier = "rejected";

  return { tier, score, passed, checks };
}
