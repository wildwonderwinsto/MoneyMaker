import path from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { isPgliteUrl, openPglite } from "./pglite";

export const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

/** Apply all pending SQL migrations in ./drizzle to the given database URL. */
export async function runMigrations(url: string): Promise<void> {
  if (isPgliteUrl(url)) {
    const client = openPglite(url);
    try {
      await migratePglite(drizzlePglite({ client }), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await client.close();
    }
    return;
  }

  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  // Single connection; migrations must not run through a pipelining pool.
  const client = postgres(url, { max: 1, prepare: false, ssl: isLocal ? false : "require" });
  try {
    await migratePostgres(drizzlePostgres({ client }), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await client.end({ timeout: 5 });
  }
}

/** Migrate an already-open PGlite instance (used by tests with in-memory databases). */
export async function migratePgliteClient(client: PGlite): Promise<void> {
  await migratePglite(drizzlePglite({ client }), { migrationsFolder: MIGRATIONS_FOLDER });
}
