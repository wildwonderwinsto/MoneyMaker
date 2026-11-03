import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/lib/db/client";
import { paperAccounts, paperPositions, traders } from "@/lib/db/schema";

import { createTestDb } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("schema", () => {
  it("round-trips numeric money columns as numbers", async () => {
    const [acct] = await db
      .insert(paperAccounts)
      .values({ name: "test", startingBalance: 1000, cash: 1000.123456 })
      .returning();
    expect(acct.cash).toBe(1000.123456);
    expect(typeof acct.startingBalance).toBe("number");
  });

  it("allows only one open position per (account, token, leader) but many closed ones", async () => {
    const [acct] = await db
      .insert(paperAccounts)
      .values({ name: "uniq", startingBalance: 100, cash: 100 })
      .returning();
    const base = { accountId: acct.id, sourceWallet: "0xabc", conditionId: "c1", tokenId: "t1" };
    await db.insert(paperPositions).values({ ...base, status: "closed" });
    await db.insert(paperPositions).values({ ...base, status: "closed" });
    await db.insert(paperPositions).values({ ...base, status: "open" });
    await expect(db.insert(paperPositions).values({ ...base, status: "open" })).rejects.toThrow();
    const open = await db
      .select()
      .from(paperPositions)
      .where(and(eq(paperPositions.accountId, acct.id), eq(paperPositions.status, "open")));
    expect(open).toHaveLength(1);
  });

  it("maps camelCase fields to snake_case columns", async () => {
    await db.insert(traders).values({ wallet: "0x1", profileImage: "img", xUsername: "x" });
    const [row] = await db.select().from(traders).where(eq(traders.wallet, "0x1"));
    expect(row.profileImage).toBe("img");
    expect(row.verifiedBadge).toBe(false);
  });
});
