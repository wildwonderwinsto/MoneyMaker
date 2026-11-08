/**
 * The daily pipeline: discover → backfill → resolve → score → record picks → backtest →
 * prune. Run by `npm run job -- daily` (src/scripts/job.ts); kept here so it can be tested.
 */
import { eq } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import { follows, traders } from "@/lib/db/schema";
import type { BacktestParams } from "@/lib/scoring/backtest";
import type { ScoringConfig } from "@/lib/scoring/config";

import {
  backfillTrader,
  cleanupStorage,
  DEFAULT_BACKFILL,
  prunePositions,
  resolveMarkets,
} from "./backfill";
import { backtestJob, recordedWallets, recordMonthlySelections } from "./backtest";
import { discoverCandidates, type DiscoverOptions } from "./discover";
import { DEFAULT_SCORE, scoreAll } from "./score";
import { mapPool } from "./util";

export async function backfillMany(db: Db, wallets: string[], log: (m: string) => void) {
  let done = 0;
  let failed = 0;
  let positions = 0;
  await mapPool(wallets, 3, async (wallet) => {
    try {
      const r = await backfillTrader(db, wallet, DEFAULT_BACKFILL);
      positions += r.positions;
    } catch (err) {
      failed++;
      log(`backfill failed for ${wallet}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (++done % 25 === 0) log(`backfilled ${done}/${wallets.length}`);
  });
  const resolved = await resolveMarkets(db, log);
  return { traders: wallets.length, failed, positions, ...resolved };
}

export interface DailyOptions {
  discover: DiscoverOptions;
  backtest: BacktestParams;
  prune: boolean;
}

export async function dailyJob(
  db: Db,
  cfg: ScoringConfig,
  opts: DailyOptions,
  log: (m: string) => void,
) {
  const discovered = await discoverCandidates(db, cfg, opts.discover, log);
  // Traders picked in recorded months are judged by the backtest, and followed traders
  // need a fresh usual stake for sizing: keep both backfilled too.
  const recorded = await recordedWallets(db, opts.backtest.months);
  // Only traders being copied: paused ones don't need fresh history every day.
  const followed = (
    await db.select({ wallet: follows.wallet }).from(follows).where(eq(follows.enabled, true))
  ).map((f) => f.wallet);
  if (followed.length) {
    await db
      .insert(traders)
      .values(followed.map((wallet) => ({ wallet })))
      .onConflictDoNothing();
  }
  const wallets = [...new Set([...discovered.wallets, ...recorded, ...followed])];
  const backfill = await backfillMany(db, wallets, log);
  // Nothing fresh to score: re-scoring yesterday's history, recording picks and pruning
  // would look like a good run and make the backup runs skip.
  if (wallets.length > 0 && backfill.failed >= wallets.length) {
    throw new Error(`${backfill.failed} of ${wallets.length} backfills failed; nothing to score`);
  }
  const { rejected, ...score } = await scoreAll(db, cfg, DEFAULT_SCORE, log);
  const selections = await recordMonthlySelections(db, opts.backtest.topK, log);
  const backtest = await backtestJob(db, cfg, opts.backtest, log);
  const pruned = opts.prune ? await prunePositions(db, rejected) : 0;
  log(`pruned ${pruned} position rows of ${rejected.length} rejected traders`);
  const cleaned = await cleanupStorage(db);
  log(
    `removed ${cleaned.markets} orphan markets, ${cleaned.trades} old trades, ${cleaned.snapshots} old leaderboard rows`,
  );
  return {
    discovered: discovered.kept,
    backfill,
    score,
    selections,
    backtest,
    pruned,
    cleaned,
  };
}
