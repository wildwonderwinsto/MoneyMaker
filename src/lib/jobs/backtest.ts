import { and, asc, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import {
  backtestRuns,
  leaderboardSnapshots,
  monthlySelections,
  traders,
  traderScores,
} from "@/lib/db/schema";
import { runBacktest, type BacktestParams, type RecordedPicks } from "@/lib/scoring/backtest";
import type { ScoringConfig } from "@/lib/scoring/config";

import { loadInputs } from "./score";

const monthKey = (d: Date) => d.toISOString().slice(0, 7);

/** First day of the month `back` months before `now`'s month, as YYYY-MM. */
const monthsBack = (now: Date, back: number) =>
  monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)));

/**
 * Record this month's picks once, on the month's first daily run: the strategy's top
 * Verified/Elite traders (after today's scoring) and the overall month leaderboard's top
 * earners (from today's discovery). Later runs this month leave them untouched.
 */
export async function recordMonthlySelections(
  db: Db,
  topK: number,
  log: (m: string) => void,
  now = new Date(),
): Promise<{ month: string; strategy: number; baseline: number }> {
  const month = monthKey(now);
  const have = new Set(
    (
      await db
        .select({ method: monthlySelections.method })
        .from(monthlySelections)
        .where(eq(monthlySelections.month, month))
    ).map((r) => r.method),
  );
  const rows: (typeof monthlySelections.$inferInsert)[] = [];

  if (!have.has("strategy")) {
    const picks = await db
      .select({ wallet: traderScores.wallet })
      .from(traderScores)
      .where(inArray(traderScores.tier, ["elite", "verified"]))
      .orderBy(desc(traderScores.score))
      .limit(topK);
    picks.forEach((p, i) =>
      rows.push({ month, method: "strategy", wallet: p.wallet, rank: i + 1, recordedAt: now }),
    );
  }
  if (!have.has("baseline")) {
    // Today's capture of the overall month leaderboard: what a naive copier would see.
    const board = await db
      .select({ wallet: leaderboardSnapshots.wallet })
      .from(leaderboardSnapshots)
      .where(
        and(
          eq(leaderboardSnapshots.timePeriod, "month"),
          eq(leaderboardSnapshots.category, "overall"),
          gte(leaderboardSnapshots.capturedAt, new Date(now.getTime() - 6 * 3_600_000)),
        ),
      )
      .orderBy(asc(leaderboardSnapshots.rank));
    const top = [...new Set(board.map((b) => b.wallet))].slice(0, topK);
    top.forEach((wallet, i) =>
      rows.push({ month, method: "baseline", wallet, rank: i + 1, recordedAt: now }),
    );
    // Top earners may have been dropped by discovery's pre-filter; they still need a
    // trader row so their positions are backfilled and evaluated.
    if (top.length) {
      await db
        .insert(traders)
        .values(top.map((wallet) => ({ wallet })))
        .onConflictDoNothing();
    }
  }
  if (rows.length) await db.insert(monthlySelections).values(rows).onConflictDoNothing();
  const count = (m: string) => rows.filter((r) => r.method === m).length;
  if (rows.length) {
    log(`recorded ${month} picks: ${count("strategy")} strategy, ${count("baseline")} baseline`);
  }
  return { month, strategy: count("strategy"), baseline: count("baseline") };
}

/** Recorded picks for the last `months` complete months, keyed by YYYY-MM. */
export async function loadRecordedPicks(
  db: Db,
  months: number,
  now = new Date(),
): Promise<Map<string, RecordedPicks>> {
  const keys = Array.from({ length: months }, (_, i) => monthsBack(now, i + 1));
  const rows = await db
    .select()
    .from(monthlySelections)
    .where(inArray(monthlySelections.month, keys))
    .orderBy(asc(monthlySelections.rank));
  const out = new Map<string, RecordedPicks>();
  for (const r of rows) {
    const picks = out.get(r.month) ?? { strategy: [], baseline: [], from: Infinity };
    picks[r.method].push(r.wallet);
    picks.from = Math.min(picks.from, Math.floor(r.recordedAt.getTime() / 1000));
    out.set(r.month, picks);
  }
  return out;
}

/** Wallets picked in recorded months the backtest still evaluates (they need backfills). */
export async function recordedWallets(db: Db, months: number, now = new Date()) {
  // The current month too: next month's backtest evaluates it.
  const keys = Array.from({ length: months + 1 }, (_, i) => monthsBack(now, i));
  const rows = await db
    .selectDistinct({ wallet: monthlySelections.wallet })
    .from(monthlySelections)
    .where(inArray(monthlySelections.month, keys));
  return rows.map((r) => r.wallet);
}

/** Run the walk-forward backtest over every backfilled trader and store the result. */
export async function backtestJob(
  db: Db,
  cfg: ScoringConfig,
  params: BacktestParams,
  log: (m: string) => void,
) {
  const now = Math.floor(Date.now() / 1000);
  const wallets = (
    await db
      .select({ wallet: traders.wallet })
      .from(traders)
      .where(isNotNull(traders.lastBackfillAt))
  ).map((r) => r.wallet);
  const [{ inputs }, recorded] = await Promise.all([
    loadInputs(db, wallets, now),
    loadRecordedPicks(db, params.months, new Date(now * 1000)),
  ]);
  log(
    `backtesting ${params.months} months over ${inputs.size} traders (${recorded.size} recorded months)`,
  );

  const result = runBacktest([...inputs.values()], cfg, params, now, recorded);
  const [run] = await db
    .insert(backtestRuns)
    .values({
      params: { ...params, traders: inputs.size },
      summary: { ...result.summary, months: result.months },
      strategyCurve: result.strategyCurve,
      baselineCurve: result.baselineCurve,
    })
    .returning({ id: backtestRuns.id });

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  log(
    `strategy ${pct(result.summary.strategyTotalReturn)} vs baseline ${pct(result.summary.baselineTotalReturn)}`,
  );
  return { runId: run.id, ...result.summary };
}
