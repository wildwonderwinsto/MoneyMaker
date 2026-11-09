import { describe, expect, it } from "vitest";

import {
  DEFAULT_SCORE,
  delayedEntryPrice,
  evenSample,
  leaderExits,
  toPositionRecord,
} from "@/lib/jobs/score";
import { asOf, copiedBetReturn, DEFAULT_BACKTEST, runBacktest } from "@/lib/scoring/backtest";
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
  it("a position whose market settled after the formation date is open, with no P&L (#10)", () => {
    // The leader stopped trading it before `at`, but the result (and its final P&L) only
    // became known after: at formation it was an open bet.
    const t = steadyGrinder();
    const at = NOW - 30 * 86_400;
    const p = {
      ...t.positions[0],
      conditionId: "late",
      closed: true,
      won: true,
      realizedPnl: 500,
      unrealizedPnl: 0,
      lastActivityAt: at - 86_400,
      resolvedAt: at + 86_400,
    };
    const [late] = asOf({ ...t, positions: [p] }, at).positions;
    expect(late).toMatchObject({ closed: false, won: null, realizedPnl: 0, unrealizedPnl: 0 });
    const m = computeMetrics(asOf({ ...t, positions: [p] }, at), cfg);
    expect(m.totalPnl).toBe(0);
    expect(m.nClosed).toBe(0);
  });

  it("drops positions whose market had not ended yet", () => {
    const t = steadyGrinder();
    const cut = NOW - 100 * 86_400;
    const past = asOf(t, cut);
    expect(past.positions.length).toBeLessThan(t.positions.length);
    expect(past.positions.every((p) => (p.endAt ?? p.lastActivityAt!) < cut)).toBe(true);
    expect(past.pnlSeries.every((pt) => pt.ts < cut)).toBe(true);
  });

  it("goes by when the trader's position ended, not the market's listed end date", () => {
    const at = 1_000_000;
    const p = {
      conditionId: "c",
      tokenId: "t",
      eventId: null,
      category: null,
      avgPrice: 0.5,
      sharesBought: 10,
      realizedPnl: 5,
      unrealizedPnl: 0,
      closed: true,
      won: true,
      firstEntryAt: at + 100,
      lastActivityAt: at + 200,
      endAt: at - 1, // listed end date before the trade even happened
    };
    const input = {
      wallet: "0x1",
      positions: [
        p,
        {
          ...p,
          tokenId: "sold",
          firstEntryAt: at - 500,
          lastActivityAt: at - 100,
          resolvedAt: at + 50,
        },
      ],
      pnlSeries: [],
      activity: { tradeCount: null, joinDate: null, lastTradeAt: at + 999 },
      copyReplays: null,
      now: at + 1000,
    };
    const past = asOf(input, at);
    // The future trade is excluded; the one sold before `at` stays, but its market only
    // settled afterwards, so its outcome is unknown at `at`.
    expect(past.positions.map((x) => [x.tokenId, x.won])).toEqual([["sold", null]]);
    expect(past.activity.lastTradeAt).toBeNull();
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

  it("uses picks recorded at the time, and only bets opened after them", () => {
    const traders = [steadyGrinder(12), oneHitWonder()];
    const params = {
      months: 1,
      topK: 3,
      copySlippage: 0.01,
      takerFeeRate: 0.05,
      startingEquity: 1000,
      simulations: 300,
    };
    // NOW is 2026-11-01, so the one month tested is October.
    const oct = Date.UTC(2026, 9, 1) / 1000;
    const nov = Date.UTC(2026, 10, 1) / 1000;
    const at = (from: number) =>
      runBacktest(
        traders,
        cfg,
        params,
        NOW,
        new Map([["2026-10", { strategy: ["0xgrinder"], baseline: ["0xonehit"], from }]]),
      );
    const early = at(oct);
    expect(early.months[0]).toMatchObject({
      recorded: true,
      strategyPicks: ["0xgrinder"],
      baselinePicks: ["0xonehit"],
    });
    expect(early.months[0].strategyBets).toBeGreaterThan(0);
    expect(early.summary.recordedMonths).toBe(1);
    // Recorded at the very end of the month: no bet was opened after it, so none count.
    expect(at(nov - 1).months[0].strategyBets).toBe(0);
  });

  it("recorded months use the picks' rebuilt activity results; partial pick-months are left out (#9)", () => {
    // The grinder's /positions rows say nothing about these wallets' October; the rebuilt
    // results do. 0xa made +50% on $200; 0xb's window was cut by the row cap (partial).
    const params = { ...DEFAULT_BACKTEST, months: 1, topK: 3 };
    const r = runBacktest(
      [steadyGrinder(12)],
      cfg,
      params,
      NOW,
      new Map([
        [
          "2026-10",
          {
            strategy: ["0xa", "0xb"],
            baseline: ["0xc"],
            from: Date.UTC(2026, 9, 1) / 1000,
            results: {
              "strategy:0xa": { bets: 4, staked: 200, pnl: 100, partial: false },
              "strategy:0xb": { bets: 9, staked: 900, pnl: -900, partial: true },
              "baseline:0xc": { bets: 2, staked: 100, pnl: -10, partial: false },
            },
          },
        ],
      ]),
    );
    expect(r.months[0].strategyReturn).toBeCloseTo(0.5, 10);
    expect(r.months[0].strategyBets).toBe(4);
    expect(r.months[0].baselineReturn).toBeCloseTo(-0.1, 10);
    expect(r.months[0].partialPicks).toBe(1);
    expect(r.summary).toMatchObject({ recordedPickMonths: 3, partialPickMonths: 1 });
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

describe("asOf and the forward holdout", () => {
  it("re-derived months ignore the live holdout start (it is after the formation date)", () => {
    // Regression: loadInputs sets holdoutFrom = first check (recent); copied into a past
    // formation date it left no bets to test, turning every re-derived pick into a Candidate.
    const t = { ...steadyGrinder(), holdoutFrom: NOW };
    const m = computeMetrics(asOf(t, NOW - 30 * 86_400), cfg);
    expect(m.nHoldout).toBeNull();
    expect(m.zSkill).not.toBeNull();
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

  it("counts a CLOSED position with leftover dust as finished, so its realized loss is scored", () => {
    // Regression (live, Nov 2026): the API lists a sold-out position as CLOSED but often
    // leaves a few hundredths of a share. Judged by size alone it stayed "open", which kept
    // a -$30.5k realized loss out of ROI and total PnL until the market ends in 2027.
    const dust = {
      ...row,
      status: "CLOSED",
      outcomeIndex: 1,
      avgPrice: 0.7566,
      size: 0.18,
      sharesBought: 449_999.88,
      totalCost: 340_469,
      realizedPnl: -30_499.68,
      unrealizedPnl: 0.02,
      endDate: new Date("2027-01-01"),
      won: null,
    };
    const p = toPositionRecord(dust);
    expect(p.closed).toBe(true);
    expect(p.realizedPnl).toBeCloseTo(-30_499.66, 2);
    const m = computeMetrics({ ...steadyGrinder(), positions: [p] }, cfg);
    expect(m.totalPnl).toBeCloseTo(-30_499.66, 2);
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

  it("reports how many days the replays cover and how many are still open", () => {
    const replays = Array.from({ length: 30 }, (_, i) => ({
      delayedPrice: 0.5,
      exitValue: 1,
      ts: 1_800_000_000 - i * 86_400,
      open: i < 4,
    }));
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
    expect(m.copyReplayDays).toBeCloseTo(29);
    expect(m.copyOpenReplays).toBe(4);
  });

  it("samples replays evenly across the whole window", () => {
    const buys = Array.from({ length: 280 }, (_, i) => i); // newest first
    const sample = evenSample(buys, 150);
    expect(sample).toHaveLength(150);
    expect(new Set(sample).size).toBe(150);
    expect(sample[0]).toBe(0);
    expect(sample.at(-1)).toBeGreaterThan(275); // reaches the oldest trades too
    expect(evenSample([1, 2, 3], 150)).toEqual([1, 2, 3]);
  });

  it("judges activity by the last real trade when it is known", () => {
    const base = {
      wallet: "0x1",
      positions: [],
      pnlSeries: [],
      copyReplays: null,
      now: 1_800_000_000,
    };
    const last = 1_800_000_000 - 20 * 86_400;
    const m = computeMetrics(
      { ...base, activity: { tradeCount: null, joinDate: null, lastTradeAt: last } },
      cfg,
    );
    expect(m.daysSinceTrade).toBeCloseTo(20);
  });

  it("fetches enough trades to cover the whole replay window", () => {
    // Regression: a 2000-trade cap (newest first) covered only 10–30 days for active
    // traders. Anyone under the bot limit must get the full window.
    expect(DEFAULT_SCORE.maxReplayTrades).toBeGreaterThanOrEqual(
      cfg.maxTradesPerDay * DEFAULT_SCORE.replayLookbackDays,
    );
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

describe("B1: each recorded method counts bets from its own recording time", () => {
  it("a method recorded late in the month gets no credit for bets before its picks existed", () => {
    // Strategy recorded on Oct 1, baseline only on Oct 31: the baseline's picks didn't exist
    // for the month's bets, so none count for it.
    const params = { ...DEFAULT_BACKTEST, months: 1, topK: 3 };
    const oct = Date.UTC(2026, 9, 1) / 1000;
    const r = runBacktest(
      [steadyGrinder(12)],
      cfg,
      params,
      NOW,
      new Map([
        [
          "2026-10",
          {
            strategy: ["0xgrinder"],
            baseline: ["0xgrinder"],
            from: oct,
            fromByMethod: { strategy: oct, baseline: Date.UTC(2026, 9, 31) / 1000 },
          },
        ],
      ]),
    );
    expect(r.months[0].strategyBets).toBeGreaterThan(0);
    expect(r.months[0].baselineBets).toBe(0);
  });
});
