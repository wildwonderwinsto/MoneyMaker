import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "@/lib/env";

import { isPgliteUrl, openPglite } from "./pglite";
import * as schema from "./schema";

export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

/** Create a Drizzle client for a connection string (postgres URL or `pglite:<dir|memory>`). */
export function createDb(url: string): { db: Db; close: () => Promise<void> } {
  if (isPgliteUrl(url)) {
    const client = openPglite(url);
    const db = drizzlePglite({ client, schema, casing: "snake_case" });
    return { db: db as unknown as Db, close: () => client.close() };
  }

  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const client = postgres(url, {
    // Safe with both Supabase pooler modes (transaction mode has no prepared statements).
    prepare: false,
    max: 5,
    idle_timeout: 20,
    connect_timeout: 15,
    ssl: isLocal ? false : "require",
  });
  const db = drizzlePostgres({ client, schema, casing: "snake_case" });
  return { db: db as unknown as Db, close: () => client.end({ timeout: 5 }) };
}

// Reuse one client per process (and across Next.js dev hot reloads).
const globalForDb = globalThis as unknown as { __mmDb?: ReturnType<typeof createDb> };

export function getDb(): Db {
  globalForDb.__mmDb ??= createDb(env().DATABASE_URL);
  return globalForDb.__mmDb.db;
}

export async function closeDb(): Promise<void> {
  if (globalForDb.__mmDb) {
    await globalForDb.__mmDb.close();
    globalForDb.__mmDb = undefined;
  }
}

export { schema };
