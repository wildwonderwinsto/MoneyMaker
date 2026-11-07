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

/** Extend a lease, only if `owner` still holds it. */
export async function renewLease(
  db: Db,
  name: string,
  ttlMs: number,
  owner: string,
): Promise<boolean> {
  const key = `lease:${name}`;
  const value = JSON.stringify({ until: Date.now() + ttlMs, owner });
  const rows = await db.execute(sql`
    update app_settings set value = ${value}::jsonb, updated_at = now()
    where key = ${key} and app_settings.value->>'owner' = ${owner}
    returning key
  `);
  return resultRows(rows).length > 0;
}

export interface HeldLease {
  release(): Promise<void>;
}

/**
 * Take a lease for one run and keep renewing it until released, so a slow run (API
 * retries, long Retry-After waits) is never overlapped by the next one; it lapses only if
 * this process dies. Each call has its own owner token, so a run can only ever release its
 * own lease, never one a later run in the same process took after it lapsed.
 */
export async function holdLease(db: Db, name: string, ttlMs: number): Promise<HeldLease | null> {
  const owner = randomUUID();
  if (!(await acquireLease(db, name, ttlMs, owner))) return null;
  const timer = setInterval(() => {
    void renewLease(db, name, ttlMs, owner).catch(() => undefined);
  }, ttlMs / 3);
  timer.unref?.();
  return {
    release: async () => {
      clearInterval(timer);
      await releaseLease(db, name, owner);
    },
  };
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
export function resultRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  return (result as { rows?: unknown[] }).rows ?? [];
}
