/**
 * Job CLI.
 *   npm run job -- discover [--limit 300] [--per-board 100]
 *   npm run job -- backfill            # all known candidates without recent backfill
 *   npm run job -- score
 *   npm run job -- backtest [--months 6] [--top 10]
 *   npm run job -- daily [--limit 300] # discover → backfill → resolve → score → record picks → backtest → prune
 *       [--skip-if-done-today]          # (scheduled backups) exit if today's daily run already succeeded
 *   npm run job -- follow <wallet>     # follow a trader (paper copy)
 *   npm run job -- tick                # run one copy-engine tick locally
 */
import { parseArgs } from "node:util";

import { and, isNull, lt, or } from "drizzle-orm";

import { closeDb, getDb, type Db } from "@/lib/db/client";
import { runTick } from "@/lib/copy/tick";
import { follows, traders } from "@/lib/db/schema";
import { backtestJob } from "@/lib/jobs/backtest";
import { backfillMany, dailyJob } from "@/lib/jobs/daily";
import { DEFAULT_DISCOVER, discoverCandidates } from "@/lib/jobs/discover";
import { DEFAULT_SCORE, scoreAll } from "@/lib/jobs/score";
import { runJob, succeededToday } from "@/lib/jobs/util";
import { DEFAULT_BACKTEST } from "@/lib/scoring/backtest";
import { getScoringConfig } from "@/lib/settings";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    limit: { type: "string" },
    "per-board": { type: "string" },
    months: { type: "string" },
    top: { type: "string" },
    "no-prune": { type: "boolean", default: false },
    "skip-if-done-today": { type: "boolean", default: false },
  },
});
const num = (v: string | undefined, fallback: number) => (v === undefined ? fallback : Number(v));

async function staleWallets(db: Db): Promise<string[]> {
  const cutoff = new Date(Date.now() - 20 * 3600 * 1000);
  const rows = await db
    .select({ wallet: traders.wallet })
    .from(traders)
    .where(and(or(isNull(traders.lastBackfillAt), lt(traders.lastBackfillAt, cutoff))));
  return rows.map((r) => r.wallet);
}

async function main() {
  const command = positionals[0];
  const db = getDb();
  const cfg = await getScoringConfig(db);
  const discoverOpts = {
    ...DEFAULT_DISCOVER,
    maxCandidates: num(values.limit, DEFAULT_DISCOVER.maxCandidates),
    perBoard: num(values["per-board"], DEFAULT_DISCOVER.perBoard),
  };
  const backtestOpts = {
    ...DEFAULT_BACKTEST,
    months: num(values.months, DEFAULT_BACKTEST.months),
    topK: num(values.top, DEFAULT_BACKTEST.topK),
    copySlippage: cfg.copySlippage,
  };

  switch (command) {
    case "discover":
      await runJob(db, "discover", (log) => discoverCandidates(db, cfg, discoverOpts, log));
      break;
    case "backfill":
      await runJob(db, "backfill", async (log) => backfillMany(db, await staleWallets(db), log));
      break;
    case "score":
      await runJob(db, "score", async (log) => {
        const { rejected, ...stats } = await scoreAll(db, cfg, DEFAULT_SCORE, log);
        return { ...stats, rejected: rejected.length };
      });
      break;
    case "backtest":
      await runJob(db, "backtest", (log) => backtestJob(db, cfg, backtestOpts, log));
      break;
    case "daily":
      if (values["skip-if-done-today"] && (await succeededToday(db, "daily"))) {
        console.log("[daily] already succeeded today (UTC); skipping this backup run");
        break;
      }
      await runJob(db, "daily", (log) =>
        dailyJob(
          db,
          cfg,
          { discover: discoverOpts, backtest: backtestOpts, prune: !values["no-prune"] },
          log,
        ),
      );
      break;
    case "follow": {
      const wallet = positionals[1]?.toLowerCase();
      if (!wallet || !/^0x[0-9a-f]{40}$/.test(wallet)) throw new Error("Usage: follow <0x wallet>");
      await db
        .insert(follows)
        .values({ wallet })
        .onConflictDoUpdate({
          target: follows.wallet,
          set: { enabled: true },
        });
      console.log(`Following ${wallet}`);
      break;
    }
    case "tick":
      console.log(JSON.stringify(await runTick(db), null, 2));
      break;
    default:
      console.error(
        "Usage: npm run job -- <discover|backfill|score|backtest|daily|follow|tick> [options]",
      );
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
