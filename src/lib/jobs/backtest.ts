import { isNotNull } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import { backtestRuns, traders } from "@/lib/db/schema";
import { runBacktest, type BacktestParams } from "@/lib/scoring/backtest";
import type { ScoringConfig } from "@/lib/scoring/config";

import { loadInputs } from "./score";

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
  const { inputs } = await loadInputs(db, wallets, now);
  log(`backtesting ${params.months} months over ${inputs.size} traders`);

  const result = runBacktest([...inputs.values()], cfg, params, now);
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
