import { sql } from "drizzle-orm";

import type { Db } from "@/lib/db/client";

/**
 * Cross-process mutual exclusion stored in app_settings. Works through connection
 * poolers (unlike session advisory locks). Expired leases are taken over automatically,
 * so a crashed run can't block future ticks for longer than `ttlMs`.
 */
export async function acquireLease(db: Db, name: string, ttlMs: number): Promise<boolean> {
  const now = Date.now();
  const key = `lease:${name}`;
  const value = JSON.stringify({ until: now + ttlMs });
  const rows = await db.execute(sql`
    insert into app_settings (key, value, updated_at)
    values (${key}, ${value}::jsonb, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()
    where (app_settings.value->>'until')::bigint < ${now}
    returning key
  `);
  return resultRows(rows).length > 0;
}

export async function releaseLease(db: Db, name: string): Promise<void> {
  await db.execute(sql`
    update app_settings set value = '{"until":0}'::jsonb, updated_at = now()
    where key = ${`lease:${name}`}
  `);
}

/** Rows from a raw `execute` result (postgres-js returns an array, PGlite `{ rows }`). */
function resultRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  return (result as { rows?: unknown[] }).rows ?? [];
}
