import { mkdirSync } from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";

export const PGLITE_PREFIX = "pglite:";

export function isPgliteUrl(url: string): boolean {
  return url.startsWith(PGLITE_PREFIX);
}

/** Open an embedded PGlite database from `pglite:memory` or `pglite:<directory>`. */
export function openPglite(url: string): PGlite {
  const target = url.slice(PGLITE_PREFIX.length);
  if (target === "memory") return new PGlite();
  const dir = path.resolve(target);
  mkdirSync(path.dirname(dir), { recursive: true });
  return new PGlite(dir);
}
