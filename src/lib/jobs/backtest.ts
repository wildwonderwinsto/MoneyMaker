import { and, asc, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import {
  backtestRuns,
  leaderboardSnapshots,
  markets,
  monthlySelections,
  traders,
  traderScores,
} from "@/lib/db/schema";
import { runBacktest, type BacktestParams, type RecordedPicks } from "@/lib/scoring/backtest";
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from "@/lib/scoring/config";

import { getMidpoints } from "@/lib/polymarket/clob";

import { fetchActivityWindow, isBotLike, rebuildPickMonth, recentProfile } from "./activityHistory";
import { getRiskConfig } from "@/lib/settings";

import { loadInputs } from "./score";

const monthKey = (d: Date) => d.toISOString().slice(0, 7);

/** First day of the month `back` months before `now`'s month, as YYYY-MM. */
const monthsBack = (now: Date, back: number) =>
  monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)));

/**
 * Record this month's picks once, on the month's first daily run: the strategy's top
 * Proven/Elite/Verified traders (after today's scoring) and the overall month leaderboard's top
 * earners (from today's discovery). Later runs this month leave them untouched.
 */
export async function recordMonthlySelections(
  db: Db,
  topK: number,
  log: (m: string) => void,
  now = new Date(),
  /** Bot check for the baseline (#9): the scoring config's trades-a-day limit. */
  maxTradesPerDay = DEFAULT_SCORING_CONFIG.maxTradesPerDay,
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
      .where(inArray(traderScores.tier, ["proven", "elite", "verified"]))
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
    // Bot-free (#9, owner 2026-11-08): skip wallets whose last 30 days are bots' (too many
    // trades a day, or mostly redeems / merges / conversions) and take the next on the board.
    // A failed lookup leaves the baseline unrecorded this run; the next run retries.
    const top: string[] = [];
    let skipped = 0;
    try {
      for (const wallet of [...new Set(board.map((b) => b.wallet))]) {
        if (top.length >= topK || top.length + skipped >= 3 * topK) break;
        const p = await recentProfile(wallet, Math.floor(now.getTime() / 1000));
        if (isBotLike(p, maxTradesPerDay)) skipped++;
        else top.push(wallet);
      }
    } catch (err) {
      log(`baseline not recorded (activity lookup failed, retried next run): ${String(err)}`);
      top.length = 0;
    }
    if (skipped) log(`baseline: skipped ${skipped} bot-like wallets on the month board`);
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
    const picks: RecordedPicks = out.get(r.month) ?? {
      strategy: [],
      baseline: [],
      from: Infinity,
      results: {},
    };
    picks[r.method].push(r.wallet);
    const at = Math.floor(r.recordedAt.getTime() / 1000);
    picks.from = Math.min(picks.from, at);
    picks.fromByMethod = {
      ...picks.fromByMethod,
      [r.method]: Math.min(picks.fromByMethod?.[r.method] ?? Infinity, at),
    };
    if (r.bets !== null && r.staked !== null && r.pnl !== null) {
      picks.results![`${r.method}:${r.wallet}`] = {
        bets: r.bets,
        staked: r.staked,
        pnl: r.pnl,
        partial: r.partial ?? false,
      };
    }
    out.set(r.month, picks);
  }
  for (const p of out.values()) if (!Object.keys(p.results ?? {}).length) delete p.results;
  return out;
}

/**
 * Once a recorded month is over, rebuild each pick's month from their own activity (#9) and
 * store it on the monthly_selections row: bets opened from when the pick was recorded to
 * the month's end. Still-held shares are valued at the settled payout, else today's price.
 * Each row is rebuilt once.
 */
export async function rebuildRecordedMonths(
  db: Db,
  params: BacktestParams,
  log: (m: string) => void,
  now = new Date(),
): Promise<{ rebuilt: number; partial: number }> {
  const keys = Array.from({ length: params.months }, (_, i) => monthsBack(now, i + 1));
  const todo = await db
    .select()
    .from(monthlySelections)
    .where(and(inArray(monthlySelections.month, keys), isNull(monthlySelections.bets)));
  let partial = 0;
  for (const row of todo) {
    const [y, m] = row.month.split("-").map(Number);
    const monthStart = Date.UTC(y, m - 1, 1) / 1000;
    const end = Date.UTC(y, m, 1) / 1000;
    const from = Math.max(monthStart, Math.floor(row.recordedAt.getTime() / 1000));
    const w = await fetchActivityWindow(row.wallet, from, end);
    const value = await holdValues(db, w.rows);
    const starts = params.skipInPlay ? await gameStarts(db, w.rows) : new Map<string, number>();
    const r = rebuildPickMonth(
      w.rows,
      (t) => value.get(t),
      params.copySlippage,
      params.takerFeeRate,
      {
        ...params,
        gameStart: (c) => starts.get(c),
      },
    );
    if (w.partial) partial++;
    await db
      .update(monthlySelections)
      .set({ coverageStart: new Date(w.coverageStart * 1000), partial: w.partial, ...r })
      .where(
        and(
          eq(monthlySelections.month, row.month),
          eq(monthlySelections.method, row.method),
          eq(monthlySelections.wallet, row.wallet),
        ),
      );
  }
  if (todo.length)
    log(`rebuilt ${todo.length} recorded pick-months from activity (${partial} partial)`);
  return { rebuilt: todo.length, partial };
}

/** Per token: settled payout from the markets table, else today's midpoint. */
/** Sports game starts (epoch seconds) from stored markets, for the in-play rule. */
async function gameStarts(db: Db, rows: { condition_id: string }[]) {
  const ids = [...new Set(rows.map((r) => r.condition_id))];
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const ms = await db
    .select({ id: markets.conditionId, start: markets.gameStartTime })
    .from(markets)
    .where(and(inArray(markets.conditionId, ids), isNotNull(markets.gameStartTime)));
  for (const m of ms) out.set(m.id, m.start!.getTime() / 1000);
  return out;
}

async function holdValues(db: Db, rows: { condition_id: string; token_id?: string | null }[]) {
  const tokens = [...new Set(rows.map((r) => r.token_id).filter((t): t is string => !!t))];
  const conditions = [...new Set(rows.map((r) => r.condition_id))];
  const out = new Map<string, number>();
  if (conditions.length) {
    const ms = await db
      .select({ tokenIds: markets.tokenIds, payouts: markets.payouts, winner: markets.winnerIndex })
      .from(markets)
      .where(inArray(markets.conditionId, conditions));
    for (const m of ms) {
      m.tokenIds.forEach((t, i) => {
        const v = m.payouts?.[i] ?? (m.winner === null ? undefined : m.winner === i ? 1 : 0);
        if (v !== undefined) out.set(t, v);
      });
    }
  }
  const open = tokens.filter((t) => !out.has(t));
  if (open.length) for (const [t, p] of await getMidpoints(open)) out.set(t, p);
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
  // The engine's saved filters, so the backtest copies what the engine would (B4 + the
  // in-play rule, owner 2026-11-10), not the defaults.
  const risk = await getRiskConfig(db);
  params = {
    ...params,
    minLeaderUsd: risk.minLeaderUsd,
    minEntryPrice: risk.minEntryPrice,
    maxEntryPrice: risk.maxEntryPrice,
    skipInPlay: risk.skipInPlay,
  };
  const now = Math.floor(Date.now() / 1000);
  const wallets = (
    await db
      .select({ wallet: traders.wallet })
      .from(traders)
      .where(isNotNull(traders.lastBackfillAt))
  ).map((r) => r.wallet);
  await rebuildRecordedMonths(db, params, log, new Date(now * 1000));
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
