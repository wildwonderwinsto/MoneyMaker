/**
 * What the Backtest page may claim (owner, 2026-11-10: "make sure I can rely on it").
 *
 * Re-derived months pick from today's stored traders, and pruning leaves only those who pass
 * today: on the local data the same backtest gave the strategy +593% over all 63 stored
 * traders and +215% over the 33 that pass today, and the baseline −6.7% vs +66.5%. So only
 * months whose picks were recorded at the time count as evidence, and the verdict says
 * "too early" until there are enough of them.
 */
import { describe, expect, it, vi } from "vitest";

import * as clob from "@/lib/polymarket/clob";
import * as data from "@/lib/polymarket/data";

vi.mock("@/lib/polymarket/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/data")>()),
  getActivity: vi.fn(),
}));
vi.mock("@/lib/polymarket/clob", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/clob")>()),
  getMidpoints: vi.fn(),
}));

import {
  methodResult,
  recordedVerdict,
  type BacktestMonth,
  type PickMonthResult,
} from "@/lib/scoring/backtest";

const pick = (staked: number, pnl: number, partial = false, bets = 3): PickMonthResult => ({
  bets,
  staked,
  pnl,
  partial,
});

describe("methodResult: a method's month from its picks", () => {
  it("averages picks equally, idle picks count 0, partial ones are left out", () => {
    const r = methodResult([
      pick(100, 20),
      pick(50, -10),
      pick(0, 0, false, 0),
      pick(80, 80, true),
    ]);
    // (+20% − 20% + 0%) / 3; the partial pick is left out.
    expect(r.ret).toBeCloseTo(0, 10);
    expect(r).toMatchObject({ picks: 4, counted: 3, partial: 1, bets: 6 });
  });

  it("no picks (or only partial ones): no return, not a fake 0%", () => {
    expect(methodResult([]).ret).toBeNull();
    expect(methodResult([pick(10, 5, true)]).ret).toBeNull();
  });
});

const month = (
  m: string,
  s: number,
  b: number,
  over: Partial<BacktestMonth> = {},
): BacktestMonth => ({
  month: m,
  strategyPicks: ["a", "b", "c"],
  baselinePicks: ["x", "y", "z"],
  strategyReturn: s,
  baselineReturn: b,
  strategyBets: 30,
  baselineBets: 30,
  recorded: true,
  partialPicks: 0,
  rebuiltPicks: 6,
  ...over,
});

