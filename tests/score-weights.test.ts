/**
 * The 0–100 score that orders traders inside a tier. Owner, 2026-11-26: copy return 20
 * (0 when not measured), skill 20, return on risk 10, profitable months 25 (shrunk for few
 * months), recovery factor 10 (replaces Sharpe), biggest win share 10, sample size 5.
 */
import { describe, expect, it } from "vitest";

import type { TraderMetrics } from "@/lib/scoring/metrics";
import { compositeScore, recoveryPart, shrunkProfitableMonths } from "@/lib/scoring/score";

const trader = (over: Partial<TraderMetrics>) =>
  ({
    zSkill: 0,
    roiShrunk: 0,
    months: 0,
    profitableMonthsPct: null,
    recoveryFactor: 0,
    topMarketShare: 1,
    copyAdjRoi: 0,
    nResolved: 1,
    ...over,
  }) as TraderMetrics;

describe("compositeScore", () => {
  it("approaches 100 for a trader at the top of every part", () => {
    // Profitable months only reach 25 in the limit: (n + 2) / (n + 4) < 1.
    const top = trader({
      zSkill: 4,
      roiShrunk: 0.3,
      months: 96,
      profitableMonthsPct: 1,
      recoveryFactor: 10,
      topMarketShare: 0,
      copyAdjRoi: 0.2,
      nResolved: 500,
    });
    expect(compositeScore(top)).toBe(99.5);
  });

  it("weights copy return 20, skill 20, return on risk 10, recovery 10", () => {
    expect(compositeScore(trader({ copyAdjRoi: 0.2 }))).toBe(20);
    expect(compositeScore(trader({ zSkill: 4 }))).toBe(20);
    expect(compositeScore(trader({ roiShrunk: 0.3 }))).toBe(10);
    expect(compositeScore(trader({ recoveryFactor: 10 }))).toBe(10);
  });

  it("gives an unmeasured copy return 0, below a measured +8%", () => {
    expect(compositeScore(trader({ copyAdjRoi: null }))).toBe(0);
    expect(compositeScore(trader({ copyAdjRoi: 0.08 }))).toBe(8);
  });

  // Two real Candidates from the 2026-11-11 run: 62% profitable months with a higher
  // return ranked above 93% profitable months (59.9 each, a tie broken the wrong way).
  it("puts the steadier of two otherwise close traders first", () => {
    const steady = trader({ months: 14, profitableMonthsPct: 13 / 14, roiShrunk: 0.2 });
    const streaky = trader({ months: 13, profitableMonthsPct: 8 / 13, roiShrunk: 0.27 });
    expect(compositeScore(steady)).toBeGreaterThan(compositeScore(streaky));
  });
});

describe("shrunkProfitableMonths", () => {
  it("ranks 15 of 18 months above 3 of 3", () => {
    const veteran = shrunkProfitableMonths({ months: 18, profitableMonthsPct: 15 / 18 });
    const newcomer = shrunkProfitableMonths({ months: 3, profitableMonthsPct: 1 });
    expect(veteran).toBeCloseTo(17 / 22, 6);
    expect(newcomer).toBeCloseTo(5 / 7, 6);
    expect(veteran).toBeGreaterThan(newcomer);
  });

  it("is 0 with no months", () => {
    expect(shrunkProfitableMonths({ months: 0, profitableMonthsPct: null })).toBe(0);
  });
});

describe("recoveryPart", () => {
  it("separates 2×, 5× and 10× and caps there", () => {
    expect(recoveryPart(2)).toBeCloseTo(0.458, 3);
    expect(recoveryPart(5)).toBeCloseTo(0.747, 3);
    expect(recoveryPart(10)).toBe(1);
    expect(recoveryPart(99)).toBe(1);
    expect(recoveryPart(-1)).toBe(0);
    expect(recoveryPart(null)).toBe(0);
  });
});
