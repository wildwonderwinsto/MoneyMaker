import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Db } from "@/lib/db/client";
import {
  follows,
  jobRuns,
  leaderboardSnapshots,
  markets,
  monthlySelections,
  paperAccounts,
  paperPositions,
  traderPnlDaily,
  traderPositions,
  traders,
  traderScores,
  traderTrades,
} from "@/lib/db/schema";
import { backfillTrader, cleanupStorage, prunePositions, typicalStake } from "@/lib/jobs/backfill";
import { loadRecordedPicks, recordedWallets, recordMonthlySelections } from "@/lib/jobs/backtest";
import { succeededToday } from "@/lib/jobs/util";
import * as data from "@/lib/polymarket/data";

import { createTestDb } from "./helpers/db";

vi.mock("@/lib/polymarket/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/data")>()),
  getPositions: vi.fn(),
  getUserPnl: vi.fn(),
}));

describe("backfillTrader", () => {
  it("requests positions newest-first so the cap can't cherry-pick winners", async () => {
    // Regression: the API defaults to largest-profit-first; capping that list kept only
    // each trader's best bets and inflated ROI ~8x for an active wallet.
    vi.mocked(data.getPositions).mockResolvedValue({
      data: [],
      pagination: { has_more: false, next_cursor: null },
    });
    vi.mocked(data.getUserPnl).mockResolvedValue([]);
    await db.insert(traders).values({ wallet: "0xsort" }).onConflictDoNothing();
    await backfillTrader(db, "0xsort", { maxPositionsPerStatus: 10 });
    const calls = vi.mocked(data.getPositions).mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.status).sort()).toEqual(["CLOSED", "OPEN"]);
    expect(calls.every((c) => c.sortBy === "TIMESTAMP")).toBe(true);
  });

  it("drops stored positions that are no longer in the latest fetch", async () => {
    await db.insert(traders).values({ wallet: "0xstale" }).onConflictDoNothing();
    await db.insert(traderPositions).values([
      { wallet: "0xstale", conditionId: "c-old", tokenId: "t-old", status: "CLOSED" },
      { wallet: "0xother", conditionId: "c-x", tokenId: "t-x", status: "CLOSED" },
    ]);
    const fresh = {
      proxy_wallet: "0xstale",
      token_id: "t-new",
      condition_id: "c-new",
      current_size: 0,
      avg_price: 0.5,
      total_size: 10,
      realized_pnl: 1,
      status: "CLOSED",
    } as data.Position;
    vi.mocked(data.getPositions).mockImplementation(async ({ status }) => ({
      data: status === "CLOSED" ? [fresh] : [],
      pagination: { has_more: false, next_cursor: null },
    }));
    vi.mocked(data.getUserPnl).mockResolvedValue([]);
    await backfillTrader(db, "0xstale", { maxPositionsPerStatus: 10 });
    const rows = await db
      .select({ w: traderPositions.wallet, t: traderPositions.tokenId })
      .from(traderPositions);
    expect(rows.filter((r) => r.w === "0xstale").map((r) => r.t)).toEqual(["t-new"]);
    expect(rows.some((r) => r.w === "0xother")).toBe(true); // other wallets untouched
  });

  it("keeps both position lists to the window complete for both when one hits the cap", async () => {
    const pos = (token: string, lastEvent: number, status: string) =>
      ({
        proxy_wallet: "0xcap",
        token_id: token,
        condition_id: `c-${token}`,
        current_size: 0,
        avg_price: 0.5,
        total_size: 10,
        realized_pnl: 1,
        status,
        last_event_at: lastEvent,
      }) as data.Position;
    // CLOSED hits the cap of 3 and only reaches back to t=100; OPEN goes back to t=10.
    vi.mocked(data.getPositions).mockImplementation(async ({ status }) => ({
      data:
        status === "CLOSED"
          ? [pos("w1", 300, "CLOSED"), pos("w2", 200, "CLOSED"), pos("w3", 100, "CLOSED")]
          : [pos("l1", 250, "REDEEMABLE"), pos("l2", 10, "REDEEMABLE")],
      pagination: { has_more: false, next_cursor: null },
    }));
    vi.mocked(data.getUserPnl).mockResolvedValue([]);
    await db.insert(traders).values({ wallet: "0xcap" }).onConflictDoNothing();
    await backfillTrader(db, "0xcap", { maxPositionsPerStatus: 3 });
    const rows = await db
      .select({ t: traderPositions.tokenId })
      .from(traderPositions)
      .where(eq(traderPositions.wallet, "0xcap"));
    expect(rows.map((r) => r.t).sort()).toEqual(["l1", "w1", "w2", "w3"]); // l2 is too old
  });

  it("treats a 0 timestamp as unknown, not as 1970 (kept, like a missing one)", async () => {
    // Regression (A7): the API sends 0, not null, when a time wasn't recorded. As a real
    // time, 0 fell before the window cutoff, so the row was silently dropped.
    const pos = (token: string, lastEvent: number, status: string) =>
      data.Position.parse({
        proxy_wallet: "0xzero",
        token_id: token,
        condition_id: `c-${token}`,
        current_size: 0,
        avg_price: 0.5,
        total_size: 10,
        realized_pnl: 1,
        status,
        first_entry_at: lastEvent,
        last_event_at: lastEvent,
      });
    vi.mocked(data.getPositions).mockImplementation(async ({ status }) => ({
      data:
        status === "CLOSED"
          ? [pos("z1", 300, "CLOSED"), pos("z2", 200, "CLOSED")]
          : [pos("z0", 0, "REDEEMABLE")],
      pagination: { has_more: false, next_cursor: null },
    }));
    vi.mocked(data.getUserPnl).mockResolvedValue([]);
    await db.insert(traders).values({ wallet: "0xzero" }).onConflictDoNothing();
    await backfillTrader(db, "0xzero", { maxPositionsPerStatus: 2 });
    const rows = await db
      .select()
      .from(traderPositions)
      .where(eq(traderPositions.wallet, "0xzero"));
    expect(rows.map((r) => r.tokenId).sort()).toEqual(["z0", "z1", "z2"]);
    const z0 = rows.find((r) => r.tokenId === "z0")!;
    expect(z0.firstEntryAt).toBeNull();
    expect(z0.lastActivityAt).toBeNull();
  });

  it("records the last real trade from the trade count, not claims", async () => {
    vi.mocked(data.getPositions).mockResolvedValue({
      data: [],
      pagination: { has_more: false, next_cursor: null },
    });
    const day = (d: number) => Date.UTC(2026, 9, d) / 1000;
    vi.mocked(data.getUserPnl).mockResolvedValue([
      { timestamp: day(1), trade_count: 10, position_pnl: 0 },
      { timestamp: day(2), trade_count: 12, position_pnl: 5 },
      { timestamp: day(3), trade_count: 12, position_pnl: 9 }, // only a claim / settlement
    ]);
    await db.insert(traders).values({ wallet: "0xlast" }).onConflictDoNothing();
    await backfillTrader(db, "0xlast", { maxPositionsPerStatus: 10 });
    const [t] = await db.select().from(traders).where(eq(traders.wallet, "0xlast"));
    expect(t.lastTradeAt?.getTime()).toBe(day(2) * 1000);
    await db.delete(traderPnlDaily).where(eq(traderPnlDaily.wallet, "0xlast")); // isolation
  });

  it("stores trading PnL, not rebates and rewards a copier can't earn", async () => {
    vi.mocked(data.getPositions).mockResolvedValue({
      data: [],
      pagination: { has_more: false, next_cursor: null },
    });
    // A market maker: losing on trades, profitable only thanks to rebates.
    vi.mocked(data.getUserPnl).mockResolvedValue([
      {
        timestamp: Date.UTC(2026, 9, 1) / 1000,
        realized_pnl: -50,
        unrealized_pnl: 10,
        position_pnl: -40,
        economic_pnl: 60,
      },
    ]);
    await db.insert(traders).values({ wallet: "0xmaker" }).onConflictDoNothing();
    await backfillTrader(db, "0xmaker", { maxPositionsPerStatus: 10 });
    const [row] = await db
      .select()
      .from(traderPnlDaily)
      .where(eq(traderPnlDaily.wallet, "0xmaker"));
    expect(row.pnl).toBe(-40);
    await db.delete(traderPnlDaily).where(eq(traderPnlDaily.wallet, "0xmaker")); // isolation
  });

  it("treats total_size 0 (shares from a split, none bought) as unknown, not as free", async () => {
    // Regression (live, Nov 2026): the API answers total_size 0.0, not null, when the shares
    // came from splitting USDC rather than buying, so `?? current_size` never fired and
    // the position was stored as costing $0 while its PnL still counted.
    const pos = (token: string, current: number, status: string) =>
      ({
        proxy_wallet: "0xsplit",
        token_id: token,
        condition_id: `c-${token}`,
        current_size: current,
        avg_price: 0.0537,
        total_size: 0,
        realized_pnl: -0.57,
        status,
      }) as data.Position;
    vi.mocked(data.getPositions).mockImplementation(async ({ status }) => ({
      data:
        status === "OPEN"
          ? [pos("held", 224.27, "REDEEMABLE")]
          : [pos("gone", 0, "CLOSED"), pos("dust", 0.0048, "CLOSED")],
      pagination: { has_more: false, next_cursor: null },
    }));
    vi.mocked(data.getUserPnl).mockResolvedValue([]);
    await db.insert(traders).values({ wallet: "0xsplit" }).onConflictDoNothing();
    await backfillTrader(db, "0xsplit", { maxPositionsPerStatus: 10 });
    const rows = await db
      .select()
      .from(traderPositions)
      .where(eq(traderPositions.wallet, "0xsplit"));
    const held = rows.find((r) => r.tokenId === "held")!;
    expect(held.sharesBought).toBe(224.27); // what it still holds: at least that was paid for
    expect(held.totalCost).toBeCloseTo(224.27 * 0.0537, 6);
    const gone = rows.find((r) => r.tokenId === "gone")!;
    expect(gone.sharesBought).toBeNull(); // nothing to go on
    expect(gone.totalCost).toBeNull();
    // Live: CLOSED, 0.0048 shares left, $33.4k realized. Leftover dust says nothing about
    // what was paid; stored as $0.005 it showed on the trader page as a 7-million-% bet.
    const dust = rows.find((r) => r.tokenId === "dust")!;
    expect(dust.sharesBought).toBeNull();
    expect(dust.totalCost).toBeNull();
  });

  it("keeps stored history when the API answers empty for a wallet it had data for", async () => {
    // Regression: an empty-but-valid answer (transient glitch) deleted every position and
    // PnL point, nulled the usual stake used for sizing, and stamped the wallet as freshly
    // backfilled. Closed positions never disappear, so empty here means the fetch failed.
    const W = "0xglitch";
    const now = Math.floor(Date.now() / 1000);
    const pos = (i: number) =>
      ({
        proxy_wallet: W,
        token_id: `g${i}`,
        condition_id: `cg${i}`,
        current_size: 0,
        avg_price: 0.5,
        total_size: 200,
        realized_pnl: 1,
        status: "CLOSED",
        first_entry_at: now - 86_400,
        last_event_at: now - 3600,
      }) as data.Position;
    vi.mocked(data.getPositions).mockImplementation(async ({ status }) => ({
      data: status === "CLOSED" ? Array.from({ length: 8 }, (_, i) => pos(i)) : [],
      pagination: { has_more: false, next_cursor: null },
    }));
    vi.mocked(data.getUserPnl).mockResolvedValue([{ timestamp: now - 86_400, position_pnl: 5 }]);
    await db.insert(traders).values({ wallet: W }).onConflictDoNothing();
    await backfillTrader(db, W, { maxPositionsPerStatus: 1000 });
    const [before] = await db.select().from(traders).where(eq(traders.wallet, W));
    expect(before.typicalStakeUsd).toBe(100);

    const empty = { data: [], pagination: { has_more: false, next_cursor: null } };
    const count = async () => ({
      positions: (await db.select().from(traderPositions).where(eq(traderPositions.wallet, W)))
        .length,
      pnl: (await db.select().from(traderPnlDaily).where(eq(traderPnlDaily.wallet, W))).length,
    });
    // Empty positions, PnL still there.
    vi.mocked(data.getPositions).mockResolvedValue(empty);
    await expect(backfillTrader(db, W, { maxPositionsPerStatus: 1000 })).rejects.toThrow(/empty/);
    // Positions there, PnL empty.
    vi.mocked(data.getPositions).mockImplementation(async ({ status }) => ({
      data: status === "CLOSED" ? Array.from({ length: 8 }, (_, i) => pos(i)) : [],
      pagination: { has_more: false, next_cursor: null },
    }));
    vi.mocked(data.getUserPnl).mockResolvedValue([]);
    await expect(backfillTrader(db, W, { maxPositionsPerStatus: 1000 })).rejects.toThrow(/empty/);

    expect(await count()).toEqual({ positions: 8, pnl: 1 });
    const [after] = await db.select().from(traders).where(eq(traders.wallet, W));
    expect(after.typicalStakeUsd).toBe(100);
    expect(after.lastBackfillAt).toEqual(before.lastBackfillAt);
    await prunePositions(db, [W]); // isolation
  });
});

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("typicalStake", () => {
  const now = 1_800_000_000;
  const at = (daysAgo: number) => now - daysAgo * 86_400;
  it("is the median recent stake, ignoring stakes too small to copy", () => {
    const recent = [30, 40, 50, 60, 1000].map((cost) => ({ cost, firstEntryAt: at(10) }));
    const dust = Array.from({ length: 20 }, () => ({ cost: 2, firstEntryAt: at(5) }));
    const old = Array.from({ length: 20 }, () => ({ cost: 5000, firstEntryAt: at(200) }));
    expect(typicalStake([...recent, ...dust, ...old], now)).toBe(50);
  });
  it("falls back to all positions, and to null with too little data", () => {
    const old = [100, 200, 300, 400, 500].map((cost) => ({ cost, firstEntryAt: at(200) }));
    expect(typicalStake(old, now)).toBe(300);
    expect(typicalStake(old.slice(0, 4), now)).toBeNull();
  });
});

