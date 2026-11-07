import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import type { Db } from "@/lib/db/client";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

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

export class LeaseLostError extends Error {}

export interface HeldLease {
  release(): Promise<void>;
  /**
   * `db` for this run's writes. Writes are refused once the lease might lapse (no renewal
   * confirmed for `ttl − ttl/3`), and each write transaction first checks, inside the
   * transaction, that this run still holds it and locks the lease row, so no other run can
   * take over until that transaction ends. Two runs therefore never write at once.
   */
  guard(db: Db): Db;
}

/**
 * Take a lease for one run and keep renewing it until released, so a slow run (API
 * retries, long Retry-After waits) is never overlapped by the next one; it lapses only if
 * this process dies or can't renew, and then `guard` stops the run's writes first. Each call
 * has its own owner token, so a run can only ever release its own lease, never one a later
 * run in the same process took after it lapsed.
 */
export async function holdLease(db: Db, name: string, ttlMs: number): Promise<HeldLease | null> {
  const owner = randomUUID();
  const key = `lease:${name}`;
  const started = Date.now();
  if (!(await acquireLease(db, name, ttlMs, owner))) return null;
  /** The lease is ours at least until then (from just before the last confirmed write). */
  let confirmedUntil = started + ttlMs;
  const timer = setInterval(() => {
    const t = Date.now();
    void renewLease(db, name, ttlMs, owner)
      .then((ok) => {
        if (ok) confirmedUntil = t + ttlMs;
      })
      .catch(() => undefined);
  }, ttlMs / 4);
  timer.unref?.();
  const check = () => {
    if (Date.now() >= confirmedUntil - ttlMs / 3) {
      throw new LeaseLostError(`The ${name} lease could not be renewed; stopped writing`);
    }
  };
  type Fn = (...args: unknown[]) => unknown;
  return {
    release: async () => {
      clearInterval(timer);
      await releaseLease(db, name, owner);
    },
    guard: (target) =>
      new Proxy(target, {
        get(obj, prop) {
          const value = Reflect.get(obj, prop, obj) as unknown;
          if (prop === "transaction") {
            return (fn: (tx: Tx) => Promise<unknown>, config?: unknown) => {
              check();
              return obj.transaction(async (tx) => {
                const rows = await tx.execute(sql`
                  select 1 from app_settings
                  where key = ${key} and value->>'owner' = ${owner}
                    and (value->>'until')::bigint > ${Date.now()}
                  for share
                `);
                if (resultRows(rows).length === 0) {
                  throw new LeaseLostError(`Lost the ${name} lease; stopped writing`);
                }
                return fn(tx);
              }, config as never);
            };
          }
          if (prop === "insert" || prop === "update" || prop === "delete" || prop === "execute") {
            return (...args: unknown[]) => {
              check();
              return (value as Fn).apply(obj, args);
            };
          }
          return typeof value === "function" ? (value as Fn).bind(obj) : value;
        },
      }),
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
