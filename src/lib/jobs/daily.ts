/**
 * The daily pipeline: discover → backfill → resolve → score → record picks → backtest →
 * prune. Run by `npm run job -- daily` (src/scripts/job.ts); kept here so it can be tested.
 */
import { eq } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import { follows, traders } from "@/lib/db/schema";
import { DEFAULT_BACKTEST, type BacktestParams } from "@/lib/scoring/backtest";
import type { ScoringConfig } from "@/lib/scoring/config";

import {
  backfillTrader,
  cleanupStorage,
  DEFAULT_BACKFILL,
  prunePositions,
  resolveMarkets,
} from "./backfill";
import { backtestJob, recordedWallets, recordMonthlySelections } from "./backtest";
import { DEFAULT_DISCOVER, discoverCandidates, type DiscoverOptions } from "./discover";
import { DEFAULT_SCORE, scoreAll } from "./score";
import { JobFailure, mapPool } from "./util";

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
  // Mostly stale history (more than half failed, owner's cut-off): scoring it, recording
  // picks and pruning would look like a good run and make the backup runs skip.
  if (wallets.length > 0 && backfill.failed * 2 > wallets.length) {
    throw new JobFailure(
      `${backfill.failed} of ${wallets.length} backfills failed (more than half); nothing scored`,
      { discovered: discovered.kept, backfill },
    );
  }
  const { rejected, ...score } = await scoreAll(db, cfg, DEFAULT_SCORE, log);
  // A shrunken run (e.g. a quick local --limit 5) must not stand in for the real one: it
  // records no picks, and `full: false` keeps it from counting as today's run.
  const full =
    opts.discover.maxCandidates >= DEFAULT_DISCOVER.maxCandidates &&
    opts.discover.perBoard >= DEFAULT_DISCOVER.perBoard &&
    opts.backtest.topK === DEFAULT_BACKTEST.topK;
  const selections = full ? await recordMonthlySelections(db, opts.backtest.topK, log) : null;
  if (!full) log("smaller than a default run: this month's picks not recorded");
  const backtest = await backtestJob(db, cfg, opts.backtest, log);
  const pruned = opts.prune ? await prunePositions(db, rejected) : 0;
  log(`pruned ${pruned} position rows of ${rejected.length} rejected traders`);
  const cleaned = await cleanupStorage(db);
  log(
    `removed ${cleaned.markets} orphan markets, ${cleaned.trades} old trades, ${cleaned.snapshots} old leaderboard rows`,
  );
  return {
    full,
    discovered: discovered.kept,
    backfill,
    score,
    selections,
    backtest,
    pruned,
    cleaned,
  };
}
