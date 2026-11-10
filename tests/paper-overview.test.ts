/**
 * Paper dashboard numbers (batch 6): totals must not depend on how many rows a list shows.
 * UI-04 per-trader P&L past 1,000 positions, UI-05 equity-chart markers past 2,000 fills,
 * UI-06 win rate counting hedges.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDefaultAccount } from "@/lib/copy/account";
import type { Db } from "@/lib/db/client";
import { paperFills, paperPositions } from "@/lib/db/schema";
import { getPaperOverview } from "@/lib/queries";

import { createTestDb } from "./helpers/db";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let db: Db;
let accountId: number;
beforeEach(async () => {
  ({ db } = await createTestDb());
  accountId = (await ensureDefaultAccount(db)).id;
});

const DAY = 86_400_000;
const closed = (wallet: string, i: number, pnl: number, kind: "copy" | "hedge" = "copy") => ({
  accountId,
  sourceWallet: wallet,
  conditionId: `c${wallet}${i}`,
  tokenId: `t${wallet}${i}`,
  shares: 0,
  avgPrice: 0.5,
  costBasis: 0,
  realizedPnl: pnl,
  status: "closed" as const,
  kind,
  openedAt: new Date(Date.now() - (2000 - i) * 60_000),
  closedAt: new Date(Date.now() - (2000 - i) * 60_000 + 1000),
});

describe("per-trader results (UI-04)", () => {
  it("counts every position, not just the newest 1,000", async () => {
    // 1,005 closed copies from A (older), then one from B (newest).
    await db
      .insert(paperPositions)
      .values(Array.from({ length: 1005 }, (_, i) => closed("a", i, 1)));
    await db.insert(paperPositions).values(closed("b", 1999, 2));
    const p = await getPaperOverview();
    const a = p.byTrader.find((t) => t.wallet === "a")!;
    expect(a.realized).toBe(1005);
    expect(a.total).toBe(1005);
    expect(a.wins).toBe(1005);
    expect(a.losses).toBe(0);
    expect(p.realized).toBe(1007);
  });
});

describe("equity chart markers (UI-05)", () => {
  it("keeps the newest fills when there are more than 2,000", async () => {
    const [pos] = await db
      .insert(paperPositions)
      .values(closed("a", 0, 0))
      .returning({ id: paperPositions.id });
    const fills = Array.from({ length: 2005 }, (_, i) => ({
      accountId,
      positionId: pos.id,
      kind: "trade" as const,
      side: "BUY",
      shares: 1,
      avgPrice: 0.5,
      notional: 0.5,
      ts: new Date(Date.now() - 30 * DAY + i * 60_000),
    }));
    await db.insert(paperFills).values(fills);
    const p = await getPaperOverview();
    expect(p.markers).toHaveLength(2000);
    const times = p.markers.map((m) => m.ts.getTime());
    expect(times.at(-1)).toBe(fills.at(-1)!.ts.getTime()); // the newest fill is shown
    expect([...times].sort((x, y) => x - y)).toEqual(times); // still oldest → newest
  });
});

describe("win rate (UI-06)", () => {
  it("counts finished copies only, not hedges", async () => {
    await db.insert(paperPositions).values([
      closed("a", 1, -10), // copy lost
      closed("a", 2, 4, "hedge"), // its hedge made money
    ]);
    const p = await getPaperOverview();
    expect(p.winRate).toBe(0);
    expect(p.finishedCount).toBe(1);
  });
});
