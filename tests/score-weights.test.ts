/**
 * The 0–100 score that orders traders inside a tier. Owner, 2026-11-11: profitable months
 * should count for more (15 → 25 points; skill 30 → 25, return on risk 20 → 15).
 */
import { describe, expect, it } from "vitest";

import type { TraderMetrics } from "@/lib/scoring/metrics";
import { compositeScore } from "@/lib/scoring/score";

const trader = (over: Partial<TraderMetrics>) =>
  ({
    zSkill: 0,
    roiShrunk: 0,
    profitableMonthsPct: 0,
    sharpe: 0,
    topMarketShare: 1,
    copyAdjRoi: 0,
    nResolved: 1,
    ...over,
  }) as TraderMetrics;

describe("compositeScore", () => {
  it("adds up to 100 for a trader at the top of every part", () => {
    expect(
      compositeScore(
        trader({
          zSkill: 4,
          roiShrunk: 0.3,
          profitableMonthsPct: 1,
          sharpe: 3,
          topMarketShare: 0,
          copyAdjRoi: 0.2,
          nResolved: 500,
        }),
      ),
    ).toBe(100);
  });

  it("gives profitable months 25 points, skill 25 and return on risk 15", () => {
    expect(compositeScore(trader({ profitableMonthsPct: 1 }))).toBe(25);
    expect(compositeScore(trader({ zSkill: 4 }))).toBe(25);
    expect(compositeScore(trader({ roiShrunk: 0.3 }))).toBe(15);
  });

  // Two real Candidates from the 2026-11-11 run: 62% profitable months with a higher
  // return ranked above 93% profitable months (59.9 each, a tie broken the wrong way).
  it("puts the steadier of two otherwise close traders first", () => {
    const steady = trader({ profitableMonthsPct: 0.93, roiShrunk: 0.2, sharpe: 1.5 });
    const streaky = trader({ profitableMonthsPct: 0.62, roiShrunk: 0.27, sharpe: 1.5 });
    expect(compositeScore(steady)).toBeGreaterThan(compositeScore(streaky));
  });
});
