import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";

import { ensureDefaultAccount, loadAccountState } from "@/lib/copy/account";
import { readEngineStatus } from "@/lib/copy/status";
import { getDb } from "@/lib/db/client";
import {
  appSettings,
  backtestRuns,
  equitySnapshots,
  follows,
  hiddenTraders,
  jobRuns,
  markets,
  paperFills,
  paperPositions,
  signals,
  traderPnlDaily,
  traderPositions,
  traders,
  traderScores,
  type ScoreTier,
} from "@/lib/db/schema";
import { resultRows } from "@/lib/lease";
import { groupSignals, summarize } from "@/lib/live";
import { getRiskConfig, getScoringConfig } from "@/lib/settings";

export type TierFilter = ScoreTier | "all" | "followed" | "hidden";

const TIER_ORDER = sql`case ${traderScores.tier} when 'elite' then 0 when 'verified' then 1 when 'candidate' then 2 when 'watchlist' then 3 else 4 end`;

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
  else if (tier !== "all" && tier !== "hidden") conditions.push(eq(traderScores.tier, tier));
  // Traders the admin said "no" to only show up under the Hidden filter.
  conditions.push(
    tier === "hidden" ? isNotNull(hiddenTraders.wallet) : isNull(hiddenTraders.wallet),
  );
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
      hidden: sql<boolean>`${hiddenTraders.wallet} is not null`,
    })
    .from(traderScores)
    .innerJoin(traders, eq(traders.wallet, traderScores.wallet))
    .leftJoin(follows, eq(follows.wallet, traderScores.wallet))
    .leftJoin(hiddenTraders, eq(hiddenTraders.wallet, traderScores.wallet))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(TIER_ORDER, desc(traderScores.score))
    .limit(opts.limit ?? 120);
}
export type TraderListItem = Awaited<ReturnType<typeof getTraderList>>[number];

export async function getTierCounts() {
  const db = getDb();
  const [rows, [hidden]] = await Promise.all([
    db
      .select({ tier: traderScores.tier, n: sql<number>`count(*)::int` })
      .from(traderScores)
      .leftJoin(hiddenTraders, eq(hiddenTraders.wallet, traderScores.wallet))
      .where(isNull(hiddenTraders.wallet))
      .groupBy(traderScores.tier),
    db.select({ n: sql<number>`count(*)::int` }).from(hiddenTraders),
  ]);
  return {
    tiers: Object.fromEntries(rows.map((r) => [r.tier, r.n])) as Partial<Record<ScoreTier, number>>,
    hidden: hidden?.n ?? 0,
  };
}

