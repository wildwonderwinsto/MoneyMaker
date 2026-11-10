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
    // A cross-field rule can still fail with its named field at the default (min above a
    // saved max): add saved values one by one, keeping each that is valid with those kept
    // so far, instead of resetting the whole group (audit N3).
    const ok: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (schema.safeParse({ ...ok, [k]: v }).success) ok[k] = v;
    }
    return schema.parse(ok);
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

/** Thrown when settings changed after the editing page loaded them. */
export class StaleSettingsError extends Error {
  constructor() {
    super(
      "These settings were changed (in another tab or by another admin) since this page loaded. Reload the page to see the current values, then make your change again.",
    );
  }
}

/**
 * Save a settings group only if what's stored still equals `base`, the values the editing
 * page loaded. A tab left open with old values would otherwise send all of them back and
 * silently undo newer changes. The row is locked so two saves can't both pass the check.
 */
export async function writeSettingIfUnchanged<S extends z.ZodType>(
  db: Db,
  key: string,
  schema: S,
  base: unknown,
  value: z.output<S>,
): Promise<void> {
  await db.transaction(async (tx) => {
    // A missing row reads as the defaults, the same as `{}`.
    await tx.insert(appSettings).values({ key, value: {} }).onConflictDoNothing();
    const [row] = await tx.select().from(appSettings).where(eq(appSettings.key, key)).for("update");
    const current = parseSetting(schema, row?.value) as Record<string, unknown>;
    const loaded = (base && typeof base === "object" ? base : null) as Record<
      string,
      unknown
    > | null;
    const same =
      loaded !== null &&
      Object.keys(current).every((k) => JSON.stringify(current[k]) === JSON.stringify(loaded[k]));
    if (!same) throw new StaleSettingsError();
    await tx
      .update(appSettings)
      .set({ value, updatedAt: new Date() })
      .where(eq(appSettings.key, key));
  });
}

export function getScoringConfig(db: Db): Promise<ScoringConfig> {
  return readSetting(db, "scoring", ScoringConfigSchema);
}

export function getRiskConfig(db: Db): Promise<RiskConfig> {
  return readSetting(db, "risk", RiskConfigSchema);
}
