import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import type { Db } from "@/lib/db/client";

/** Identifies this process as a lease owner. */
export const PROCESS_ID: string = randomUUID();

/**
 * Cross-process mutual exclusion stored in app_settings. Works through connection
 * poolers (unlike session advisory locks). Expired leases are taken over automatically,
 * so a crashed run can't block future ticks for longer than `ttlMs`. Each lease records
 * its owner, so a process can release its own lease on shutdown (and only its own).
 */
export async function acquireLease(
  db: Db,
  name: string,
  ttlMs: number,
  owner = PROCESS_ID,
): Promise<boolean> {
  const now = Date.now();
  const key = `lease:${name}`;
  const value = JSON.stringify({ until: now + ttlMs, owner });
  const rows = await db.execute(sql`
    insert into app_settings (key, value, updated_at)
    values (${key}, ${value}::jsonb, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()
    where (app_settings.value->>'until')::bigint < ${now}
    returning key
  `);
  return resultRows(rows).length > 0;
}

/** Release a lease. With `owner`, only if that owner still holds it. */
export async function releaseLease(db: Db, name: string, owner?: string): Promise<void> {
  const key = `lease:${name}`;
  if (owner) {
    await db.execute(sql`
      update app_settings set value = '{"until":0}'::jsonb, updated_at = now()
      where key = ${key} and app_settings.value->>'owner' = ${owner}
    `);
    return;
  }
  await db.execute(sql`
    update app_settings set value = '{"until":0}'::jsonb, updated_at = now()
    where key = ${key}
  `);
}

/** Rows from a raw `execute` result (postgres-js returns an array, PGlite `{ rows }`). */
function resultRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  return (result as { rows?: unknown[] }).rows ?? [];
}