describe("storage maintenance", () => {
  it("prunes rejected traders and removes orphan markets and old trades", async () => {
    await db.insert(traders).values([
      { wallet: "0xkeep", lastBackfillAt: new Date() },
      { wallet: "0xdrop", lastBackfillAt: new Date() },
    ]);
    await db.insert(traderPositions).values([
      { wallet: "0xkeep", conditionId: "c-keep", tokenId: "t1", status: "OPEN" },
      { wallet: "0xdrop", conditionId: "c-drop", tokenId: "t2", status: "OPEN" },
    ]);
    await db.insert(traderPnlDaily).values({ wallet: "0xdrop", day: "2026-10-01", pnl: 5 });
    await db.insert(markets).values([
      { conditionId: "c-keep", question: "kept?" },
      { conditionId: "c-drop", question: "dropped?" },
    ]);
    const old = new Date(Date.now() - 200 * 86_400_000);
    await db.insert(traderTrades).values([
      {
        id: "old",
        wallet: "0xkeep",
        ts: old,
        conditionId: "c-keep",
        tokenId: "t1",
        side: "BUY",
        price: 0.5,
        size: 1,
        usdcSize: 0.5,
      },
      {
        id: "new",
        wallet: "0xkeep",
        ts: new Date(),
        conditionId: "c-keep",
        tokenId: "t1",
        side: "BUY",
        price: 0.5,
        size: 1,
        usdcSize: 0.5,
      },
    ]);

    expect(await prunePositions(db, ["0xdrop"])).toBe(1);
    const [dropped] = await db.select().from(traders).where(eq(traders.wallet, "0xdrop"));
    expect(dropped.lastBackfillAt).toBeNull();
    expect(await db.select().from(traderPnlDaily)).toHaveLength(0);

    const cleaned = await cleanupStorage(db);
    expect(cleaned).toEqual({ markets: 1, trades: 1, snapshots: 0 });
    const left = await db.select({ id: markets.conditionId }).from(markets);
    expect(left.map((m) => m.id)).toEqual(["c-keep"]);
  });

  it("never prunes a trader who is followed (even paused) or whose copy we still hold", async () => {
    // Regression: a rejected trader's history was deleted even while followed or copied,
    // leaving the trader page empty and the next scoring run skipping them.
    const [acct] = await db
      .insert(paperAccounts)
      .values({ name: "Prune", startingBalance: 1000, cash: 1000 })
      .returning();
    await db.insert(traders).values(
      ["0xpfollow", "0xppaused", "0xpheld", "0xpclosed", "0xprej"].map((wallet) => ({
        wallet,
        lastBackfillAt: new Date(),
      })),
    );
    await db
      .insert(follows)
      .values([{ wallet: "0xpfollow" }, { wallet: "0xppaused", enabled: false }]);
    await db.insert(paperPositions).values([
      { accountId: acct.id, sourceWallet: "0xpheld", conditionId: "c", tokenId: "t", shares: 5 },
      {
        accountId: acct.id,
        sourceWallet: "0xpclosed",
        conditionId: "c",
        tokenId: "t",
        status: "closed",
      },
    ]);
    const wallets = ["0xpfollow", "0xppaused", "0xpheld", "0xpclosed", "0xprej"];
    await db
      .insert(traderPositions)
      .values(
        wallets.map((wallet) => ({ wallet, conditionId: "c", tokenId: "t", status: "OPEN" })),
      );
    await db
      .insert(traderPnlDaily)
      .values(wallets.map((wallet) => ({ wallet, day: "2026-10-01", pnl: 1 })));

    expect(await prunePositions(db, wallets)).toBe(2);
    const kept = await db
      .select({ w: traderPositions.wallet })
      .from(traderPositions)
      .where(inArray(traderPositions.wallet, wallets));
    expect(kept.map((r) => r.w).sort()).toEqual(["0xpfollow", "0xpheld", "0xppaused"]);
    const pnlKept = await db
      .select({ w: traderPnlDaily.wallet })
      .from(traderPnlDaily)
      .where(inArray(traderPnlDaily.wallet, wallets));
    expect(pnlKept.map((r) => r.w).sort()).toEqual(["0xpfollow", "0xpheld", "0xppaused"]);
    const stamped = await db
      .select({ w: traders.wallet, at: traders.lastBackfillAt })
      .from(traders)
      .where(inArray(traders.wallet, wallets));
    expect(
      stamped
        .filter((r) => r.at === null)
        .map((r) => r.w)
        .sort(),
    ).toEqual(["0xpclosed", "0xprej"]);
  });
});

