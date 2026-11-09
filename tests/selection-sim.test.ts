/**
 * Guard against lucky false positives (owner decision 2026-11-08, designs #8 + #3).
 *
 * A seeded population with NO skill at all (every bet wins exactly as often as its price
 * says) is picked the way discovery picks: by profit on leaderboard-like windows at the
 * moment of first check. Each picked wallet is then scored the production way: skill tested
 * only on bets opened after that first check (forward holdout), luck test judged with
 * Benjamini–Hochberg over everyone tested, all 16 checks, copy delay and fees included.
 * Any zero-skill trader reaching Verified/Elite is a false positive.
 *
 * Without the holdout this population produced 17–23 zero-skill Verified/Elite out of 150
 * (audit simulation, 2026-11-08); with it, 0 in every seed tried.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_SCORING_CONFIG as base } from "@/lib/scoring/config";
import {
  computeMetrics,
  type CopyReplay,
  type MetricsInput,
  type PositionRecord,
} from "@/lib/scoring/metrics";
import { scoreTrader } from "@/lib/scoring/score";
import { benjaminiHochbergThreshold, seededRandom, simulationsFor } from "@/lib/scoring/stats";

import {
  PIPELINE_DEFAULTS,
  REAL_BET_RATES,
  runPipeline,
  skilledTrader,
  type PipelineResult,
  type SimTrader,
} from "./helpers/skillPipeline";

/** Most zero-skill Verified/Elite allowed (agreed limit). */
const MAX_FALSE_POSITIVES = 1;

const DAY = 86_400;
const NOW = Date.UTC(2026, 10, 8) / 1000;
/** First check 60 days ago: the holdout is everything opened since. */
const PICKED_AT = NOW - 60 * DAY;

function zeroSkillPopulation(n: number, seed: number): MetricsInput[] {
  const rand = seededRandom(seed);
  return Array.from({ length: n }, (_, k) => {
    const positions: PositionRecord[] = [];
    const copyReplays: CopyReplay[] = [];
    const events: Array<{ t: number; pnl: number }> = [];
    const scale = Math.exp(3 * rand());
    for (let i = 0; i < 360; i++) {
      const entry = NOW - 360 * DAY + rand() * 357 * DAY;
      const exit = Math.min(NOW - 60, entry + (0.2 + rand() * 6) * DAY);
      const p = 0.1 + rand() * 0.8;
      const shares = scale * 50 * Math.exp(4 * (rand() - 0.5));
      const won = rand() < p;
      const pnl = shares * ((won ? 1 : 0) - p);
      positions.push({
        conditionId: `c${i}`,
        tokenId: `t${i}`,
        eventId: `e${i}`,
        category: null,
        avgPrice: p,
        sharesBought: shares,
        realizedPnl: pnl,
        unrealizedPnl: 0,
        closed: true,
        won,
        firstEntryAt: entry,
        lastActivityAt: exit,
        resolvedAt: exit,
      });
      events.push({ t: exit, pnl });
      if (entry >= NOW - 90 * DAY && shares * p >= 25) {
        // Copied 2 min late at the same price (no skill = no information), +1¢, 5% fee.
        const d = Math.min(0.999, p + 0.01);
        copyReplays.push({
          delayedPrice: d + 0.05 * d * (1 - d),
          exitValue: won ? 1 : 0,
          weight: shares * p,
          ts: entry,
        });
      }
    }
    events.sort((a, b) => a.t - b.t);
    const byDay = new Map<number, number>();
    let cum = 0;
    for (const e of events) byDay.set(Math.floor(e.t / DAY) * DAY, (cum += e.pnl));
    return {
      wallet: `0xzero${seed}-${k}`,
      positions,
      pnlSeries: [...byDay].map(([ts, pnl]) => ({ ts, pnl })),
      activity: { tradeCount: 1080, joinDate: NOW - 360 * DAY, lastTradeAt: NOW - DAY },
      copyReplays: copyReplays.slice(-150),
      now: NOW,
    };
  });
}