export async function getTrader(wallet: string) {
  const db = getDb();
  const [row] = await db
    .select({ trader: traders, score: traderScores, follow: follows, hidden: hiddenTraders })
    .from(traders)
    .leftJoin(traderScores, eq(traderScores.wallet, traders.wallet))
    .leftJoin(follows, eq(follows.wallet, traders.wallet))
    .leftJoin(hiddenTraders, eq(hiddenTraders.wallet, traders.wallet))
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

/** What became of a signal: the P&L it locked in, or how its copied position is doing. */
export interface SignalOutcome {
  /** Realized P&L of the sell fills made for this signal (includes a closed hedge). */
  realized: number | null;
  /** The position a copied buy went into. */
  position: {
    id: number;
    status: string;
    realizedPnl: number;
    unrealized: number;
  } | null;
}

export async function getSignals(limit = 150) {
  const db = getDb();
  const rows = await db
    .select({ signal: signals, name: traders.name, profileImage: traders.profileImage })
    .from(signals)
    .leftJoin(traders, eq(traders.wallet, signals.wallet))
    .orderBy(desc(signals.detectedAt), desc(signals.leaderTs))
    .limit(limit);
  const acted = [
    ...new Set(
      rows
        .filter((r) => r.signal.decision !== "skipped")
        .map((r) => r.signal.groupId ?? r.signal.id),
    ),
  ];
  const fills = acted.length
    ? await db
        .select({
          signalId: paperFills.signalId,
          side: paperFills.side,
          realizedPnl: paperFills.realizedPnl,
          positionId: paperFills.positionId,
        })
        .from(paperFills)
        .where(inArray(paperFills.signalId, acted))
    : [];
  const positionIds = [
    ...new Set(fills.map((f) => f.positionId).filter((x): x is number => x !== null)),
  ];
  const positions = positionIds.length
    ? await db.select().from(paperPositions).where(inArray(paperPositions.id, positionIds))
    : [];
  const posById = new Map(positions.map((p) => [p.id, p]));

  const outcomes = new Map<string, SignalOutcome>();
  for (const f of fills) {
    if (!f.signalId) continue;
    const o = outcomes.get(f.signalId) ?? { realized: null, position: null };
    if (f.side === "SELL" && f.realizedPnl !== null) o.realized = (o.realized ?? 0) + f.realizedPnl;
    const p = f.positionId !== null ? posById.get(f.positionId) : undefined;
    if (p && p.kind === "copy") {
      o.position = {
        id: p.id,
        status: p.status,
        realizedPnl: p.realizedPnl,
        unrealized:
          p.status === "open" ? p.shares * (p.currentPrice ?? p.avgPrice) - p.costBasis : 0,
      };
    }
    outcomes.set(f.signalId, o);
  }
  return rows.map((r) => ({
    ...r,
    outcome: outcomes.get(r.signal.groupId ?? r.signal.id) ?? null,
  }));
}
export type SignalRow = Awaited<ReturnType<typeof getSignals>>[number];

/**
 * The Live page's "Last 24 hours" card, over every signal of the last 24 hours (UI-15: it
 * was built from the feed's newest 200, so a busy day was undercounted). Only the columns
 * grouping needs, in the feed's order.
 */
export async function getLast24hSummary(now = Date.now()) {
  const rows = await getDb()
    .select({
      id: signals.id,
      wallet: signals.wallet,
      tokenId: signals.tokenId,
      side: signals.side,
      decision: signals.decision,
      reason: signals.reason,
      reasonCode: signals.reasonCode,
      groupId: signals.groupId,
      leaderTs: signals.leaderTs,
      leaderPrice: signals.leaderPrice,
      leaderSize: signals.leaderSize,
      leaderUsdc: signals.leaderUsdc,
    })
    .from(signals)
    // detected_at is indexed and never before the trade; summarize() keeps trades < 24 h old.
    .where(gte(signals.detectedAt, new Date(now - 86_400_000)))
    .orderBy(desc(signals.detectedAt), desc(signals.leaderTs));
  return summarize(groupSignals(rows), now);
}

export async function getFollowList() {
  return (
    getDb()
      .select({
        follow: follows,
        name: traders.name,
        tier: traderScores.tier,
        score: traderScores.score,
      })
      .from(follows)
      .leftJoin(traders, eq(traders.wallet, follows.wallet))
      .leftJoin(traderScores, eq(traderScores.wallet, follows.wallet))
      // Hiding deletes the follow; this covers rows left by older versions.
      .leftJoin(hiddenTraders, eq(hiddenTraders.wallet, follows.wallet))
      .where(isNull(hiddenTraders.wallet))
      .orderBy(desc(follows.enabled), desc(follows.createdAt))
  );
}

export async function getPaperOverview() {
  const db = getDb();
  const account = await ensureDefaultAccount(db);
  const state = await loadAccountState(db, account.id);
  const since = new Date(Date.now() - 90 * 86_400_000);

  // Per finished position: what we bought and how we got out (sells + settlement).
  const fillSum = (expr: string, where: string) =>
    sql<number>`coalesce((select sum(${sql.raw(expr)}) from paper_fills f where f.position_id = ${paperPositions.id} and ${sql.raw(where)}), 0)::float8`;
  const [closed, equity, byTrader, allPositions, markersDesc, totals, investedRows] =
    await Promise.all([
      db
        .select({
          ...getTableColumns(paperPositions),
          boughtShares: fillSum("f.shares", "f.side = 'BUY'"),
          boughtUsd: fillSum("f.notional", "f.side = 'BUY'"),
          exitShares: fillSum("f.shares", "f.side <> 'BUY'"),
          exitUsd: fillSum("f.notional", "f.side <> 'BUY'"),
          soldShares: fillSum("f.shares", "f.side = 'SELL'"),
          settlement: sql<
            string | null
          >`(select f.side from paper_fills f where f.position_id = ${paperPositions.id} and f.kind = 'settlement' order by f.ts desc limit 1)`,
        })
        .from(paperPositions)
        .where(and(eq(paperPositions.accountId, account.id), ne(paperPositions.status, "open")))
        .orderBy(desc(paperPositions.closedAt))
        .limit(100),
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
          open: sql<number>`count(*) filter (where ${paperPositions.status} = 'open')::int`,
          finished: sql<number>`count(*) filter (where ${paperPositions.status} <> 'open' and ${paperPositions.kind} = 'copy')::int`,
          wins: sql<number>`count(*) filter (where ${paperPositions.status} <> 'open' and ${paperPositions.kind} = 'copy' and ${paperPositions.realizedPnl} > 0)::int`,
        })
        .from(paperPositions)
        .leftJoin(traders, eq(traders.wallet, paperPositions.sourceWallet))
        .where(eq(paperPositions.accountId, account.id))
        .groupBy(paperPositions.sourceWallet, traders.name),
      db
        .select({
          id: paperPositions.id,
          sourceWallet: paperPositions.sourceWallet,
          title: paperPositions.title,
          outcome: paperPositions.outcome,
          image: paperPositions.image,
          status: paperPositions.status,
          kind: paperPositions.kind,
          shares: paperPositions.shares,
          costBasis: paperPositions.costBasis,
          avgPrice: paperPositions.avgPrice,
          currentPrice: paperPositions.currentPrice,
          realizedPnl: paperPositions.realizedPnl,
          openedAt: paperPositions.openedAt,
          closedAt: paperPositions.closedAt,
          invested: sql<number>`coalesce((select sum(f.notional) from paper_fills f where f.position_id = ${paperPositions.id} and f.side = 'BUY'), 0)::float8`,
        })
        .from(paperPositions)
        .where(eq(paperPositions.accountId, account.id))
        .orderBy(desc(paperPositions.openedAt))
        .limit(1000),
      // Buys, sells and settlements to mark on the equity chart.
      db
        .select({
          id: paperFills.id,
          ts: paperFills.ts,
          side: paperFills.side,
          kind: paperFills.kind,
          notional: paperFills.notional,
          shares: paperFills.shares,
          avgPrice: paperFills.avgPrice,
          realizedPnl: paperFills.realizedPnl,
          positionId: paperFills.positionId,
          title: paperPositions.title,
          outcome: paperPositions.outcome,
        })
        .from(paperFills)
        .leftJoin(paperPositions, eq(paperPositions.id, paperFills.positionId))
        .where(and(eq(paperFills.accountId, account.id), gte(paperFills.ts, since)))
        // The newest 2,000 (put back in time order below), not the oldest.
        .orderBy(desc(paperFills.ts), desc(paperFills.id))
        .limit(2000),
      // Account-wide totals (the lists above are capped): realized includes partial sells
      // of positions that are still open.
      db
        .select({
          realized: sql<number>`coalesce(sum(${paperPositions.realizedPnl}), 0)::float8`,
          // Win rate over finished copies; hedges are insurance, not bets on the trader.
          finished: sql<number>`count(*) filter (where ${paperPositions.status} <> 'open' and ${paperPositions.kind} = 'copy')::int`,
          wins: sql<number>`count(*) filter (where ${paperPositions.status} <> 'open' and ${paperPositions.kind} = 'copy' and ${paperPositions.realizedPnl} > 0)::int`,
        })
        .from(paperPositions)
        .where(eq(paperPositions.accountId, account.id)),
      // Money put in per trader (all buys), for per-trader return.
      db
        .select({
          wallet: paperPositions.sourceWallet,
          invested: sql<number>`coalesce(sum(${paperFills.notional}), 0)::float8`,
        })
        .from(paperFills)
        .innerJoin(paperPositions, eq(paperPositions.id, paperFills.positionId))
        .where(and(eq(paperFills.accountId, account.id), eq(paperFills.side, "BUY")))
        .groupBy(paperPositions.sourceWallet),
    ]);
  const markers = markersDesc.reverse();
  const investedBy = new Map(investedRows.map((r) => [r.wallet, r.invested]));

  const { realized, finished, wins } = totals[0];
  return {
    account: state.account,
    cash: state.cash,
    positionsValue: state.positionsValue,
    equity: state.equity,
    totalReturn: state.equity / state.account.startingBalance - 1,
    open: state.open,
    closed,
    equityCurve: equity.map((e) => ({ t: e.ts.toISOString(), equity: e.equity })),
    realized,
    winRate: finished ? wins / finished : null,
    finishedCount: finished,
    byTrader: summarizeByTrader(byTrader, allPositions, investedBy),
    markers,
  };
}
export type PaperOverview = Awaited<ReturnType<typeof getPaperOverview>>;

