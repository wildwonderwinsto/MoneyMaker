/**
 * Settings → Storage → Start over (owner, 2026-11-10: "delete everything to start anew",
 * keeping settings). Every data table is emptied; settings, the engine's lease and status
 * (all in app_settings) stay; the paper account goes back to its starting balance.
 */
import { getTableName, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDefaultAccount } from "@/lib/copy/account";
import { DEFAULT_RISK_CONFIG } from "@/lib/copy/config";
import type { Db } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { getRiskConfig, writeSetting } from "@/lib/settings";
import { KEPT_TABLES, START_OVER_CONFIRM, startOver, WIPED_TABLES } from "@/lib/start-over";

import { createTestDb } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());

const count = async (table: string) =>
  Number(
    (
      (await db.execute(sql.raw(`select count(*)::int as n from ${table}`))) as unknown as {
        rows: Array<{ n: number }>;
      }
    ).rows[0].n,
  );

describe("start over", () => {
  it("every table is either wiped or deliberately kept (a new table must choose)", () => {
    const all: string[] = [];
    for (const v of Object.values(schema) as unknown[]) {
      if (v instanceof PgTable) all.push(getTableName(v));
    }
    all.sort();
    expect([...WIPED_TABLES, ...KEPT_TABLES].sort()).toEqual(all);
    expect(KEPT_TABLES).toEqual(["app_settings", "paper_accounts"]);
  });

  it("empties the data, keeps settings, resets the paper account", async () => {
    await writeSetting(db, "risk", { ...DEFAULT_RISK_CONFIG, minLeaderUsd: 77 });
    const account = await ensureDefaultAccount(db);
    await db
      .update(schema.paperAccounts)
      .set({ cash: 12.5, startingBalance: 2500 })
      .where(sql`id = ${account.id}`);
    await db.insert(schema.traders).values({ wallet: "0xa" });
    await db.insert(schema.follows).values({ wallet: "0xa" });
    await db.insert(schema.hiddenTraders).values({ wallet: "0xb" });
    await db.insert(schema.traderScores).values({
      wallet: "0xa",
      tier: "elite",
      score: 80,
      passed: true,
      nResolved: 1,
      nEvents: 1,
    });
    await db.insert(schema.monthlySelections).values({
      month: "2026-11",
      method: "strategy",
      wallet: "0xa",
      rank: 1,
    });
    const [pos] = await db
      .insert(schema.paperPositions)
      .values({
        accountId: account.id,
        sourceWallet: "0xa",
        conditionId: "c",
        tokenId: "t",
        shares: 10,
        avgPrice: 0.5,
        costBasis: 5,
      })
      .returning();
    await db.insert(schema.paperFills).values({
      accountId: account.id,
      positionId: pos.id,
      kind: "trade",
      side: "BUY",
      shares: 10,
      avgPrice: 0.5,
      notional: 5,
    });
    await db.insert(schema.jobRuns).values({ job: "daily", status: "ok" });

    const r = await startOver(db, START_OVER_CONFIRM);
    expect(r.ok).toBe(true);
    for (const t of WIPED_TABLES) expect(await count(t), t).toBe(0);
    // Settings stay.
    expect((await getRiskConfig(db)).minLeaderUsd).toBe(77);
    // The paper account is back to its starting balance, with a fresh start date.
    const [acc] = await db.select().from(schema.paperAccounts);
    expect(acc.cash).toBe(2500);
    expect(acc.startingBalance).toBe(2500);
    expect(acc.resetAt).not.toBeNull();
  });

  it("refuses without the exact confirmation, and while a daily job is running", async () => {
    await db.insert(schema.traders).values({ wallet: "0xa" });
    expect((await startOver(db, "delete")).ok).toBe(false);
    expect(await count("traders")).toBe(1);

    await db.insert(schema.jobRuns).values({ job: "daily", status: "running" });
    const busy = await startOver(db, START_OVER_CONFIRM);
    expect(busy.ok).toBe(false);
    expect(busy.message).toMatch(/running/);
    expect(await count("traders")).toBe(1);
  });

  it("a job marked running for over 3 hours (killed) doesn't block it", async () => {
    await db.insert(schema.jobRuns).values({
      job: "daily",
      status: "running",
      startedAt: new Date(Date.now() - 4 * 3_600_000),
    });
    expect((await startOver(db, START_OVER_CONFIRM)).ok).toBe(true);
  });
});

describe("Start over panel", () => {
  it("asks for the same phrase the server checks", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/components/start-over.tsx", "utf8");
    expect(src).toContain(`const CONFIRM = "${START_OVER_CONFIRM}";`);
  });
});
