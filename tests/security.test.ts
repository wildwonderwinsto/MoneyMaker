/**
 * Supabase publishes the public schema through its Data API (anon / authenticated roles).
 * Every table must have row level security on, so that API sees nothing, while the app,
 * which connects as the table owner, keeps full access.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/lib/db/client";
import { paperAccounts } from "@/lib/db/schema";

import { createTestDb } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
const rows = async (query: ReturnType<typeof sql>) => {
  const r = (await db.execute(query)) as unknown as { rows: Record<string, unknown>[] };
  return r.rows;
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("row level security", () => {
  it("is on for every table in the public schema", async () => {
    const tables = await rows(sql`
      select tablename, rowsecurity from pg_tables where schemaname = 'public' order by 1`);
    expect(tables.length).toBeGreaterThan(10);
    expect(tables.filter((t) => !t.rowsecurity).map((t) => t.tablename)).toEqual([]);
  });

  it("hides every row from an API-style role, but not from the app (the owner)", async () => {
    await db.insert(paperAccounts).values({ name: "Paper", startingBalance: 1000, cash: 1000 });
    // Stand-in for Supabase's anon role: may query the table, owns nothing.
    await db.execute(sql`create role api_anon nologin`);
    await db.execute(sql`grant usage on schema public to api_anon`);
    await db.execute(sql`grant select on paper_accounts to api_anon`);

    await db.execute(sql`set role api_anon`);
    const seenByApi = await rows(sql`select * from paper_accounts`);
    await db.execute(sql`reset role`);

    expect(seenByApi).toHaveLength(0);
    expect(await db.select().from(paperAccounts)).toHaveLength(1);
  });
});
