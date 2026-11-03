import { eq } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import { jobRuns } from "@/lib/db/schema";

/** Run `fn` while recording a job_runs row (status, stats, error) for the dashboard. */
export async function runJob<T extends Record<string, unknown>>(
  db: Db,
  job: string,
  fn: (log: (msg: string) => void) => Promise<T>,
): Promise<T> {
  const [run] = await db.insert(jobRuns).values({ job, status: "running" }).returning();
  const log = (msg: string) => console.log(`[${job}] ${msg}`);
  try {
    const stats = await fn(log);
    await db
      .update(jobRuns)
      .set({ status: "ok", finishedAt: new Date(), stats })
      .where(eq(jobRuns.id, run.id));
    return stats;
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    await db
      .update(jobRuns)
      .set({ status: "error", finishedAt: new Date(), error: message.slice(0, 4000) })
      .where(eq(jobRuns.id, run.id));
    throw err;
  }
}

/** Map with bounded concurrency, preserving input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const toDate = (epochSeconds: number | null | undefined): Date | null =>
  epochSeconds ? new Date(epochSeconds * 1000) : null;

export const toEpoch = (d: Date | null | undefined): number | null =>
  d ? Math.floor(d.getTime() / 1000) : null;
