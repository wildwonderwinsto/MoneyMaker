import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Db } from "@/lib/db/client";
import { markets, traderPnlDaily, traderPositions, traders, traderTrades } from "@/lib/db/schema";
import { backfillTrader, cleanupStorage, prunePositions } from "@/lib/jobs/backfill";
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
});

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

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
});
