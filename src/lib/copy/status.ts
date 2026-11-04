/** Copy-engine status shared with the dashboard (stored in app_settings "engine:status"). */
import { eq, sql } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import { appSettings } from "@/lib/db/schema";

import type { StreamStatus } from "./stream";

export interface EngineStatus {
  /** ISO time the last tick finished. */
  lastTickAt?: string | null;
  lastTickMs?: number | null;
  /** ISO time the in-process loop will run the next tick (null when no loop runs). */
  nextTickAt?: string | null;
  intervalSeconds?: number | null;
  /** ISO time a real-time batch was last processed. */
  lastStreamBatchAt?: string | null;
  stream?: (StreamStatus & { enabled: boolean }) | null;
  /** ISO heartbeat of the in-process loop. */
  loopAliveAt?: string | null;
}

const KEY = "engine:status";

/** Merge `patch` into the stored status (one upsert, jsonb concatenation). */
export async function writeEngineStatus(db: Db, patch: EngineStatus): Promise<void> {
  const value = JSON.stringify(patch);
  await db.execute(sql`
    insert into app_settings (key, value, updated_at)
    values (${KEY}, ${value}::jsonb, now())
    on conflict (key) do update
      set value = app_settings.value || excluded.value, updated_at = now()
  `);
}

export async function readEngineStatus(db: Db): Promise<EngineStatus> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, KEY));
  return (row?.value as EngineStatus | undefined) ?? {};
}
