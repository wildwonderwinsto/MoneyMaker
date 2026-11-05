import { describe, expect, it } from "vitest";

import { delayedEntryPrice, leaderExits, toPositionRecord } from "@/lib/jobs/score";
import { asOf, copiedBetReturn, runBacktest } from "@/lib/scoring/backtest";
import { DEFAULT_SCORING_CONFIG as cfg } from "@/lib/scoring/config";
import { computeMetrics, copyAdjustedRoi, copyRoiStats } from "@/lib/scoring/metrics";

import { coinFlipper, NOW, oneHitWonder, steadyGrinder } from "./fixtures/traders";

describe("copiedBetReturn", () => {
  const base = {
    conditionId: "c",
    tokenId: "t",
    eventId: null,
    category: null,
    unrealizedPnl: 0,
    closed: true,
    firstEntryAt: 0,
    lastActivityAt: 0,
  };

  it("applies slippage to the entry price", () => {
    // Leader doubles their money at 0.50; we pay 0.51.
    const r = copiedBetReturn(
      { ...base, avgPrice: 0.5, sharesBought: 100, realizedPnl: 50, won: true },
      0.01,
    );
    expect(r).toBeCloseTo(2 * (0.5 / 0.51) - 1, 6);
  });

  it("never loses more than the stake", () => {
    const r = copiedBetReturn(
      { ...base, avgPrice: 0.5, sharesBought: 100, realizedPnl: -50, won: false },
      0.01,
    );
    expect(r).toBe(-1);
  });

  it("pays the taker fee on entry", () => {
    // We pay 0.51 + 0.05 × 0.51 × 0.49 per share instead of the leader's 0.50.
    const r = copiedBetReturn(
      { ...base, avgPrice: 0.5, sharesBought: 100, realizedPnl: 50, won: true },
      0.01,
      0.05,
    );
    expect(r).toBeCloseTo(2 * (0.5 / (0.51 + 0.05 * 0.51 * 0.49)) - 1, 6);
  });
});

describe("asOf (no look-ahead)", () => {
  it("drops positions whose market had not ended yet", () => {
    const t = steadyGrinder();
    const cut = NOW - 100 * 86_400;
    const past = asOf(t, cut);
    expect(past.positions.length).toBeLessThan(t.positions.length);
    expect(past.positions.every((p) => (p.endAt ?? p.lastActivityAt!) < cut)).toBe(true);
    expect(past.pnlSeries.every((pt) => pt.ts < cut)).toBe(true);
  });
});

describe("runBacktest", () => {
  it("never selects the one-hit wonder or coin flippers", () => {
    // Seed 12 is a clearly skilled grinder (z ≈ 6.5); seed 7 starts slowly and is
    // correctly not trusted until later, which is the filter working as designed.
    const traders = [steadyGrinder(12), oneHitWonder(), coinFlipper(19), coinFlipper(23)];
    const res = runBacktest(
      traders,
      cfg,
      {
        months: 4,
        topK: 3,
        copySlippage: 0.01,
        takerFeeRate: 0.05,
        startingEquity: 1000,
        simulations: 300,
      },
      NOW,
    );
    expect(res.months).toHaveLength(4);
    expect(res.strategyCurve).toHaveLength(5);
    const picked = new Set(res.months.flatMap((m) => m.strategyPicks));
    expect(picked.has("0xonehit")).toBe(false);
    expect([...picked].some((w) => w.startsWith("0xflip"))).toBe(false);
    expect(picked.has("0xgrinder")).toBe(true);
  });
});

describe("copy replay helpers", () => {
  it("delayedEntryPrice ignores points far outside the window", () => {
    const history = [
      { t: 100, p: 0.4 },
      { t: 230, p: 0.45 },
      { t: 99_999, p: 0.9 }, // API appends a 'current price' point
    ];
    expect(delayedEntryPrice(history, 100, 120, 0.01)).toBeCloseTo(0.46);
    expect(delayedEntryPrice([{ t: 99_999, p: 0.9 }], 100, 120, 0.01)).toBeNull();
  });

  it("copy ROI is weighted by the leader's stake", () => {
    const roi = copyAdjustedRoi([
      { delayedPrice: 0.5, exitValue: 1, weight: 900 }, // +100%
      { delayedPrice: 0.05, exitValue: 0, weight: 100 }, // −100%
    ]);
    expect(roi).toBeCloseTo(0.8);
  });
});