/** Discovery-like pick at `at`: on a top-2% week/month/all board, ranked by quality. */
function pick(pop: MetricsInput[], at: number, count: number): MetricsInput[] {
  const pnl = (t: MetricsInput, from: number) =>
    t.positions
      .filter((p) => p.lastActivityAt! < at && p.lastActivityAt! >= from)
      .reduce((a, p) => a + p.realizedPnl, 0);
  const stats = pop.map((t) => ({
    t,
    all: pnl(t, 0),
    month: pnl(t, at - 30 * DAY),
    week: pnl(t, at - 7 * DAY),
    volume: t.positions
      .filter((p) => p.lastActivityAt! < at)
      .reduce((a, p) => a + p.sharesBought * p.avgPrice, 0),
  }));
  const board = (key: "all" | "month" | "week") =>
    new Set(
      [...stats]
        .sort((a, b) => b[key] - a[key])
        .slice(0, Math.ceil(pop.length * 0.02))
        .map((s) => s.t.wallet),
    );
  const boards = [board("all"), board("month"), board("week")];
  return stats
    .filter((s) => s.all > 0 && boards.some((b) => b.has(s.t.wallet)))
    .map((s) => ({
      t: s.t,
      q:
        boards.filter((b) => b.has(s.t.wallet)).length +
        Math.min(3, Math.max(0, s.all / s.volume / 0.1)),
    }))
    .sort((a, b) => b.q - a.q)
    .slice(0, count)
    .map((s) => s.t);
}

describe("zero-skill traders don't become Verified/Elite", () => {
  it.each([101, 202])("seed %i: at most the agreed limit pass", (seed) => {
    const picked = pick(zeroSkillPopulation(6000, seed), PICKED_AT, 200);
    const cfg = { ...base, simulations: simulationsFor(picked.length, base.fdrQ, 2000) };
    const metrics = picked.map((t) => computeMetrics({ ...t, holdoutFrom: PICKED_AT }, cfg));
    // Pooled: everyone tested (enough post-pick bets) counts toward the BH correction.
    // (A wallet with too few post-pick bets isn't tested yet, so it isn't counted.)
    const tested = metrics.filter((m) => !((m.nHoldout ?? Infinity) < cfg.minResolved));
    const ps = tested.map((m) => m.mcPValue).filter((p): p is number => p !== null);
    const ctx = { mcPThreshold: benjaminiHochbergThreshold(ps, cfg.fdrQ), candidates: ps.length };
    const passed = metrics.filter((m) => scoreTrader(m, cfg, ctx).passed).length;
    expect(picked.length).toBe(200);
    expect(passed).toBeLessThanOrEqual(MAX_FALSE_POSITIVES);
  });
});

/**
 * Power (audit R1, 2026-11-09): the strategy must also let real skill through. Traders who
 * win 5 or 8 points more often than prices say, at the four real activity levels (positions
 * per day: 0.43 / 1.88 / 6.4 / 12.65, the p25/p50/p75/p90 of the latest local run), are
 * picked on day 0 and checked on the rotation's schedule. A Rejected trader isn't assumed
 * to be picked again (that needs discovery to rank them into a free slot).
 *
 * Bar (proposed 2026-11-09, owner to confirm): within 180 days at least 50% of the +8
 * traders and 25% of the +5 traders reach Verified/Elite. The lowest activity level can't
 * build enough bets in 180 days under any valid test, so 75% is the practical ceiling.
 *
 * KNOWN FAILURE until the skill test is redesigned (audit R2: skill_z rejects at 50 post-pick
 * bets; a +5 edge needs ~320 for z = 2). Today: +5 → 2/40, +8 → 8/40. `it.fails` keeps the
 * check green and turns red the moment the bar is met — then change it to `it`.
 */
describe("skilled traders can reach Verified/Elite", () => {
  const DAY0 = Date.UTC(2026, 4, 1) / 1000;
  const HORIZON = 180;
  const MIN_FOUND = { 0.05: 0.25, 0.08: 0.5 } as const;
  let results: PipelineResult[] = [];

  beforeAll(() => {
    const traders: SimTrader[] = [];
    let seed = 1000;
    for (const edge of [0.05, 0.08])
      for (const rate of REAL_BET_RATES)
        for (let i = 0; i < 10; i++)
          traders.push(
            skilledTrader(`0xskill${edge}-${rate}-${i}`, edge, rate, DAY0, HORIZON, seed++),
          );
    results = runPipeline(traders, DAY0, base, { ...PIPELINE_DEFAULTS, horizonDays: HORIZON });
  }, 120_000);

  it("simulates every trader on the production checks", () => {
    expect(results).toHaveLength(80);
    expect(results.every((r) => r.checks > 0)).toBe(true);
  });

  it.fails.each([0.05, 0.08] as const)("+%s edge: enough are found within 180 days", (edge) => {
    const group = results.filter((r) => r.edge === edge);
    const found = group.filter((r) => r.foundDay !== null && r.foundDay <= HORIZON).length;
    expect(found / group.length).toBeGreaterThanOrEqual(MIN_FOUND[edge]);
  });
});
