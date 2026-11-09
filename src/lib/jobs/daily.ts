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
import { DEFAULT_ROTATION, pickDailyWallets } from "./rotation";
import { DEFAULT_SCORE, scoreAll } from "./score";
import { httpStats } from "@/lib/http";

import { JobFailure, mapPool } from "./util";

type Step = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export async function backfillMany(
  db: Db,
  wallets: string[],
  log: (m: string) => void,
  step: Step = (_name, fn) => fn(),
) {
  let done = 0;
  let failed = 0;
  let positions = 0;
  const succeeded = new Set<string>();
  await step("backfill", () =>
    mapPool(wallets, 3, async (wallet) => {
      try {
        const r = await backfillTrader(db, wallet, DEFAULT_BACKFILL);
        positions += r.positions;
        succeeded.add(wallet);
      } catch (err) {
        failed++;
        log(`backfill failed for ${wallet}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (++done % 25 === 0) log(`backfilled ${done}/${wallets.length}`);
    }),
  );
  const resolved = await step("market resolution", () => resolveMarkets(db, log));
  return { traders: wallets.length, failed, positions, ...resolved, succeeded };
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
  // Per-step wall time and API traffic, logged and kept in the run's stats.
  const timings: Record<
    string,
    {
      seconds: number;
      requests: number;
      rateLimited: number;
      retries: number;
      retryWaitSeconds: number;
    }
  > = {};
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    const h0 = httpStats();
    try {
      return await fn();
    } finally {
      const h = httpStats();
      const t = {
        seconds: Math.round((Date.now() - t0) / 100) / 10,
        requests: h.requests - h0.requests,
        rateLimited: h.rateLimited - h0.rateLimited,
        retries: h.retries - h0.retries,
        retryWaitSeconds: Math.round((h.retryWaitMs - h0.retryWaitMs) / 100) / 10,
      };
      timings[name] = t;
      log(
        `⏱ ${name}: ${t.seconds}s, ${t.requests} API calls, ${t.rateLimited} × 429, ${t.retries} retries (${t.retryWaitSeconds}s waiting)`,
      );
    }
  };
  const discovered = await step("discovery", () => discoverCandidates(db, cfg, opts.discover, log));
  // Followed traders need a fresh usual stake for sizing; the rotation always includes them.
  const followed = (
    await db.select({ wallet: follows.wallet }).from(follows).where(eq(follows.enabled, true))
  ).map((f) => f.wallet);
  if (followed.length) {
    await db
      .insert(traders)
      .values(followed.map((wallet) => ({ wallet })))
      .onConflictDoNothing();
  }
  // Today's full checks: re-checks first, then wallets not checked recently (design #3).
  const rotation = await pickDailyWallets(db, discovered.ranked, {
    ...DEFAULT_ROTATION,
    slots: opts.discover.maxCandidates,
    earlyReturnMarkets: cfg.minResolved,
  });
  log(
    `rotation: ${rotation.recheck} re-checks (${rotation.followed} followed) + ${rotation.fresh} new`,
  );
  // Traders picked in recorded months are judged by the backtest: keep them backfilled.
  const recorded = await recordedWallets(db, opts.backtest.months);
  const wallets = [...new Set([...rotation.wallets, ...recorded])];
  const { succeeded, ...backfill } = await backfillMany(db, wallets, log, step);
  // Mostly stale history (more than half failed, owner's cut-off): scoring it, recording
  // picks and pruning would look like a good run and make the backup runs skip.
  if (wallets.length > 0 && backfill.failed * 2 > wallets.length) {
    throw new JobFailure(
      `${backfill.failed} of ${wallets.length} backfills failed (more than half); nothing scored`,
      { discovered: discovered.kept, backfill },
    );
  }
  // Only today's checks with fresh history are scored (J1: no re-scoring frozen history).
  const { rejected, candidates, ...score } = await step("scoring", () =>
    scoreAll(
      db,
      cfg,
      DEFAULT_SCORE,
      log,
      rotation.wallets.filter((w) => succeeded.has(w)),
    ),
  );
  // A shrunken run (e.g. a quick local --limit 5) must not stand in for the real one: it
  // records no picks, and `full: false` keeps it from counting as today's run.
  const full =
    opts.discover.maxCandidates >= DEFAULT_DISCOVER.maxCandidates &&
    opts.discover.perBoard >= DEFAULT_DISCOVER.perBoard &&
    opts.backtest.topK === DEFAULT_BACKTEST.topK;
  const selections = full ? await recordMonthlySelections(db, opts.backtest.topK, log) : null;
  if (!full) log("smaller than a default run: this month's picks not recorded");
  const backtest = await step("backtest", () => backtestJob(db, cfg, opts.backtest, log));
  // Candidates keep no history between checks either (storage); it reloads when due.
  const pruned = opts.prune ? await prunePositions(db, [...rejected, ...candidates]) : 0;
  log(
    `pruned ${pruned} position rows of ${rejected.length} rejected and ${candidates.length} candidate traders`,
  );
  const cleaned = await cleanupStorage(db);
  log(
    `removed ${cleaned.markets} orphan markets, ${cleaned.trades} old trades, ${cleaned.snapshots} old leaderboard rows`,
  );
  return {
    timings,
    full,
    discovered: discovered.ranked.length,
    rotation: { recheck: rotation.recheck, followed: rotation.followed, fresh: rotation.fresh },
    candidates: candidates.length,
    backfill,
    score,
    selections,
    backtest,
    pruned,
    cleaned,
  };
}