interface PositionSummary {
  id: number;
  sourceWallet: string;
  status: string;
  kind: string;
  shares: number;
  costBasis: number;
  avgPrice: number;
  currentPrice: number | null;
  realizedPnl: number;
  invested: number;
}

/**
 * Per leader: how much money they made us, on how much capital, and their positions.
 * Totals come from SQL over every position (`rows`, `investedBy`); `positions` is the capped
 * list shown on the page and is used only for listing (UI-04: totals were summed from it).
 */
function summarizeByTrader<
  T extends {
    wallet: string;
    name: string | null;
    realized: number;
    openCost: number;
    openValue: number;
    open: number;
    finished: number;
    wins: number;
  },
  P extends PositionSummary,
>(rows: T[], positions: P[], investedBy: Map<string, number>) {
  const pnlOf = (p: P) =>
    p.realizedPnl +
    (p.status === "open" ? p.shares * (p.currentPrice ?? p.avgPrice) - p.costBasis : 0);
  return rows
    .map((t) => {
      const mine = positions.filter((p) => p.sourceWallet === t.wallet);
      const realized = t.realized ?? 0;
      const unrealized = (t.openValue ?? 0) - (t.openCost ?? 0);
      const total = realized + unrealized;
      const invested = investedBy.get(t.wallet) ?? 0;
      return {
        wallet: t.wallet,
        name: t.name,
        realized,
        unrealized,
        total,
        invested,
        roi: invested > 0 ? total / invested : null,
        open: t.open,
        wins: t.wins,
        losses: t.finished - t.wins,
        positions: mine.map((p) => ({ ...p, pnl: pnlOf(p) })),
      };
    })
    .sort((a, b) => b.total - a.total);
}

