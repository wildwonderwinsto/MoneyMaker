import { describe, expect, it } from "vitest";

import { DEFAULT_SCORING_CONFIG as cfg } from "@/lib/scoring/config";
import {
  computeMetrics,
  concentration,
  copyAdjustedRoi,
  drawdownStats,
  monthlyPnl,
  skillZ,
} from "@/lib/scoring/metrics";
import { scoreTrader } from "@/lib/scoring/score";
import {
  benjaminiHochbergThreshold,
  normalCdf,
  simulationsFor,
  wilsonLowerBound,
} from "@/lib/scoring/stats";

import {
  coinFlipper,
  favoriteBuyer,
  hftBot,
  oneHitWonder,
  steadyGrinder,
} from "./fixtures/traders";

const ctx = { mcPThreshold: 0.05, candidates: 100 };
const failedCodes = (r: ReturnType<typeof scoreTrader>) =>
  r.checks.filter((c) => !c.ok).map((c) => c.code);

describe("stats", () => {
  it("normalCdf matches known values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });

  it("wilson lower bound is below the raw rate and shrinks small samples harder", () => {
    expect(wilsonLowerBound(8, 10)).toBeLessThan(0.8);
    expect(wilsonLowerBound(80, 100)).toBeGreaterThan(wilsonLowerBound(8, 10));
  });

  it("Benjamini–Hochberg picks the largest qualifying p-value", () => {
    // m=5, q=0.1 → cutoffs 0.02,0.04,0.06,0.08,0.10
    expect(benjaminiHochbergThreshold([0.001, 0.03, 0.05, 0.5, 0.9], 0.1)).toBe(0.05);
    expect(benjaminiHochbergThreshold([0.5, 0.6], 0.1)).toBe(0);
  });

  it("runs enough simulations for the luck test to be passable", () => {
    // Regression: the backtest used 300, so the best p-value possible (1/301) was above
    // what Benjamini–Hochberg needs for 63 traders (0.1/63) and nobody could ever pass.
    const sims = simulationsFor(63, 0.1, 300);
    expect(1 / (sims + 1)).toBeLessThanOrEqual(0.1 / 63);
    expect(
      benjaminiHochbergThreshold([1 / (sims + 1), ...Array(62).fill(0.5)], 0.1),
    ).toBeGreaterThan(0);
    expect(benjaminiHochbergThreshold([1 / 301, ...Array(62).fill(0.5)], 0.1)).toBe(0);
    expect(simulationsFor(10, 0.1, 2000)).toBe(2000); // never fewer than asked
  });
});

describe("metric building blocks", () => {
  it("skillZ is ~0 when outcomes match prices and positive with real edge", () => {
    const flip = coinFlipper();
    const grind = steadyGrinder();
    expect(Math.abs(skillZ(flip.positions, cfg).z!)).toBeLessThan(2);
    expect(skillZ(grind.positions, cfg).z!).toBeGreaterThan(cfg.minZ);
  });

  it("concentration measures share of gross profit per market", () => {
    const base = {
      tokenId: "t",
      eventId: null,
      category: null,
      avgPrice: 0.5,
      sharesBought: 1,
      unrealizedPnl: 0,
      closed: true,
      won: true,
      firstEntryAt: null,
      lastActivityAt: null,
    };
    const c = concentration([
      { ...base, conditionId: "a", realizedPnl: 60 },
      { ...base, conditionId: "b", realizedPnl: 30 },
      { ...base, conditionId: "c", realizedPnl: 10 },
      { ...base, conditionId: "d", realizedPnl: -50 },
    ]);
    expect(c.topMarketShare).toBeCloseTo(0.6);
    expect(c.top3Share).toBeCloseTo(1);
    expect(c.pnlExTop3).toBeCloseTo(-50);
  });

  it("monthly PnL and drawdown come from the cumulative series", () => {
    const d = (iso: string) => Date.parse(iso) / 1000;
    const series = [
      { ts: d("2026-01-05"), pnl: 100 },
      { ts: d("2026-01-31"), pnl: 150 },
      { ts: d("2026-02-15"), pnl: 50 },
      { ts: d("2026-03-20"), pnl: 300 },
    ];
    expect(monthlyPnl(series)).toEqual([
      { month: "2026-01", pnl: 150 },
      { month: "2026-02", pnl: -100 },
      { month: "2026-03", pnl: 250 },
    ]);
    const dd = drawdownStats(series);
    expect(dd.maxDrawdown).toBe(100);
    expect(dd.recoveryFactor).toBe(3);
  });

  it("copy-adjusted ROI uses the delayed entry price", () => {
    expect(
      copyAdjustedRoi([
        { delayedPrice: 0.5, exitValue: 1 },
        { delayedPrice: 0.5, exitValue: 0 },
      ]),
    ).toBe(0);
    expect(copyAdjustedRoi([{ delayedPrice: 0.4, exitValue: 1 }])).toBeCloseTo(1.5);
    expect(copyAdjustedRoi([])).toBeNull();
  });
});

describe("verification of fixture traders", () => {
  it("VERIFIES the steady grinder", () => {
    const m = computeMetrics(steadyGrinder(), cfg);
    const r = scoreTrader(m, cfg, ctx);
    expect(failedCodes(r)).toEqual([]);
    expect(r.passed).toBe(true);
    expect(["verified", "elite"]).toContain(r.tier);
    expect(m.mcPValue!).toBeLessThan(0.01);
  });

  it("REJECTS the one-hit wonder (profit is one lucky market)", () => {
    const m = computeMetrics(oneHitWonder(), cfg);
    const r = scoreTrader(m, cfg, ctx);
    expect(m.totalPnl).toBeGreaterThan(300_000); // looks great on a leaderboard...
    expect(m.topMarketShare!).toBeGreaterThan(0.9);
    expect(failedCodes(r)).toContain("top_market");
    expect(r.tier).toBe("rejected");
  });

  it("REJECTS the favorite buyer despite a ~95% win rate", () => {
    const m = computeMetrics(favoriteBuyer(), cfg);
    const r = scoreTrader(m, cfg, ctx);
    expect(m.winRate!).toBeGreaterThan(0.9);
    expect(failedCodes(r)).toContain("skill_z");
    expect(r.passed).toBe(false);
  });

  it("REJECTS the high-frequency bot as uncopyable", () => {
    const m = computeMetrics(hftBot(), cfg);
    const r = scoreTrader(m, cfg, ctx);
    expect(failedCodes(r)).toEqual(expect.arrayContaining(["bot_activity", "hold_time"]));
    expect(r.tier).toBe("rejected");
  });

  it("does not verify lucky coin flippers", () => {
    for (const seed of [19, 23, 29, 31, 37]) {
      const r = scoreTrader(computeMetrics(coinFlipper(seed), cfg), cfg, ctx);
      expect(r.passed).toBe(false);
    }
  });

  it("is deterministic run to run", () => {
    const a = computeMetrics(steadyGrinder(), cfg);
    const b = computeMetrics(steadyGrinder(), cfg);
    expect(a.mcPValue).toBe(b.mcPValue);
    expect(scoreTrader(a, cfg, ctx).score).toBe(scoreTrader(b, cfg, ctx).score);
  });
});

describe("forward holdout (owner decision 2026-11-08, design #8)", () => {
  // Skill is tested only on bets opened after the trader was first picked: selection used
  // their earlier profits, so testing those again lets plain luck look like skill.
  it("tests skill only on bets opened at or after the first check", () => {
    const t = steadyGrinder();
    const entries = t.positions.map((p) => p.firstEntryAt!).sort((a, b) => a - b);
    const from = entries[Math.floor(entries.length / 2)];
    const later = t.positions.filter((p) => p.firstEntryAt! >= from);
    const m = computeMetrics({ ...t, holdoutFrom: from }, cfg);
    const expected = skillZ(later, cfg);
    expect(m.nHoldout).toBe(expected.n);
    expect(m.zSkill).toBeCloseTo(expected.z!, 10);
    expect(computeMetrics(t, cfg).nHoldout).toBeNull(); // no holdout = old behaviour
  });

  it("a trader passing everything but without enough post-pick bets is a Candidate", () => {
    const t = steadyGrinder();
    const m = computeMetrics({ ...t, holdoutFrom: t.now }, cfg); // first picked today
    const r = scoreTrader(m, cfg, ctx);
    expect(m.nHoldout).toBe(0);
    expect(r.checks.find((c) => c.code === "holdout_sample")).toMatchObject({
      ok: false,
      value: 0,
      threshold: cfg.minResolved,
    });
    expect(r.tier).toBe("candidate");
    expect(r.passed).toBe(false);
  });

  it("with enough post-pick bets the normal tiers apply again", () => {
    const t = steadyGrinder();
    const r = scoreTrader(computeMetrics({ ...t, holdoutFrom: 0 }, cfg), cfg, ctx);
    expect(["verified", "elite"]).toContain(r.tier);
    expect(r.checks.find((c) => c.code === "holdout_sample")?.ok).toBe(true);
  });

  it("while skill is pending, Watchlist allows 1 failed check, not 3", () => {
    // Owner decision (2026-11-08): pending skill checks don't count, so the old 3-miss rule
    // put 104 of 150 traders on the Watchlist.
    const t = steadyGrinder();
    const pending = computeMetrics({ ...t, holdoutFrom: t.now }, cfg);
    const oneMiss = { ...pending, daysSinceTrade: 100 }; // "active" fails
    const twoMisses = { ...oneMiss, oosRoi: -0.5 }; // and "recent"
    expect(scoreTrader(oneMiss, cfg, ctx).tier).toBe("watchlist");
    expect(scoreTrader(twoMisses, cfg, ctx).tier).toBe("rejected");
    // Once skill can be tested, the existing rule (up to 3 misses) applies.
    const tested = computeMetrics({ ...t, holdoutFrom: 0 }, cfg);
    expect(scoreTrader({ ...tested, daysSinceTrade: 100, oosRoi: -0.5 }, cfg, ctx).tier).toBe(
      "watchlist",
    );
  });
});