describe("recordedVerdict: what the record can say", () => {
  it("nothing recorded yet → none (re-derived months never count)", () => {
    const v = recordedVerdict([month("2026-09", 0.5, 0, { recorded: false })]);
    expect(v.kind).toBe("none");
    expect(v.months).toBe(0);
  });

  it("fewer than 3 recorded months → too early, whatever the numbers", () => {
    const v = recordedVerdict([month("2026-11", 0.4, 0), month("2026-12", 0.3, 0)]);
    expect(v.kind).toBe("too_early");
    expect(v.months).toBe(2);
    expect(v.meanGap).toBeCloseTo(0.35, 10);
  });

  it("a steady gap over enough months → ahead, with a 90% range above 0", () => {
    const v = recordedVerdict([
      month("2027-01", 0.06, 0.01),
      month("2027-02", 0.05, 0.0),
      month("2027-03", 0.08, 0.02),
      month("2027-04", 0.04, -0.01),
    ]);
    expect(v.kind).toBe("ahead");
    expect(v.low!).toBeGreaterThan(0);
    expect(v.high!).toBeGreaterThan(v.low!);
  });

  it("gaps that swing both ways → unclear; a steady shortfall → behind", () => {
    const swing = recordedVerdict([
      month("2027-01", 0.3, 0),
      month("2027-02", -0.25, 0),
      month("2027-03", 0.2, 0),
    ]);
    expect(swing.kind).toBe("unclear");
    expect(swing.low!).toBeLessThan(0);
    expect(swing.high!).toBeGreaterThan(0);
    const behind = recordedVerdict([
      month("2027-01", -0.05, 0.01),
      month("2027-02", -0.04, 0.0),
      month("2027-03", -0.06, 0.01),
    ]);
    expect(behind.kind).toBe("behind");
  });

  it("counts thin months (under 3 strategy picks: one trader's luck)", () => {
    const v = recordedVerdict([
      month("2027-01", 0.1, 0, { strategyPicks: ["a"] }),
      month("2027-02", 0.1, 0),
    ]);
    expect(v.thinMonths).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------
// The month in progress: recorded picks rebuilt from their activity so far.

describe("monthToDate", () => {
  it("rebuilds this month's recorded picks up to now, from when each was recorded", async () => {
    const { createTestDb } = await import("./helpers/db");
    const { monthlySelections } = await import("@/lib/db/schema");
    const { monthToDate } = await import("@/lib/jobs/backtest");
    const { DEFAULT_BACKTEST } = await import("@/lib/scoring/backtest");
    const { db, close } = await createTestDb();
    try {
      const now = new Date("2026-11-20T12:00:00Z");
      const recordedAt = new Date("2026-11-04T10:00:00Z");
      const rec = Math.floor(recordedAt.getTime() / 1000);
      // Nothing recorded this month yet → nothing to show.
      expect(await monthToDate(db, DEFAULT_BACKTEST, now)).toBeNull();
      await db.insert(monthlySelections).values([
        { month: "2026-11", method: "strategy", wallet: "0xs", rank: 1, recordedAt },
        { month: "2026-11", method: "baseline", wallet: "0xb", rank: 1, recordedAt },
        // Last month's rows are the finished months' job, not this one's.
        { month: "2026-10", method: "strategy", wallet: "0xold", rank: 1, recordedAt },
      ]);
      const trade = (wallet: string, ts: number, side: string, price: number, token: string) => ({
        proxy_wallet: wallet,
        timestamp: ts,
        condition_id: `c-${token}`,
        type: "TRADE",
        size: 100,
        usdc_size: 100 * price,
        transaction_hash: `0x${wallet}${ts}`,
        price,
        token_id: token,
        side,
        outcome_index: 0,
        title: null,
        slug: null,
        icon: null,
        event_slug: null,
        outcome: "Yes",
        name: null,
        pseudonym: null,
      });
      const activity: Record<string, ReturnType<typeof trade>[]> = {
        // Bought at 40¢ after being recorded, sold at 60¢: a winner.
        "0xs": [
          trade("0xs", rec + 3600, "BUY", 0.4, "t1"),
          trade("0xs", rec + 7200, "SELL", 0.6, "t1"),
        ],
        // Bought at 50¢, still held, now 30¢: a loser marked at today's price.
        "0xb": [trade("0xb", rec + 3600, "BUY", 0.5, "t2")],
      };
      vi.mocked(data.getActivity).mockImplementation(async ({ user, start, end }) => ({
        data: (activity[user] ?? []).filter(
          (r) => r.timestamp >= (start ?? 0) && r.timestamp <= (end ?? Infinity),
        ),
        pagination: { has_more: false, next_cursor: null },
      }));
      vi.mocked(clob.getMidpoints).mockResolvedValue(new Map([["t2", 0.3]]));
      const params = { ...DEFAULT_BACKTEST, minLeaderUsd: 1 };
      const r = await monthToDate(db, params, now);
      expect(r?.month).toBe("2026-11");
      expect(r?.from).toBe(rec);
      expect(r?.strategy).toMatchObject({ picks: 1, counted: 1, bets: 1 });
      expect(r!.strategy.ret!).toBeGreaterThan(0.3); // 40¢ → 60¢ less slippage and fees
      expect(r!.baseline.ret!).toBeLessThan(-0.35); // 50¢ → 30¢
      // Only this month's picks were looked up.
      const users = vi.mocked(data.getActivity).mock.calls.map((c) => c[0].user);
      expect(users).not.toContain("0xold");
      // Nothing is written back: the finished month is rebuilt once, after it ends.
      const rows = await db.select().from(monthlySelections);
      expect(rows.every((x) => x.bets === null)).toBe(true);
    } finally {
      await close();
    }
  });
});
