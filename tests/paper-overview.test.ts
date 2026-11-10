/**
 * Paper dashboard numbers (batch 6): totals must not depend on how many rows a list shows.
 * UI-04 per-trader P&L past 1,000 positions, UI-05 equity-chart markers past 2,000 fills,
 * UI-06 win rate counting hedges.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDefaultAccount } from "@/lib/copy/account";
import type { Db } from "@/lib/db/client";
import { paperAccounts, paperFills, paperPositions } from "@/lib/db/schema";
import { runTick } from "@/lib/copy/tick";
import { eq, sql } from "drizzle-orm";
import { getLiveVersion, getPaperOverview } from "@/lib/queries";

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

describe("Live page fingerprint (UI-08)", () => {
  it("changes when a cron-only tick runs, a fill lands or a price is marked", async () => {
    const v0 = await getLiveVersion();
    // ENGINE_LOOP=off: cron calls runTick directly; the runner's status is never written.
    await runTick(db, Date.now(), { copy: false });
    const v1 = await getLiveVersion();
    expect(v1).not.toBe(v0);

    const [pos] = await db
      .insert(paperPositions)
      .values({ ...closed("a", 0, 0), status: "open", shares: 10, costBasis: 5 })
      .returning({ id: paperPositions.id });
    const v2 = await getLiveVersion();
    expect(v2).not.toBe(v1);

    await new Promise((r) => setTimeout(r, 5));
    await db
      .update(paperPositions)
      .set({ currentPrice: 0.7, updatedAt: new Date() })
      .where(eq(paperPositions.id, pos.id));
    const v3 = await getLiveVersion();
    expect(v3).not.toBe(v2);

    await db.insert(paperFills).values({
      accountId,
      positionId: pos.id,
      kind: "settlement",
      side: "SETTLE",
      shares: 10,
      avgPrice: 1,
      notional: 10,
      realizedPnl: 5,
      ts: new Date(Date.now() + 1000),
    });
    expect(await getLiveVersion()).not.toBe(v3);
  });
});

describe("Live page 'Last 24 hours' (UI-15)", () => {
  it("counts every signal of the last 24 hours, not just the newest 200", async () => {
    const { signals } = await import("@/lib/db/schema");
    const { getLast24hSummary } = await import("@/lib/queries");
    const now = Date.now();
    await db.insert(signals).values(
      Array.from({ length: 250 }, (_, i) => ({
        id: `s${i}`,
        wallet: `0xw${i}`, // different traders: nothing groups together
        leaderTs: new Date(now - 60_000 - i * 60_000),
        conditionId: "c",
        tokenId: "t",
        side: "BUY",
        leaderPrice: 0.5,
        leaderSize: 10,
        leaderUsdc: 5,
        decision: "skipped" as const,
        reason: "Leader trade too small ($5.00)",
        reasonCode: "leader_too_small" as const,
        source: "poll" as const,
        accountId,
      })),
    );
    const s = await getLast24hSummary(now);
    expect(s.total).toBe(250);
    expect(s.skipped).toBe(250);
    expect(s.topSkipReasons[0]).toMatchObject({ n: 250 });
  });
});

describe("Settings diagnostics for visitors (batch 6 step 4)", () => {
  it("visitors get job name, status and time only, and no storage; admins get everything", async () => {
    const { jobRuns } = await import("@/lib/db/schema");
    const { getSettingsDiagnostics } = await import("@/lib/queries");
    await db.insert(jobRuns).values({
      job: "daily",
      status: "error",
      error: "Error: connect ECONNREFUSED db.internal:5432\n    at secret.ts:1",
      stats: { backfills: 3 },
    });
    const visitor = await getSettingsDiagnostics(false);
    expect(visitor.storage).toBeNull();
    expect(visitor.runs).toHaveLength(1);
    expect(Object.keys(visitor.runs[0]).sort()).toEqual(
      ["finishedAt", "id", "job", "startedAt", "status"].sort(),
    );
    const admin = await getSettingsDiagnostics(true);
    expect((admin.runs[0] as { error?: string }).error).toContain("ECONNREFUSED");
    expect(admin.storage?.tables.length).toBeGreaterThan(0);
  });
});

describe("daily loss limit before the day's first snapshot (C-F19)", () => {
  it("measures today's loss from yesterday's last equity until today has a snapshot", async () => {
    const { equitySnapshots } = await import("@/lib/db/schema");
    const { dailyLossPct } = await import("@/lib/copy/account");
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    await db.insert(equitySnapshots).values([
      {
        accountId,
        ts: new Date(midnight.getTime() - 3 * 3_600_000),
        equity: 1200,
        cash: 1200,
        positionsValue: 0,
      },
      {
        accountId,
        ts: new Date(midnight.getTime() - 5 * 60_000),
        equity: 1000,
        cash: 1000,
        positionsValue: 0,
      },
    ]);
    // Down to $850 before any snapshot today: a 15% loss, not "no loss yet".
    expect(await dailyLossPct(db, accountId, 850)).toBeCloseTo(0.15, 9);
    // Once today has a snapshot, it is the start of the day as before.
    await db
      .insert(equitySnapshots)
      .values({ accountId, ts: new Date(), equity: 900, cash: 900, positionsValue: 0 });
    expect(await dailyLossPct(db, accountId, 850)).toBeCloseTo(50 / 900, 9);
  });
});

describe("each fill stores its fee (C-F21)", () => {
  it("buy, capped sell and settlement record the fee inside their notional", async () => {
    const { applyBuy, applySell, settlePosition } = await import("@/lib/copy/account");
    const { simulateBuy, simulateSell } = await import("@/lib/copy/fillSim");
    const m = {
      conditionId: "cf",
      question: "q",
      slug: null,
      image: null,
      endDate: null,
      closed: false,
      tokenIds: ["Y", "N"],
      outcomes: ["Yes", "No"],
      winnerIndex: null,
      takerFeeRate: 0.05,
    };
    const tr = (id: string, side: "BUY" | "SELL") =>
      ({
        id,
        wallet: "0xl",
        ts: 1,
        conditionId: "cf",
        tokenId: "Y",
        side,
        price: 0.5,
        size: 1,
        usdc: 1,
      }) as never;
    // $51.25 at 50¢ with a 5% rate: 100 shares, fee 100·0.05·0.25 = 1.25.
    const b = simulateBuy([{ price: 0.5, size: 1000 }], 51.25, 0.6, 0, 0.05);
    await db.transaction((tx) => applyBuy(tx, accountId, tr("fb", "BUY"), m, b));
    // Sell 150 (only 100 held): fee 150·0.05·0.24 = 1.8, of which 100/150 is ours = 1.2.
    const [pos] = await db
      .select()
      .from(paperPositions)
      .where(eq(paperPositions.conditionId, "cf"));
    const sl = simulateSell([{ price: 0.6, size: 1000 }], 150, 0, 0, 0.05);
    await db.transaction((tx) => applySell(tx, pos, tr("fs", "SELL"), sl));
    const fills = await db.select().from(paperFills).where(eq(paperFills.positionId, pos.id));
    expect(fills.find((f) => f.side === "BUY")!.fee).toBeCloseTo(1.25, 6);
    expect(fills.find((f) => f.side === "SELL")!.fee).toBeCloseTo(1.2, 6);
    // A settlement pays no fee.
    const [p2] = await db
      .insert(paperPositions)
      .values({
        accountId,
        sourceWallet: "0xl",
        conditionId: "cf2",
        tokenId: "Y2",
        shares: 10,
        avgPrice: 0.5,
        costBasis: 5,
      })
      .returning();
    await db.update(paperAccounts).set({ cash: sql`${paperAccounts.cash} - 5` });
    await db.transaction((tx) => settlePosition(tx, p2, 1));
    const [settle] = await db.select().from(paperFills).where(eq(paperFills.positionId, p2.id));
    expect(settle.fee).toBe(0);
  });
});
