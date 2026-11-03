import { eq } from "drizzle-orm";
import type { z } from "zod";

import type { Db } from "@/lib/db/client";
import { appSettings } from "@/lib/db/schema";
import { ScoringConfigSchema, type ScoringConfig } from "@/lib/scoring/config";

/** Read a JSON setting and validate it; invalid or missing values fall back to defaults. */
export async function readSetting<S extends z.ZodType>(
  db: Db,
  key: string,
  schema: S,
): Promise<z.output<S>> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key));
  const parsed = schema.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data : schema.parse({});
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
