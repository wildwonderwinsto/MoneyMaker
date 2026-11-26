import "server-only";

import { sql, type SQL } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import { resultRows } from "@/lib/lease";

/**
 * Per-process memory of page query results, to save database egress (Supabase free plan:
 * 5 GB/month). The Paper and Live pages re-render every ~30 s while open and used to pull the
 * same thousands of rows every time; now each render asks the database for a tiny change key
 * first and reuses the last result while the key is unchanged.
 *
 * Read-only and display-only: the copy engine never goes through here.
 *
 * Safe under races: the key is read BEFORE the data, so stored data is never older than its
 * key; a change landing in between only causes one extra reload on the next render.
 * Callers must not mutate a returned value (it is shared between renders).
 */
const store = new Map<string, unknown>();

/** A named slot in the same memory, for callers with their own reuse rule. */
export function memoSlot<T>(name: string) {
  return {
    get: () => store.get(name) as T | undefined,
    set: (value: T) => void store.set(name, value),
  };
}

export async function reuseUnlessChanged<T>(
  name: string,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const hit = store.get(name) as { key: string; value: T } | undefined;
  if (hit && hit.key === key) return hit.value;
  const value = await load();
  store.set(name, { key, value });
  return value;
}

/**
 * md5 of rows, computed in the database: the change key costs 32 bytes of egress however
 * many rows it covers. `rows` is a full SELECT; `order` orders its rows inside the hash.
 */
export async function hashRows(db: Db, rows: SQL, order: SQL): Promise<string> {
  const res = await db.execute(
    sql`select md5(coalesce(string_agg(t::text, ',' order by ${order}), '')) as h from (${rows}) t`,
  );
  const [row] = resultRows(res) as Array<{ h: string }>;
  return row?.h ?? "";
}

/** Test hook: forget everything. */
export function clearPageCache() {
  store.clear();
}