describe("toPositionRecord", () => {
  const row = {
    id: 1,
    wallet: "0xw",
    conditionId: "c",
    tokenId: "t",
    outcome: "Yes",
    outcomeIndex: 0,
    status: "REDEEMABLE",
    avgPrice: 0.57,
    size: 1000,
    sharesBought: 1000,
    totalCost: 570,
    realizedPnl: -10,
    unrealizedPnl: -560,
    currentValue: 0,
    title: null,
    slug: null,
    eventId: "e",
    category: null,
    endDate: new Date("2026-10-01"),
    won: false,
    firstEntryAt: new Date("2026-09-01"),
    lastActivityAt: new Date("2026-09-20"),
    updatedAt: new Date(),
  };

  it("counts an unredeemed resolved loser as a finished, losing position", () => {
    const p = toPositionRecord(row);
    expect(p.closed).toBe(true);
    expect(p.realizedPnl).toBe(-570);
    expect(p.endAt).toBe(Date.parse("2026-10-01") / 1000);
  });

  it("keeps a live open position unfinished", () => {
    const p = toPositionRecord({ ...row, won: null, endDate: null });
    expect(p.closed).toBe(false);
    expect(p.realizedPnl).toBe(-10);
    expect(p.unrealizedPnl).toBe(-560);
  });
});

describe("leaderExits", () => {
  const row = (
    id: string,
    t: number,
    side: string,
    size: number,
    price: number,
    tokenId = "y",
  ) => ({
    id,
    ts: new Date(t * 1000),
    tokenId,
    side,
    size,
    price,
  });

  it("assigns later sells to earlier buys first (FIFO) with their average price", () => {
    const exits = leaderExits([
      row("b1", 1, "BUY", 100, 0.4),
      row("b2", 2, "BUY", 100, 0.5),
      row("s1", 3, "SELL", 150, 0.7),
      row("other", 4, "SELL", 50, 0.9, "n"),
    ]);
    expect(exits.get("b1")).toEqual({ soldFraction: 1, avgPrice: 0.7 });
    expect(exits.get("b2")?.soldFraction).toBeCloseTo(0.5);
    expect(exits.has("s1")).toBe(false);
  });

  it("leaves buys that were held untouched", () => {
    expect(leaderExits([row("b1", 1, "BUY", 10, 0.4)]).size).toBe(0);
  });
});

describe("copy-adjusted ROI sample size", () => {
  it("is not measured from too few replays", () => {
    const replays = Array.from({ length: 5 }, () => ({ delayedPrice: 0.5, exitValue: 1 }));
    const input = {
      wallet: "0x1",
      positions: [],
      pnlSeries: [],
      activity: { tradeCount: null, joinDate: null },
      copyReplays: replays,
      now: 1_800_000_000,
    };
    expect(computeMetrics(input, cfg).copyAdjRoi).toBeNull();
    const many = { ...input, copyReplays: Array.from({ length: 30 }, () => replays[0]) };
    expect(computeMetrics(many, cfg).copyAdjRoi).toBeCloseTo(1);
  });

  it("matches the textbook standard error for equal stakes", () => {
    const s = copyRoiStats([
      { delayedPrice: 0.5, exitValue: 0.5 }, // 0%
      { delayedPrice: 0.5, exitValue: 0.6 }, // +20%
    ]);
    // Sample SD of [0, 0.2] is 0.1414; SE = 0.1414 / √2 = 0.1.
    expect(s).toMatchObject({ nEff: 2 });
    expect(s!.mean).toBeCloseTo(0.1);
    expect(s!.se).toBeCloseTo(0.1);
  });

  it("is judged cautiously: a few big bets can't carry it", () => {
    // 27 small losing copies and 3 big winners that carry all the profit.
    const replays = [
      ...Array.from({ length: 27 }, () => ({ delayedPrice: 0.5, exitValue: 0.45, weight: 10 })),
      ...Array.from({ length: 3 }, () => ({ delayedPrice: 0.2, exitValue: 1, weight: 200 })),
    ];
    const m = computeMetrics(
      {
        wallet: "0x1",
        positions: [],
        pnlSeries: [],
        activity: { tradeCount: null, joinDate: null },
        copyReplays: replays,
        now: 1_800_000_000,
      },
      cfg,
    );
    expect(m.copyAdjRoiMean).toBeGreaterThan(2); // the average looks spectacular…
    expect(m.copyEffectiveN).toBeLessThan(7); // …but 30 replays count as ~6 bets
    expect(m.copyAdjRoi!).toBeLessThan(m.copyAdjRoiMean! - 0.5);
  });
});
