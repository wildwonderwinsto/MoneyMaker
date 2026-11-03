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
import { benjaminiHochbergThreshold, normalCdf, wilsonLowerBound } from "@/lib/scoring/stats";

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
