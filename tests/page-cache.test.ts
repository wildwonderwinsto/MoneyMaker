/**
 * Egress savings on the Paper and Live pages: results are reused between renders, but a page
 * must never show stale money or trades. Every change the engine makes has to show up on the
 * next render: a price mark, a fill, a closed position, a new equity snapshot, a reset, a
 * signal re-decided on retry.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDefaultAccount } from "@/lib/copy/account";
import type { Db } from "@/lib/db/client";
import { equitySnapshots, paperFills, paperPositions, signals } from "@/lib/db/schema";
import { clearPageCache } from "@/lib/page-cache";
import { getLast24hSummary, getPaperOverview, getSignals } from "@/lib/queries";

import { createTestDb } from "./helpers/db";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let db: Db;
let accountId: number;
beforeEach(async () => {
  clearPageCache();
  ({ db } = await createTestDb());
  accountId = (await ensureDefaultAccount(db)).id;
});

const MIN = 60_000;

async function openPosition() {
  const [pos] = await db
    .insert(paperPositions)
    .values({
      accountId,
      sourceWallet: "a",
      conditionId: "c1",
      tokenId: "t1",
      shares: 10,
      avgPrice: 0.5,
      costBasis: 5,
      currentPrice: 0.5,
    })
    .returning({ id: paperPositions.id });
  await db.insert(paperFills).values({
    accountId,
    positionId: pos.id,
    kind: "trade",
    side: "BUY",
    shares: 10,
    avgPrice: 0.5,
    notional: 5,
    ts: new Date(Date.now() - 10 * MIN),
  });
  return pos.id;
}

describe("Paper page", () => {
  it("shows a new price mark on the next render", async () => {
    const id = await openPosition();
    const before = await getPaperOverview();
    expect(before.byTrader[0].positions[0].currentPrice).toBe(0.5);

    await db.update(paperPositions).set({ currentPrice: 0.8 }).where(eq(paperPositions.id, id));
    const after = await getPaperOverview();
    expect(after.open[0].currentPrice).toBe(0.8);
    expect(after.byTrader[0].positions[0].currentPrice).toBe(0.8);
    expect(after.byTrader[0].positions[0].pnl).toBeCloseTo(3);
    expect(after.equity).toBeGreaterThan(before.equity);
  });

  it("shows a sell (new fill + closed position) on the next render", async () => {
    const id = await openPosition();
    await getPaperOverview();

    await db
      .update(paperPositions)
      .set({ status: "closed", shares: 0, realizedPnl: 2, closedAt: new Date() })
      .where(eq(paperPositions.id, id));
    await db.insert(paperFills).values({
      accountId,
      positionId: id,
      kind: "trade",
      side: "SELL",
      shares: 10,
      avgPrice: 0.7,
      notional: 7,
      realizedPnl: 2,
      ts: new Date(),
    });
    const p = await getPaperOverview();
    expect(p.open).toHaveLength(0);
    expect(p.closed.map((c) => c.id)).toEqual([id]);
    expect(p.markers.map((m) => m.side)).toEqual(["BUY", "SELL"]);
    expect(p.realized).toBe(2);
  });

  it("adds new equity snapshots, and starts over after a reset", async () => {
    const at = (m: number) => new Date(Date.now() - m * MIN);
    const snap = (m: number, equity: number) => ({
      accountId,
      ts: at(m),
      equity,
      cash: equity,
      positionsValue: 0,
    });
    await db.insert(equitySnapshots).values([snap(20, 100), snap(15, 101)]);
    expect((await getPaperOverview()).equityCurve.map((e) => e.equity)).toEqual([100, 101]);

    await db.insert(equitySnapshots).values(snap(10, 102));
    expect((await getPaperOverview()).equityCurve.map((e) => e.equity)).toEqual([100, 101, 102]);

    // Reset: history wiped, one fresh snapshot.
    await db.delete(equitySnapshots).where(eq(equitySnapshots.accountId, accountId));
    await db.insert(equitySnapshots).values(snap(1, 500));
    expect((await getPaperOverview()).equityCurve.map((e) => e.equity)).toEqual([500]);
  });
});

describe("Live page", () => {
  const signal = (id: string, minutesAgo: number) => ({
    id,
    wallet: "a",
    detectedAt: new Date(Date.now() - minutesAgo * MIN),
    leaderTs: new Date(Date.now() - minutesAgo * MIN),
    conditionId: "c1",
    tokenId: "t1",
    side: "BUY",
    leaderPrice: 0.5,
    leaderSize: 10,
    leaderUsdc: 5,
    decision: "skipped" as const,
    reason: "price moved",
  });

  it("shows new signals and re-decided ones on the next render", async () => {
    await db.insert(signals).values(signal("s1", 5));
    expect((await getSignals(200)).map((r) => r.signal.decision)).toEqual(["skipped"]);
    expect((await getLast24hSummary()).total).toBe(1);

    // A retry copies it: same row, new decision.
    await db
      .update(signals)
      .set({ decision: "copied", reason: "copied on retry", retries: 1 })
      .where(eq(signals.id, "s1"));
    const rows = await getSignals(200);
    expect(rows.map((r) => [r.signal.id, r.signal.decision])).toEqual([["s1", "copied"]]);

    await db.insert(signals).values(signal("s2", 1));
    expect((await getSignals(200)).map((r) => r.signal.id)).toEqual(["s2", "s1"]);
  });

  it("the 24-hour summary follows changes too", async () => {
    await db.insert(signals).values(signal("s1", 5));
    const before = await getLast24hSummary();
    await db.insert(signals).values({ ...signal("s2", 2), tokenId: "t2", conditionId: "c2" });
    const after = await getLast24hSummary();
    expect([before.total, after.total]).toEqual([1, 2]);
  });
});

describe("raw SQL parameters", () => {
  // PGlite (tests) accepts a Date parameter in raw sql``; postgres-js with prepare: false
  // (production) throws "The string argument must be of type string ... Received Date".
  it("never passes a Date to db.execute", async () => {
    const execute = vi.spyOn(db, "execute");
    await openPosition();
    await getPaperOverview();
    await getSignals(200);
    await getLast24hSummary();
    expect(execute).toHaveBeenCalled();
    const dialect = (
      db as unknown as { dialect: { sqlToQuery: (q: unknown) => { params: unknown[] } } }
    ).dialect;
    for (const [query] of execute.mock.calls) {
      const { params } = dialect.sqlToQuery(query);
      expect(params.filter((p) => p instanceof Date)).toEqual([]);
    }
  });
});
