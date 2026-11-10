import { readFileSync } from "node:fs";

import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Db } from "@/lib/db/client";
import {
  evidenceStates,
  follows,
  hiddenTraders,
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
import {
  loadRecordedPicks,
  rebuildRecordedMonths,
  recordedWallets,
  recordMonthlySelections,
} from "@/lib/jobs/backtest";
import { DEFAULT_BACKTEST } from "@/lib/scoring/backtest";
import { loadInputs } from "@/lib/jobs/score";
import { succeededToday } from "@/lib/jobs/util";
import * as data from "@/lib/polymarket/data";

import { createTestDb } from "./helpers/db";

vi.mock("@/lib/polymarket/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/data")>()),
  getPositions: vi.fn(),
  getUserPnl: vi.fn(),
  getActivity: vi.fn(),
}));
// No network in tests: the pick-month rebuild values held shares with CLOB midpoints.
vi.mock("@/lib/polymarket/clob", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/clob")>()),
  getMidpoints: vi.fn(async () => new Map<string, number>()),
}));
const noActivity = () =>
  vi.mocked(data.getActivity).mockResolvedValue({
    data: [],
    pagination: { has_more: false, next_cursor: null },
  } as never);

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

describe("unknown-cost positions", () => {
  // Owner decision (2026-11-08), after checking live: the API's realized P&L on positions
  // whose shares came from splits/conversions (no recorded cost) doesn't reconcile with the
  // wallet's activity. Live: $33,415 "realized" on one neg-risk position, while every
  // dollar the wallet received from that whole event was $17,617. So they aren't scored.
  const W = "0xunknowncost";
  const row = (tokenId: string, over: Partial<typeof traderPositions.$inferInsert>) => ({
    wallet: W,
    conditionId: `c-${tokenId}`,
    tokenId,
    status: "CLOSED",
    avgPrice: 0.5,
    size: 0,
    sharesBought: 100,
    totalCost: 50,
    realizedPnl: 10,
    ...over,
  });

  it("are left out of scoring entirely (ROI, total P&L, luck tests)", async () => {
    await db.insert(traders).values({ wallet: W, lastBackfillAt: new Date() });
    await db.insert(traderPositions).values([
      row("known", {}),
      row("split", {
        avgPrice: 0.9808,
        size: 0.0048,
        sharesBought: null,
        totalCost: null,
        realizedPnl: 33_415,
      }),
    ]);
    const { inputs } = await loadInputs(db, [W], Math.floor(Date.now() / 1000));
    expect(inputs.get(W)!.positions.map((p) => p.tokenId)).toEqual(["known"]);
    await prunePositions(db, [W]); // isolation
  });

  it("migration 0010 turns legacy $0-cost rows into the same shape new backfills store", async () => {
    // Rows written before f15d2c3 stored shares_bought 0 / total_cost 0 for split shares.
    await db.insert(traderPositions).values([
      row("legacy-closed", { sharesBought: 0, totalCost: 0, size: 0.0048 }),
      row("legacy-open", {
        status: "REDEEMABLE",
        sharesBought: 0,
        totalCost: 0,
        size: 224.27,
        avgPrice: 0.0537,
      }),
      row("legacy-gone", { status: "REDEEMABLE", sharesBought: 0, totalCost: 0, size: 0 }),
      row("normal", {}),
    ]);
    const migration = readFileSync("drizzle/0010_unknown_position_cost.sql", "utf8");
    for (const stmt of migration.split("--> statement-breakpoint")) {
      if (stmt.trim()) await db.execute(sql.raw(stmt));
    }
    const rows = await db.select().from(traderPositions).where(eq(traderPositions.wallet, W));
    const by = new Map(rows.map((r) => [r.tokenId, r]));
    expect(by.get("legacy-closed")).toMatchObject({ sharesBought: null, totalCost: null });
    expect(by.get("legacy-open")!.sharesBought).toBe(224.27);
    expect(by.get("legacy-open")!.totalCost).toBeCloseTo(224.27 * 0.0537, 6);
    expect(by.get("legacy-gone")).toMatchObject({ sharesBought: null, totalCost: null });
    expect(by.get("normal")).toMatchObject({ sharesBought: 100, totalCost: 50 });
    await db.delete(traderPositions).where(eq(traderPositions.wallet, W));
  });
});

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
    expect(cleaned).toEqual({ markets: 1, trades: 1, snapshots: 0, scores: 0, evidence: 0 });
    const left = await db.select({ id: markets.conditionId }).from(markets);
    expect(left.map((m) => m.id)).toEqual(["c-keep"]);
  });

  it("keeps leaderboard snapshots 30 days (owner decision 2026-11-08)", async () => {
    // Only the baseline reads them, and only the last 6 hours: 90 days cost ~130 MB.
    const at = (days: number) => new Date(Date.now() - days * 86_400_000);
    const snap = (wallet: string, days: number) => ({
      timePeriod: "month",
      category: "overall",
      sortBy: "PNL",
      rank: 1,
      wallet,
      pnl: 1,
      volume: 1,
      capturedAt: at(days),
    });
    await db.insert(leaderboardSnapshots).values([snap("0xs29", 29), snap("0xs31", 31)]);
    const cleaned = await cleanupStorage(db);
    expect(cleaned.snapshots).toBe(1);
    const left = await db.select({ w: leaderboardSnapshots.wallet }).from(leaderboardSnapshots);
    expect(left.map((r) => r.w)).toContain("0xs29");
    expect(left.map((r) => r.w)).not.toContain("0xs31");
    await db.delete(leaderboardSnapshots);
  });

  it("drops Rejected wallets' running skill evidence after the 30-day cool-down (batch 6)", async () => {
    // A wallet re-picked after its cool-down starts a fresh holdout, and evidence from an
    // older holdout is never reused, so these rows were dead weight kept forever.
    const at = (days: number) => new Date(Date.now() - days * 86_400_000);
    const ws = ["0xe-old", "0xe-new", "0xe-gone", "0xe-cand", "0xe-fol", "0xe-hid"];
    await db.insert(traders).values([
      { wallet: "0xe-old", lastCheckedAt: at(31) }, // rejected, cool-down over: dropped
      { wallet: "0xe-new", lastCheckedAt: at(10) }, // rejected, still cooling down: kept
      { wallet: "0xe-gone", lastCheckedAt: at(40) }, // score already cleaned up: dropped
      { wallet: "0xe-cand", lastCheckedAt: at(31) }, // candidate: kept
      { wallet: "0xe-fol", lastCheckedAt: at(31) }, // followed: kept
      { wallet: "0xe-hid", lastCheckedAt: at(31) }, // hidden: kept
    ]);
    const score = (wallet: string, tier: string) => ({
      wallet,
      tier: tier as "rejected",
      score: 1,
      passed: false,
      nResolved: 0,
      nEvents: 0,
      computedAt: at(10),
    });
    await db
      .insert(traderScores)
      .values([
        score("0xe-old", "rejected"),
        score("0xe-new", "rejected"),
        score("0xe-cand", "candidate"),
        score("0xe-fol", "rejected"),
        score("0xe-hid", "rejected"),
      ]);
    await db.insert(follows).values({ wallet: "0xe-fol", enabled: false });
    await db.insert(hiddenTraders).values({ wallet: "0xe-hid" });
    const state = { logSkill: [0], logNoEdge: 0, events: 1, bets: 1, eventKeys: [1] };
    await db
      .insert(evidenceStates)
      .values(ws.map((wallet) => ({ wallet, holdoutFrom: at(60), state })));
    const cleaned = await cleanupStorage(db);
    const left = (await db.select({ w: evidenceStates.wallet }).from(evidenceStates)).map(
      (r) => r.w,
    );
    expect(left.sort()).toEqual(["0xe-cand", "0xe-fol", "0xe-hid", "0xe-new"]);
    expect(cleaned.evidence).toBe(2);
    await db.delete(evidenceStates);
    await db.delete(traderScores).where(inArray(traderScores.wallet, ws));
    await db.delete(follows).where(inArray(follows.wallet, ws));
    await db.delete(hiddenTraders);
    await db.delete(traders).where(inArray(traders.wallet, ws));
  });

  it("drops Rejected wallets' scores after 30 days, keeping followed and hidden ones (owner, 2026-11-09)", async () => {
    // Only the last 30 days of scores feed the pooled skill test; the cool-down uses
    // traders.last_checked_at; rotation and backtest read non-rejected tiers only.
    const at = (days: number) => new Date(Date.now() - days * 86_400_000);
    const ws = ["0xr31", "0xr29", "0xw31", "0xf31", "0xp31", "0xh31"];
    await db.insert(traders).values(ws.map((wallet) => ({ wallet, lastCheckedAt: at(31) })));
    const score = (wallet: string, tier: string, days: number) => ({
      wallet,
      tier: tier as "rejected",
      score: 1,
      passed: false,
      nResolved: 0,
      nEvents: 0,
      computedAt: at(days),
    });
    await db.insert(traderScores).values([
      score("0xr31", "rejected", 31), // old rejected: dropped
      score("0xr29", "rejected", 29), // still in the pooled window: kept
      score("0xw31", "watchlist", 31), // not rejected: kept
      score("0xf31", "rejected", 31), // followed: kept
      score("0xp31", "rejected", 31), // paused follow: kept
      score("0xh31", "rejected", 31), // hidden (the Hidden list joins scores): kept
    ]);
    await db.insert(follows).values([{ wallet: "0xf31" }, { wallet: "0xp31", enabled: false }]);
    await db.insert(hiddenTraders).values({ wallet: "0xh31" });
    const cleaned = await cleanupStorage(db);
    const left = (await db.select({ w: traderScores.wallet }).from(traderScores)).map((r) => r.w);
    expect(left.sort()).toEqual(["0xf31", "0xh31", "0xp31", "0xr29", "0xw31"]);
    expect(cleaned.scores).toBe(1);
    // The trader row (and its last check, which drives the cool-down) stays.
    expect(await db.select().from(traders).where(eq(traders.wallet, "0xr31"))).toHaveLength(1);
    await db.delete(traderScores).where(inArray(traderScores.wallet, ws));
    await db.delete(follows).where(inArray(follows.wallet, ws));
    await db.delete(hiddenTraders);
    await db.delete(traders).where(inArray(traders.wallet, ws));
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
    noActivity(); // neither board wallet is bot-like
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
      // Both methods were recorded in the same run here (B1: each keeps its own time).
      fromByMethod: { strategy: day.getTime() / 1000, baseline: day.getTime() / 1000 },
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

describe("pick-month rebuild and bot-free baseline (#9)", () => {
  const act = (o: Partial<data.Activity> & { timestamp: number; type: string }): data.Activity => ({
    proxy_wallet: "0x",
    condition_id: "c1",
    size: 1,
    usdc_size: 1,
    transaction_hash: `0xtx${Math.random()}`,
    price: 0.5,
    token_id: null,
    side: null,
    outcome_index: null,
    title: null,
    slug: null,
    icon: null,
    event_slug: null,
    outcome: null,
    name: null,
    pseudonym: null,
    ...o,
  });
  const page = (rows: data.Activity[], more = false) =>
    ({ data: rows, pagination: { has_more: more, next_cursor: more ? "x" : null } }) as never;

  it("skips bot-like wallets on the month board for the baseline and takes the next", async () => {
    await db.delete(monthlySelections);
    await db.delete(leaderboardSnapshots);
    const day = new Date(Date.UTC(2026, 11, 2, 10));
    const now = day.getTime() / 1000;
    await db.insert(leaderboardSnapshots).values(
      ["0xbot", "0xredeemer", "0xhuman"].map((wallet, i) => ({
        capturedAt: day,
        timePeriod: "month",
        category: "overall",
        sortBy: "PNL",
        rank: i + 1,
        wallet,
        pnl: 1000 - i,
      })),
    );
    vi.mocked(data.getActivity).mockImplementation(async ({ user }) => {
      if (user === "0xbot")
        // 250 trades a day (cap reached: 6,000 rows over 24 days)
        return page(
          Array.from({ length: 6000 }, (_, i) =>
            act({ type: "TRADE", timestamp: now - i * 345.6 }),
          ),
          true,
        );
      if (user === "0xredeemer")
        // 30 redeems + 10 trades in a month
        return page(
          Array.from({ length: 40 }, (_, i) =>
            act({ type: i < 30 ? "REDEEM" : "TRADE", timestamp: now - i * 3600 }),
          ),
        );
      return page(
        Array.from({ length: 20 }, (_, i) => act({ type: "TRADE", timestamp: now - i * 86_400 })),
      );
    });
    await recordMonthlySelections(db, 10, () => {}, day, 200);
    const rows = await db
      .select()
      .from(monthlySelections)
      .where(eq(monthlySelections.method, "baseline"));
    expect(rows.map((r) => r.wallet)).toEqual(["0xhuman"]);
  });

  it("rebuilds a finished month's pick from its activity, once, and the backtest reads it", async () => {
    await db.delete(monthlySelections);
    await db.insert(monthlySelections).values({
      month: "2026-10",
      method: "strategy",
      wallet: "0xpick",
      rank: 1,
      recordedAt: new Date(Date.UTC(2026, 9, 1)),
    });
    await db
      .insert(markets)
      .values({ conditionId: "c1", question: "won?", tokenIds: ["t1", "t1no"], payouts: [1, 0] })
      .onConflictDoNothing();
    const oct = (d: number) => Date.UTC(2026, 9, d) / 1000;
    vi.mocked(data.getActivity).mockResolvedValue(
      page([
        act({
          type: "REDEEM",
          condition_id: "c1",
          token_id: "t1",
          size: 100,
          usdc_size: 100,
          timestamp: oct(20),
        }),
        act({ type: "MERGE", condition_id: "c2", size: 10, usdc_size: 10, timestamp: oct(12) }),
        act({
          type: "TRADE",
          side: "BUY",
          condition_id: "c2",
          token_id: "t2",
          size: 10,
          usdc_size: 5,
          timestamp: oct(11),
        }),
        act({
          type: "TRADE",
          side: "BUY",
          condition_id: "c1",
          token_id: "t1",
          size: 100,
          usdc_size: 50,
          timestamp: oct(3),
        }),
      ]),
    );
    const now = new Date(Date.UTC(2026, 10, 5));
    expect(await rebuildRecordedMonths(db, DEFAULT_BACKTEST, () => {}, now)).toEqual({
      rebuilt: 1,
      partial: 0,
    });
    const [row] = await db.select().from(monthlySelections);
    // Only the c1 bet counts (c2 was merged: unknown cost). Leader: $50 → $100 redeemed.
    const allIn = 0.51 + 0.05 * 0.51 * 0.49;
    expect(row).toMatchObject({ bets: 1, staked: 50, partial: false });
    expect(row.pnl!).toBeCloseTo(50 * (2 * (0.5 / allIn) - 1), 6);
    expect(row.coverageStart!.getTime()).toBe(Date.UTC(2026, 9, 1));
    // Rebuilt once: a second run fetches nothing.
    vi.mocked(data.getActivity).mockClear();
    expect(await rebuildRecordedMonths(db, DEFAULT_BACKTEST, () => {}, now)).toEqual({
      rebuilt: 0,
      partial: 0,
    });
    expect(data.getActivity).not.toHaveBeenCalled();
    const picks = await loadRecordedPicks(db, 6, now);
    expect(picks.get("2026-10")?.results?.["strategy:0xpick"]).toMatchObject({
      bets: 1,
      partial: false,
    });
  });
});

describe("interrupted job runs (J11)", () => {
  it("a run killed mid-way stops showing as running once the next one starts", async () => {
    const { runJob } = await import("@/lib/jobs/util");
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
    const [killed] = await db
      .insert(jobRuns)
      .values({ job: "j11", status: "running", startedAt: hoursAgo(4) })
      .returning();
    const [recent] = await db
      .insert(jobRuns)
      .values({ job: "j11", status: "running", startedAt: hoursAgo(1) })
      .returning();
    await runJob(db, "j11", async () => ({}));
    const rows = await db.select().from(jobRuns).where(eq(jobRuns.job, "j11"));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(killed.id)).toMatchObject({ status: "error" });
    expect(byId.get(killed.id)!.error).toMatch(/interrupted/i);
    expect(byId.get(killed.id)!.finishedAt).not.toBeNull();
    expect(byId.get(recent.id)!.status).toBe("running"); // could still be going
    expect(rows.filter((r) => r.status === "ok")).toHaveLength(1);
    await db.delete(jobRuns).where(eq(jobRuns.job, "j11"));
  });
});

describe("the backtest uses the engine's saved filters (owner, 2026-11-10)", () => {
  it("skipInPlay and minLeaderUsd come from Settings, not the defaults", async () => {
    const { backtestJob } = await import("@/lib/jobs/backtest");
    const { backtestRuns } = await import("@/lib/db/schema");
    const { writeSetting } = await import("@/lib/settings");
    const { DEFAULT_RISK_CONFIG } = await import("@/lib/copy/config");
    const { DEFAULT_SCORING_CONFIG } = await import("@/lib/scoring/config");
    await writeSetting(db, "risk", { ...DEFAULT_RISK_CONFIG, skipInPlay: false, minLeaderUsd: 77 });
    noActivity();
    await backtestJob(db, DEFAULT_SCORING_CONFIG, { ...DEFAULT_BACKTEST, months: 1 }, () => {});
    const [run] = await db
      .select()
      .from(backtestRuns)
      .orderBy(sql`id desc`)
      .limit(1);
    expect(run.params).toMatchObject({ skipInPlay: false, minLeaderUsd: 77 });
    await writeSetting(db, "risk", DEFAULT_RISK_CONFIG);
  });
});