/** One paper position with everything behind it: fills, the leader's trades, its hedge. */
export async function getPosition(id: number) {
  const db = getDb();
  const account = await ensureDefaultAccount(db);
  const [position] = await db
    .select()
    .from(paperPositions)
    .where(and(eq(paperPositions.id, id), eq(paperPositions.accountId, account.id)));
  if (!position) return null;
  const [fills, leader, market, related, leaderTrades] = await Promise.all([
    db.select().from(paperFills).where(eq(paperFills.positionId, id)).orderBy(asc(paperFills.ts)),
    db
      .select({ name: traders.name, profileImage: traders.profileImage })
      .from(traders)
      .where(eq(traders.wallet, position.sourceWallet)),
    db.select().from(markets).where(eq(markets.conditionId, position.conditionId)),
    db
      .select()
      .from(paperPositions)
      .where(
        or(
          eq(paperPositions.hedgeOf, position.id),
          position.hedgeOf ? eq(paperPositions.id, position.hedgeOf) : sql`false`,
        ),
      ),
    db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.wallet, position.sourceWallet),
          eq(signals.tokenId, position.tokenId),
          gte(signals.leaderTs, new Date(position.openedAt.getTime() - 3_600_000)),
        ),
      )
      .orderBy(asc(signals.leaderTs))
      .limit(200),
  ]);
  return {
    position,
    fills,
    leader: leader[0] ?? null,
    market: market[0] ?? null,
    hedge:
      related.find((p) => p.hedgeOf === position.id && p.status === "open") ??
      related.find((p) => p.hedgeOf === position.id) ??
      null,
    hedgedPosition: related.find((p) => p.id === position.hedgeOf) ?? null,
    leaderTrades,
  };
}
export type PositionDetail = NonNullable<Awaited<ReturnType<typeof getPosition>>>;

export async function getBacktests(limit = 10) {
  return getDb().select().from(backtestRuns).orderBy(desc(backtestRuns.createdAt)).limit(limit);
}

export async function getJobRuns(limit = 10) {
  return getDb().select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(limit);
}

/** Supabase Free plan database size limit (projects go read-only above it). */
export const STORAGE_LIMIT_BYTES = 500 * 1024 * 1024;