describe("monthly selections (point-in-time picks)", () => {
  it("records each method once per month and feeds next month's backtest", async () => {
    const day = new Date(Date.UTC(2026, 10, 3, 10));
    const score = (wallet: string, tier: "elite" | "verified" | "rejected", s: number) => ({
      wallet,
      tier,
      score: s,
      passed: tier !== "rejected",
      nResolved: 60,
      nEvents: 30,
    });
    await db
      .insert(traderScores)
      .values([
        score("0xa", "verified", 60),
        score("0xb", "elite", 80),
        score("0xc", "rejected", 90),
      ]);
    await db.insert(leaderboardSnapshots).values(
      ["0xtop1", "0xtop2"].map((wallet, i) => ({
        capturedAt: day,
        timePeriod: "month",
        category: "overall",
        sortBy: "PNL",
        rank: i + 1,
        wallet,
        pnl: 1000 - i,
      })),
    );
    const log = () => {};
    expect(await recordMonthlySelections(db, 10, log, day)).toMatchObject({
      month: "2026-11",
      strategy: 2,
      baseline: 2,
    });
    // Later runs in the month change nothing.
    await db.insert(traderScores).values(score("0xd", "elite", 99));
    expect(
      await recordMonthlySelections(db, 10, log, new Date(Date.UTC(2026, 10, 20))),
    ).toMatchObject({
      strategy: 0,
      baseline: 0,
    });
    const rows = await db.select().from(monthlySelections);
    expect(rows.filter((r) => r.method === "strategy").map((r) => r.wallet)).toEqual([
      "0xb",
      "0xa",
    ]);
    // Top earners get a trader row so they are backfilled and evaluated.
    const known = (await db.select({ w: traders.wallet }).from(traders)).map((r) => r.w);
    expect(known).toEqual(expect.arrayContaining(["0xtop1", "0xtop2"]));
    expect(await recordedWallets(db, 6, day)).toHaveLength(4);

    const next = await loadRecordedPicks(db, 6, new Date(Date.UTC(2026, 11, 2)));
    expect(next.get("2026-11")).toEqual({
      strategy: ["0xb", "0xa"],
      baseline: ["0xtop1", "0xtop2"],
      from: day.getTime() / 1000,
    });
  });
});

describe("succeededToday", () => {
  it("counts only a successful run that started today (UTC)", async () => {
    const now = new Date("2026-11-05T16:00:00Z");
    expect(await succeededToday(db, "daily-test", now)).toBe(false);
    // Yesterday late (a delayed run) and a failed run today don't count.
    await db.insert(jobRuns).values([
      { job: "daily-test", status: "ok", startedAt: new Date("2026-11-04T23:30:00Z") },
      { job: "daily-test", status: "error", startedAt: new Date("2026-11-05T10:20:00Z") },
      { job: "score", status: "ok", startedAt: new Date("2026-11-05T10:20:00Z") },
    ]);
    expect(await succeededToday(db, "daily-test", now)).toBe(false);
    await db
      .insert(jobRuns)
      .values({ job: "daily-test", status: "ok", startedAt: new Date("2026-11-05T10:25:00Z") });
    expect(await succeededToday(db, "daily-test", now)).toBe(true);
    // The next UTC day starts fresh.
    expect(await succeededToday(db, "daily-test", new Date("2026-11-06T10:00:00Z"))).toBe(false);
  });
});
