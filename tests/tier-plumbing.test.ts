/**
 * Owner, 2026-11-26: copy replays are reused for up to 14 days instead of failing "not
 * measured"; a never-replayed trader's copy check is pending (no demotion, no pass); Stage 2
 * replays rotate (urgent → never replayed → oldest); a due full check stays due until the
 * trader is actually replayed.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@/lib/db/client";
import { traderPositions, traders, traderScores } from "@/lib/db/schema";
import {
  DEFAULT_SCORE,
  REPLAY_REUSE_DAYS,
  replayOrder,
  scoreAll,
  storedReplayedAt,
  withStoredReplay,
} from "@/lib/jobs/score";
import { DEFAULT_SCORING_CONFIG as cfg } from "@/lib/scoring/config";
import type { TraderMetrics } from "@/lib/scoring/metrics";
import { scoreTrader } from "@/lib/scoring/score";

import { createTestDb } from "./helpers/db";

vi.mock("@/lib/polymarket/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/data")>()),
  getActivity: vi.fn(async () => ({
    data: [],
    pagination: { has_more: false, next_cursor: null },
  })),
}));

const DAY = 86_400;
const NOW = 1_795_000_000;

describe("tiers while the copy check waits for a replay", () => {
  const CTX = { eThreshold: 1, candidates: 1 };
  // Passes every check except the copy check (not measured).
  const base = {
    nResolved: 100,
    nEvents: 50,
    nHoldout: 100,
    eSkill: 1e9,
    eNoEdge: 0,
    holdoutDays: 30,
    roiShrunk: 0.5,
    topMarketShare: 0,
    top3Share: 0,
    months: 12,
    profitableMonthsPct: 1,
    recoveryFactor: 99,
    tradesPerDay: 1,
    bothSidesRatio: 0,
    medianHoldHours: 99,
    copyAdjRoi: null,
    copyRoiUpper: null,
    nCopyReplays: 0,
    oosRoi: 0.5,
    daysSinceTrade: 0,
    sinceVerifiedDays: null,
  } as unknown as TraderMetrics;
  const tier = (over: Partial<TraderMetrics>) => scoreTrader({ ...base, ...over }, cfg, CTX).tier;

  it("never replayed: a Candidate (waiting in line), not Watchlist, and never Verified", () => {
    expect(tier({ copyReplayedAt: null })).toBe("candidate");
    // Skill still pending too: still a Candidate (it used to be Watchlist).
    expect(tier({ copyReplayedAt: null, eSkill: 0.5 })).toBe("candidate");
  });

  it("replayed and short of evidence: the copy check counts as failed, as before", () => {
    expect(tier({ copyReplayedAt: NOW })).toBe("watchlist");
  });

  it("a pending copy check doesn't tighten the Watchlist limit: 2 other misses stay Watchlist", () => {
    // Skill proven, copy never replayed, two soft misses: Watchlist (≤ 3), not Rejected.
    expect(tier({ copyReplayedAt: null, oosRoi: -0.1, top3Share: 0.9 })).toBe("watchlist");
  });

  it("a measured passing copy check is still needed for Verified", () => {
    expect(tier({ copyReplayedAt: NOW, copyAdjRoi: 0.05, copyRoiUpper: 0.2 })).toBe("verified");
  });
});

describe("reusing the last replay", () => {
  const fresh = {
    copyAdjRoi: null,
    copyAdjRoiMean: null,
    copyRoiUpper: null,
    nCopyReplays: 0,
    copyReplayedAt: null,
    sinceVerifiedFrom: null,
    sinceVerifiedCopies: null,
  } as unknown as TraderMetrics;
  const stored = (daysAgo: number, extra: Record<string, unknown> = {}) => ({
    computedAt: new Date((NOW - DAY) * 1000),
    metrics: {
      copyAdjRoi: 0.04,
      copyAdjRoiMean: 0.09,
      copyRoiUpper: 0.2,
      nCopyReplays: 120,
      copyReplayedAt: NOW - daysAgo * DAY,
      sinceVerifiedFrom: NOW - 60 * DAY,
      sinceVerifiedCopies: 70,
      ...extra,
    },
  });

  it(`reuses a replay up to ${REPLAY_REUSE_DAYS} days old, keeping when it was measured`, () => {
    const m = withStoredReplay(fresh, stored(13), true, NOW);
    expect(m.copyAdjRoi).toBe(0.04);
    expect(m.nCopyReplays).toBe(120);
    expect(m.copyReplayedAt).toBe(NOW - 13 * DAY);
    expect(m.sinceVerifiedCopies).toBe(70);
  });

  it("not after 14 days, not over a replay made today, not the Proven record after a re-pick", () => {
    expect(withStoredReplay(fresh, stored(15), true, NOW)).toBe(fresh);
    const today = { ...fresh, copyReplayedAt: NOW, copyAdjRoi: 0.1 } as TraderMetrics;
    expect(withStoredReplay(today, stored(1), true, NOW)).toBe(today);
    const repicked = withStoredReplay(fresh, stored(1), false, NOW);
    expect(repicked.copyAdjRoi).toBe(0.04);
    expect(repicked.sinceVerifiedCopies).toBeNull();
  });

  it("rows from before copyReplayedAt existed: replayed at their computed time if they hold replays", () => {
    const at = new Date((NOW - 3 * DAY) * 1000);
    expect(storedReplayedAt({ computedAt: at, metrics: { nCopyReplays: 80 } })).toBe(NOW - 3 * DAY);
    expect(storedReplayedAt({ computedAt: at, metrics: { nCopyReplays: 0 } })).toBeNull();
    expect(
      storedReplayedAt({ computedAt: at, metrics: { copyReplayedAt: null, nCopyReplays: 80 } }),
    ).toBeNull();
  });
});

describe("Stage 2 replay order", () => {
  const c = (wallet: string, over: Partial<Parameters<typeof replayOrder>[0][number]> = {}) => ({
    wallet,
    score: 50,
    urgent: false,
    replayedAt: NOW - DAY,
    wouldPass: true,
    ...over,
  });

  it("urgent first, then never replayed, then the oldest replay; Watchlist after the rest in each", () => {
    const order = replayOrder([
      c("recent-high", { replayedAt: NOW - DAY, score: 99 }),
      c("old", { replayedAt: NOW - 10 * DAY }),
      c("never-watch", { replayedAt: null, wouldPass: false, score: 99 }),
      c("never", { replayedAt: null, score: 10 }),
      c("due", { urgent: true, score: 1 }),
      c("old-watch", { replayedAt: NOW - 12 * DAY, wouldPass: false }),
    ]);
    expect(order).toEqual(["due", "never", "never-watch", "old", "recent-high", "old-watch"]);
  });
});

describe("fullCheckDue", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  beforeEach(async () => {
    for (const t of [traderScores, traderPositions, traders]) await db.delete(t);
  });

  async function dueTrader() {
    const now = Date.now();
    const ago = (d: number) => new Date(now - d * 86_400_000);
    await db.insert(traders).values({
      wallet: "0xdue",
      firstCheckedAt: ago(40),
      lastCheckedAt: ago(10),
      lastBackfillAt: ago(0),
      fullCheckDue: true,
    });
    await db.insert(traderPositions).values(
      Array.from({ length: 80 }, (_, i) => ({
        wallet: "0xdue",
        conditionId: `c${i}`,
        tokenId: `t${i}`,
        status: "CLOSED",
        avgPrice: 0.5,
        size: 0,
        sharesBought: 100,
        realizedPnl: i % 3 ? 50 : -50,
        won: i % 3 !== 0,
        firstEntryAt: ago(35 - i * 0.3),
        lastActivityAt: ago(34 - i * 0.3),
      })),
    );
  }
  const due = async () =>
    (await db.select().from(traders).where(eq(traders.wallet, "0xdue")))[0].fullCheckDue;

  it("stays due when the trader wasn't replayed, and is cleared once they are", async () => {
    await dueTrader();
    const quick = { ...cfg, simulations: 100 };
    await scoreAll(db, quick, { ...DEFAULT_SCORE, shortlistSize: 0 }, () => {}, ["0xdue"]);
    expect(await due()).toBe(true);
    await scoreAll(db, quick, DEFAULT_SCORE, () => {}, ["0xdue"]);
    expect(await due()).toBe(false);
  });
});