/** Database size and the biggest tables, as Supabase counts it (pg_database_size). */
export async function getStorageStats() {
  const db = getDb();
  const [total, tables] = await Promise.all([
    db.execute(sql`select pg_database_size(current_database())::float8 as bytes`),
    db.execute(sql`
      select c.relname as name,
             pg_total_relation_size(c.oid)::float8 as bytes,
             pg_indexes_size(c.oid)::float8 as index_bytes,
             greatest(coalesce(s.n_live_tup, 0), c.reltuples, 0)::float8 as rows
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_stat_user_tables s on s.relid = c.oid
      where n.nspname = 'public' and c.relkind = 'r'
      order by pg_total_relation_size(c.oid) desc
    `),
  ]);
  const [t] = resultRows(total) as Array<{ bytes: number }>;
  const rows = (
    resultRows(tables) as Array<{
      name: string;
      bytes: number;
      index_bytes: number;
      rows: number;
    }>
  ).map((r) => ({
    name: r.name,
    bytes: Number(r.bytes),
    indexBytes: Number(r.index_bytes),
    rows: Math.round(Number(r.rows)),
  }));
  const bytes = Number(t?.bytes ?? 0);
  const tableBytes = rows.reduce((a, r) => a + r.bytes, 0);
  return {
    bytes,
    limit: STORAGE_LIMIT_BYTES,
    tables: rows,
    /** System catalogs and other overhead outside our tables. */
    otherBytes: Math.max(0, bytes - tableBytes),
  };
}
export type StorageStats = Awaited<ReturnType<typeof getStorageStats>>;

export async function getSettings() {
  const db = getDb();
  const [scoring, risk] = await Promise.all([getScoringConfig(db), getRiskConfig(db)]);
  return { scoring, risk };
}

/** Last copy-engine tick (the tick lease row is touched on every run) and follow count. */
export async function getEngineStatus() {
  const db = getDb();
  const [[lease], [following], status, risk] = await Promise.all([
    db
      .select({ at: appSettings.updatedAt })
      .from(appSettings)
      .where(eq(appSettings.key, "lease:tick")),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(follows)
      .where(eq(follows.enabled, true)),
    readEngineStatus(db),
    getRiskConfig(db),
  ]);
  const lastTickAt = lease?.at ?? null;
  const interval = status.intervalSeconds ?? risk.tickIntervalSeconds;
  const loopAlive =
    !!status.loopAliveAt &&
    Date.now() - Date.parse(status.loopAliveAt) < (interval * 3 + 30) * 1000;
  return {
    lastTickAt,
    // Healthy if the engine ran recently (loop: a few intervals; cron alone: 5 minutes).
    healthy:
      lastTickAt !== null &&
      Date.now() - lastTickAt.getTime() < Math.max(5 * 60_000, interval * 3_000),
    following: following?.n ?? 0,
    loop: loopAlive,
    intervalSeconds: interval,
    nextTickAt: loopAlive ? (status.nextTickAt ?? null) : null,
    lastTickMs: status.lastTickMs ?? null,
    realtime: risk.realtime,
    stream: loopAlive ? (status.stream ?? null) : null,
    lastStreamBatchAt: status.lastStreamBatchAt ?? null,
  };
}
export type EngineStatusView = Awaited<ReturnType<typeof getEngineStatus>>;

/**
 * A cheap fingerprint of what the Live page shows: the newest signal, the newest fill
 * (buys, sells, settlements), the latest position change (incl. price marks), the last
 * engine run (the tick lease row is touched on every run, also cron-only with
 * ENGINE_LOOP=off, where the runner's status is never written) and the last real-time
 * batch. The page polls it and re-renders only when it changes (UI-08).
 */
export async function getLiveVersion(): Promise<string> {
  const db = getDb();
  const [[latest], status] = await Promise.all([
    db
      .select({
        signal: sql<string | null>`(select max(${signals.detectedAt}) from ${signals})::text`,
        fill: sql<string | null>`(select max(${paperFills.ts}) from ${paperFills})::text`,
        position: sql<
          string | null
        >`(select max(${paperPositions.updatedAt}) from ${paperPositions})::text`,
        tick: sql<
          string | null
        >`(select ${appSettings.updatedAt} from ${appSettings} where ${appSettings.key} = 'lease:tick')::text`,
      })
      .from(sql`(select 1) as one`),
    readEngineStatus(db),
  ]);
  return [
    latest?.signal,
    latest?.fill,
    latest?.position,
    latest?.tick,
    status.lastTickAt,
    status.lastStreamBatchAt,
  ].join("|");
}
