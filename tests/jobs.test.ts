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
    expect(cleaned).toEqual({ markets: 1, trades: 1 });
    const left = await db.select({ id: markets.conditionId }).from(markets);
    expect(left.map((m) => m.id)).toEqual(["c-keep"]);
  });
});
