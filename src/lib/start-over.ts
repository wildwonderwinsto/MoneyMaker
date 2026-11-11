/**
 * Start over (owner, 2026-11-10): delete all data and begin again, keeping settings.
 *
 * Every data table is emptied with TRUNCATE (frees the disk space at once; DELETE leaves it
 * to vacuum) in one transaction, under the copy engine's lease so no tick writes midway.
 * Kept: app_settings (settings, the engine's lease and status) and the paper account row,
 * which goes back to its starting balance. Refused while a daily job is running: it would
 * keep writing into the emptied tables.
 */
import { and, eq, gt, sql } from "drizzle-orm";

import { withEngineLease } from "@/lib/copy/tick";
import type { Db } from "@/lib/db/client";
import { jobRuns, paperAccounts } from "@/lib/db/schema";

/** What the admin types to confirm (checked on the server too). */
export const START_OVER_CONFIRM = "delete everything";

/** Emptied by Start over. A test fails if a table is in neither list. */
export const WIPED_TABLES = [
  "backtest_runs",
  "cursors",
  "equity_snapshots",
  "follows",
  "hidden_traders",
  "job_runs",
  "leaderboard_snapshots",
  "markets",
  "monthly_selections",
  "paper_fills",
  "paper_positions",
  "signals",
  "skill_evidence",
  "trader_pnl_daily",
  "trader_positions",
  "trader_scores",
  "trader_trades",
  "traders",
] as const;

/** Kept: settings + engine lease/status, and the paper account (reset, not deleted). */
export const KEPT_TABLES = ["app_settings", "paper_accounts"] as const;

/** Same cut-off runJob uses: a "running" row older than this was a killed run. */
const STUCK_JOB_MS = 3 * 3_600_000;

export async function startOver(
  db: Db,
  confirm: string,
): Promise<{ ok: boolean; message: string }> {
  if (confirm.trim().toLowerCase() !== START_OVER_CONFIRM) {
    return { ok: false, message: `Type “${START_OVER_CONFIRM}” to confirm.` };
  }
  const [running] = await db
    .select({ job: jobRuns.job, startedAt: jobRuns.startedAt })
    .from(jobRuns)
    .where(
      and(
        eq(jobRuns.status, "running"),
        gt(jobRuns.startedAt, new Date(Date.now() - STUCK_JOB_MS)),
      ),
    )
    .limit(1);
  if (running) {
    return {
      ok: false,
      message: `The ${running.job} job is running; start over once it has finished.`,
    };
  }
  await withEngineLease(db, (locked) =>
    locked.transaction(async (tx) => {
      await tx.execute(sql.raw(`truncate table ${WIPED_TABLES.join(", ")} restart identity`));
      await tx
        .update(paperAccounts)
        .set({ cash: sql`${paperAccounts.startingBalance}`, resetAt: new Date() });
    }),
  );
  return {
    ok: true,
    message:
      "Started over: all data deleted, settings kept. The next daily run discovers traders again.",
  };
}
