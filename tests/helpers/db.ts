import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import type { Db } from "@/lib/db/client";
import { migratePgliteClient } from "@/lib/db/migrate";
import * as schema from "@/lib/db/schema";

/** Fresh, fully migrated in-memory Postgres for a test file. */
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  await migratePgliteClient(client);
  const db = drizzle({ client, schema, casing: "snake_case" }) as unknown as Db;
  return { db, close: () => client.close() };
}
