import { eq } from "drizzle-orm";
import type { z } from "zod";

import { RiskConfigSchema, type RiskConfig } from "@/lib/copy/config";
import type { Db } from "@/lib/db/client";
import { appSettings } from "@/lib/db/schema";
import { ScoringConfigSchema, type ScoringConfig } from "@/lib/scoring/config";

/**
 * Validate a stored settings object. Only the fields that fail validation fall back to
 * their defaults; every valid saved value is kept (one bad field must never silently
 * reset the whole group).
 */
export function parseSetting<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const bad = new Set(parsed.error.issues.map((i) => i.path[0]).filter((k) => k !== undefined));
    const kept = Object.fromEntries(Object.entries(raw).filter(([k]) => !bad.has(k)));
    const retry = schema.safeParse(kept);
    if (retry.success) return retry.data;
  }
  return schema.parse({});
}

/** Read a JSON setting and validate it (see parseSetting). */
export async function readSetting<S extends z.ZodType>(
  db: Db,
  key: string,
  schema: S,
): Promise<z.output<S>> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key));
  return parseSetting(schema, row?.value);
}

export async function writeSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

export function getScoringConfig(db: Db): Promise<ScoringConfig> {
  return readSetting(db, "scoring", ScoringConfigSchema);
}

export function getRiskConfig(db: Db): Promise<RiskConfig> {
  return readSetting(db, "risk", RiskConfigSchema);
}
