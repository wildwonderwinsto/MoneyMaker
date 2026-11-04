import "server-only";

import { and, asc, desc, eq, gt, gte, inArray, ne, sql } from "drizzle-orm";

import { ensureDefaultAccount, loadAccountState } from "@/lib/copy/account";
import { getDb } from "@/lib/db/client";
import {
  appSettings,
  backtestRuns,
  equitySnapshots,
  follows,
  jobRuns,
  paperFills,
  paperPositions,
  signals,
  traderPnlDaily,
  traderPositions,
  traders,
  traderScores,
  type ScoreTier,
} from "@/lib/db/schema";
import { getRiskConfig, getScoringConfig } from "@/lib/settings";

export type TierFilter = ScoreTier | "all" | "followed";

const TIER_ORDER = sql`case ${traderScores.tier} when 'elite' then 0 when 'verified' then 1 when 'watchlist' then 2 else 3 end`;

export async function getTraderList(opts: {
  tier?: TierFilter;
  category?: string;
  limit?: number;
}) {
  const db = getDb();
  const tier = opts.tier ?? "verified";
  const conditions = [];
  if (tier === "verified") conditions.push(inArray(traderScores.tier, ["elite", "verified"]));
  else if (tier === "followed") conditions.push(eq(follows.enabled, true));
  else if (tier !== "all") conditions.push(eq(traderScores.tier, tier));
  if (opts.category) conditions.push(eq(traderScores.primaryCategory, opts.category));

  return db
    .select({
      wallet: traderScores.wallet,
      tier: traderScores.tier,
      score: traderScores.score,
      nResolved: traderScores.nResolved,
      winRate: traderScores.winRate,
      expectedWinRate: traderScores.expectedWinRate,
      zSkill: traderScores.zSkill,
      roi: traderScores.roi,
      totalPnl: traderScores.totalPnl,
      profitableMonthsPct: traderScores.profitableMonthsPct,
      copyAdjRoi: traderScores.copyAdjRoi,
      topMarketShare: traderScores.topMarketShare,
      primaryCategory: traderScores.primaryCategory,
      lastTradeAt: traderScores.lastTradeAt,
      checks: traderScores.checks,
      metrics: traderScores.metrics,
      name: traders.name,
      profileImage: traders.profileImage,
      xUsername: traders.xUsername,
      following: follows.enabled,
    })
    .from(traderScores)
    .innerJoin(traders, eq(traders.wallet, traderScores.wallet))
    .leftJoin(follows, eq(follows.wallet, traderScores.wallet))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(TIER_ORDER, desc(traderScores.score))
    .limit(opts.limit ?? 120);
}
export type TraderListItem = Awaited<ReturnType<typeof getTraderList>>[number];

export async function getTierCounts() {
  const rows = await getDb()
    .select({ tier: traderScores.tier, n: sql<number>`count(*)::int` })
    .from(traderScores)
    .groupBy(traderScores.tier);
  return Object.fromEntries(rows.map((r) => [r.tier, r.n])) as Partial<Record<ScoreTier, number>>;
}

export async function getTrader(wallet: string) {
  const db = getDb();
  const [row] = await db
    .select({ trader: traders, score: traderScores, follow: follows })
    .from(traders)
    .leftJoin(traderScores, eq(traderScores.wallet, traders.wallet))
    .leftJoin(follows, eq(follows.wallet, traders.wallet))
    .where(eq(traders.wallet, wallet));
  if (!row) return null;

  const [positions, pnl] = await Promise.all([
    db
      .select()
      .from(traderPositions)
      // Zero-cost rows come from share splits/merges, not bets.
      .where(and(eq(traderPositions.wallet, wallet), gt(traderPositions.totalCost, 0)))
      .orderBy(desc(traderPositions.lastActivityAt))
      .limit(40),
    db
      .select({ day: traderPnlDaily.day, pnl: traderPnlDaily.pnl })
      .from(traderPnlDaily)
      .where(eq(traderPnlDaily.wallet, wallet))
      .orderBy(asc(traderPnlDaily.day)),
  ]);
  return { ...row, positions, pnl };
}

export async function getSignals(limit = 80) {
  return getDb()
    .select({ signal: signals, name: traders.name })
    .from(signals)
    .leftJoin(traders, eq(traders.wallet, signals.wallet))
    .orderBy(desc(signals.detectedAt))
    .limit(limit);
}

export async function getFollowList() {
  return getDb()
    .select({
      follow: follows,
      name: traders.name,
      tier: traderScores.tier,
      score: traderScores.score,
    })
    .from(follows)
    .leftJoin(traders, eq(traders.wallet, follows.wallet))
    .leftJoin(traderScores, eq(traderScores.wallet, follows.wallet))
    .orderBy(desc(follows.enabled), desc(follows.createdAt));
}

export async function getPaperOverview() {
  const db = getDb();
  const account = await ensureDefaultAccount(db);
  const state = await loadAccountState(db, account.id);
  const since = new Date(Date.now() - 90 * 86_400_000);

  const [closed, fills, equity, byTrader] = await Promise.all([
    db
      .select()
      .from(paperPositions)
      .where(and(eq(paperPositions.accountId, account.id), ne(paperPositions.status, "open")))
      .orderBy(desc(paperPositions.closedAt))
      .limit(100),
    db
      .select({ fill: paperFills, title: paperPositions.title, outcome: paperPositions.outcome })
      .from(paperFills)
      .leftJoin(paperPositions, eq(paperPositions.id, paperFills.positionId))
      .where(eq(paperFills.accountId, account.id))
      .orderBy(desc(paperFills.ts))
      .limit(50),
    db
      .select()
      .from(equitySnapshots)
      .where(and(eq(equitySnapshots.accountId, account.id), gte(equitySnapshots.ts, since)))
      .orderBy(asc(equitySnapshots.ts)),
    db
      .select({
        wallet: paperPositions.sourceWallet,
        name: traders.name,
        realized: sql<number>`sum(${paperPositions.realizedPnl})::float8`,
        openCost: sql<number>`sum(case when ${paperPositions.status} = 'open' then ${paperPositions.costBasis} else 0 end)::float8`,
        openValue: sql<number>`sum(case when ${paperPositions.status} = 'open' then ${paperPositions.shares} * coalesce(${paperPositions.currentPrice}, ${paperPositions.avgPrice}) else 0 end)::float8`,
        trades: sql<number>`count(*)::int`,
      })
      .from(paperPositions)
      .leftJoin(traders, eq(traders.wallet, paperPositions.sourceWallet))
      .where(eq(paperPositions.accountId, account.id))
      .groupBy(paperPositions.sourceWallet, traders.name),
  ]);

  const finished = closed.filter((p) => p.status === "settled" || p.status === "closed");
  const wins = finished.filter((p) => p.realizedPnl > 0).length;
  return {
    account: state.account,
    cash: state.cash,
    positionsValue: state.positionsValue,
    equity: state.equity,
    totalReturn: state.equity / state.account.startingBalance - 1,
    open: state.open,
    closed,
    fills,
    equityCurve: equity.map((e) => ({ t: e.ts.toISOString(), equity: e.equity })),
    winRate: finished.length ? wins / finished.length : null,
    finishedCount: finished.length,
    byTrader,
  };
}

export async function getBacktests(limit = 10) {
  return getDb().select().from(backtestRuns).orderBy(desc(backtestRuns.createdAt)).limit(limit);
}

export async function getJobRuns(limit = 10) {
  return getDb().select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(limit);
}

export async function getSettings() {
  const db = getDb();
  const [scoring, risk] = await Promise.all([getScoringConfig(db), getRiskConfig(db)]);
  return { scoring, risk };
}

/** Last copy-engine tick (the tick lease row is touched on every run) and follow count. */
export async function getEngineStatus() {
  const db = getDb();
  const [[lease], [following]] = await Promise.all([
    db
      .select({ at: appSettings.updatedAt })
      .from(appSettings)
      .where(eq(appSettings.key, "lease:tick")),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(follows)
      .where(eq(follows.enabled, true)),
  ]);
  const lastTickAt = lease?.at ?? null;
  return {
    lastTickAt,
    // Healthy if a tick ran in the last 5 minutes (cron fires every minute).
    healthy: lastTickAt !== null && Date.now() - lastTickAt.getTime() < 5 * 60_000,
    following: following?.n ?? 0,
  };
}
