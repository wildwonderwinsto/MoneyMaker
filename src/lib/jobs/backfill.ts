/**
 * Backfill: download each candidate's positions and PnL history, then resolve markets so
 * every finished position is marked won/lost.
 *
 * Verified against the live API: losing positions that were never redeemed stay under
 * status OPEN/REDEEMABLE (current_price 0) rather than CLOSED, so BOTH lists are
 * fetched — using CLOSED alone would hide most losses.
 */
import { and, eq, gte, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import {
  follows,
  leaderboardSnapshots,
  markets,
  paperPositions,
  traderPnlDaily,
  traderPositions,
  traders,
  traderTrades,
} from "@/lib/db/schema";
import { collect, getPositions, getUserPnl, paginate, type Position } from "@/lib/polymarket/data";
import {
  gammaTime,
  getMarketsByConditionIds,
  resolvedPayouts,
  winnerIndex,
} from "@/lib/polymarket/gamma";

import { chunk, toDate, toEpoch } from "./util";

export interface BackfillOptions {
  /** Max positions fetched per status per trader (bounds work and storage). */
  maxPositionsPerStatus: number;
}

export const DEFAULT_BACKFILL: BackfillOptions = { maxPositionsPerStatus: 1000 };

/**
 * A trader's usual stake: the median dollars put into one market over the last 90 days
 * (all fetched positions if fewer than 5 recent ones). Only stakes the copy engine would
 * copy count (≥ `minUsd`). Null with too little data. Pure (tested).
 */
export function typicalStake(
  positions: Array<{ cost: number; firstEntryAt: number | null }>,
  now: number,
  minUsd = 25,
): number | null {
  const big = positions.filter((p) => p.cost >= minUsd);
  const recent = big.filter((p) => (p.firstEntryAt ?? 0) >= now - 90 * 86_400);
  const pool = recent.length >= 5 ? recent : big;
  if (pool.length < 5) return null;
  const sorted = pool.map((p) => p.cost).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Cheap re-check (owner decision 2026-11-09): only the positions opened since `from` (the
 * holdout start). Lists come newest-first by last event, so fetching stops at the first
 * position last active before `from`. Stored like a full backfill; pruned after scoring.
 * With `keepOlder` (a wallet prunePositions would keep) the positions opened before `from`
 * stay stored: only the post-pick ones are replaced.
 */
export async function backfillPostPick(
  db: Db,
  wallet: string,
  from: number,
  keepOlder = false,
): Promise<number> {
  const since = async (status: "OPEN" | "CLOSED") => {
    const out: Position[] = [];
    for await (const p of paginate(
      (cursor) => getPositions({ user: wallet, status, cursor, sortBy: "TIMESTAMP" }),
      { maxItems: DEFAULT_BACKFILL.maxPositionsPerStatus },
    )) {
      if ((p.last_event_at ?? Infinity) < from) break;
      out.push(p);
    }
    return out;
  };
  const [closed, open] = await Promise.all([since("CLOSED"), since("OPEN")]);
  const byToken = new Map<string, typeof traderPositions.$inferInsert>();
  for (const p of [...closed, ...open]) {
    const row = positionRow(p);
    if (row.firstEntryAt && row.firstEntryAt.getTime() >= from * 1000) byToken.set(p.token_id, row);
  }
  const rows = [...byToken.values()];
  if (keepOlder) {
    // Post-pick rows are replaced (by start time, and by token in case a start time moved).
    await db
      .delete(traderPositions)
      .where(
        and(
          eq(traderPositions.wallet, wallet),
          gte(traderPositions.firstEntryAt, new Date(from * 1000)),
        ),
      );
    for (const part of chunk([...byToken.keys()], 400)) {
      await db
        .delete(traderPositions)
        .where(and(eq(traderPositions.wallet, wallet), inArray(traderPositions.tokenId, part)));
    }
  } else {
    await db.delete(traderPositions).where(eq(traderPositions.wallet, wallet));
  }
  for (const part of chunk(rows, 400)) await db.insert(traderPositions).values(part);
  return rows.length;
}

function positionRow(p: Position): typeof traderPositions.$inferInsert {
  // total_size counts bought shares only: it is 0 (not null) when they came from a split.
  // Then the shares still held are the best known lower bound, unless the position is
  // CLOSED: its leftover dust says nothing about what was paid. Otherwise cost is unknown.
  const sharesBought = p.total_size || (p.status === "CLOSED" ? null : p.current_size) || null;
  return {
    wallet: p.proxy_wallet.toLowerCase(),
    conditionId: p.condition_id,
    tokenId: p.token_id,
    outcome: p.outcome ?? null,
    outcomeIndex: p.outcome_index ?? null,
    status: p.status,
    avgPrice: p.avg_price,
    size: p.current_size,
    sharesBought,
    totalCost: sharesBought === null ? null : sharesBought * p.avg_price,
    realizedPnl: p.realized_pnl,
    unrealizedPnl: p.unrealized_pnl ?? 0,
    currentValue: p.current_value ?? 0,
    title: p.title ?? null,
    slug: p.slug ?? null,
    eventId: p.event_id ?? null,
    endDate: p.end_date ? new Date(p.end_date) : null,
    firstEntryAt: toDate(p.first_entry_at),
    lastActivityAt: toDate(p.last_event_at),
  };
}

/**
 * A trader's latest positions straight from Polymarket's lists (newest first), shaped like
 * stored rows, for a trader page with nothing stored (Candidates are pruned). Like the
 * stored list, positions of unknown cost (shares from splits) are left out. Pure (tested).
 */
export function recentPositions(open: Position[], closed: Position[], limit: number) {
  const byToken = new Map<string, ReturnType<typeof positionRow> & { won: boolean | null }>();
  for (const p of [...closed, ...open]) {
    const won = p.status === "REDEEMABLE" ? true : p.status === "REDEEMABLE_LOST" ? false : null;
    byToken.set(p.token_id, { ...positionRow(p), won });
  }
  return [...byToken.values()]
    .filter((r) => (r.totalCost ?? 0) > 0)
    .sort((a, b) => (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0))
    .slice(0, limit);
}

/** Live recent positions for one trader (2 requests: newest open, newest closed). */
export async function fetchRecentPositions(wallet: string, limit = 40) {
  const page = (status: "OPEN" | "CLOSED") =>
    getPositions({ user: wallet, status, limit, sortBy: "TIMESTAMP" }).then((r) => r.data);
  const [open, closed] = await Promise.all([page("OPEN"), page("CLOSED")]);
  return recentPositions(open, closed, limit);
}

/**
 * How a position ended, for display: settled (won/lost), exited before settling (sold: the
 * API's CLOSED, or no shares left), or still open. A sold position used to read "Open".
 * Stored rows get won/lost from the market's outcome, so CLOSED without one was sold. A
 * live row can't tell: Polymarket's CLOSED list also holds settled-and-redeemed positions,
 * so it is just "closed" (its P&L says how it went).
 */
export function positionResult(
  p: { won: boolean | null; status?: string | null; size?: number | null },
  opts: { live?: boolean } = {},
): "won" | "lost" | "sold" | "closed" | "open" {
  if (p.won === true) return "won";
  if (p.won === false) return "lost";
  if (p.status === "CLOSED" || (p.size ?? 0) < 1e-6) return opts.live ? "closed" : "sold";
  return "open";
}

export async function backfillTrader(
  db: Db,
  wallet: string,
  opts: BackfillOptions,
): Promise<{ positions: number; pnlPoints: number }> {
  // IMPORTANT: the API's default order is largest realized PnL first, so capping that list
  // would keep only a trader's best bets. Newest-first makes the cap outcome-neutral.
  const fetchAll = (status: "OPEN" | "CLOSED") =>
    collect(
      paginate((cursor) => getPositions({ user: wallet, status, cursor, sortBy: "TIMESTAMP" }), {
        maxItems: opts.maxPositionsPerStatus,
      }),
    );
  const [closed, open, pnl] = await Promise.all([
    fetchAll("CLOSED"),
    fetchAll("OPEN"),
    getUserPnl({ user: wallet, interval: "all", fidelity: "1d" }),
  ]);

  // Closed positions and past PnL never disappear: an empty answer for a wallet we hold
  // history for is a failed fetch. Keep what's stored rather than wiping it.
  const stored = async (table: typeof traderPositions | typeof traderPnlDaily) =>
    (await db.select({ w: table.wallet }).from(table).where(eq(table.wallet, wallet)).limit(1))
      .length > 0;
  if (closed.length + open.length === 0 && (await stored(traderPositions))) {
    throw new Error(`empty positions answer for ${wallet}; kept the stored history`);
  }
  if (pnl.length === 0 && (await stored(traderPnlDaily))) {
    throw new Error(`empty PnL answer for ${wallet}; kept the stored history`);
  }

  // Both lists come newest-first by last event. A list that hit the cap only reaches back
  // to its oldest row, while the other may go back years (e.g. unclaimed losers with no
  // matching winners), which skews win rates. Keep both to the window complete for both.
  const cutoff = Math.max(
    0,
    ...[closed, open]
      .filter((list) => list.length >= opts.maxPositionsPerStatus)
      .map((list) => Math.min(...list.map((p) => p.last_event_at ?? Infinity))),
  );

  // De-duplicate by token (a position can move between lists between requests).
  const byToken = new Map<string, typeof traderPositions.$inferInsert>();
  for (const p of [...closed, ...open]) {
    if ((p.last_event_at ?? Infinity) >= cutoff) byToken.set(p.token_id, positionRow(p));
  }
  const rows = [...byToken.values()];

  for (const part of chunk(rows, 400)) {
    await db
      .insert(traderPositions)
      .values(part)
      .onConflictDoUpdate({
        target: [traderPositions.wallet, traderPositions.tokenId],
        set: {
          status: sql`excluded.status`,
          avgPrice: sql`excluded.avg_price`,
          size: sql`excluded.size`,
          sharesBought: sql`excluded.shares_bought`,
          totalCost: sql`excluded.total_cost`,
          realizedPnl: sql`excluded.realized_pnl`,
          unrealizedPnl: sql`excluded.unrealized_pnl`,
          currentValue: sql`excluded.current_value`,
          firstEntryAt: sql`excluded.first_entry_at`,
          lastActivityAt: sql`excluded.last_activity_at`,
          updatedAt: new Date(),
        },
      });
  }

  // Keep exactly the latest fetch: rows that fell out of the window (or came from an
  // older, differently sorted fetch) would otherwise linger and skew the metrics.
  const keep = rows.map((r) => r.tokenId);
  await db
    .delete(traderPositions)
    .where(
      keep.length
        ? and(eq(traderPositions.wallet, wallet), notInArray(traderPositions.tokenId, keep))
        : eq(traderPositions.wallet, wallet),
    );

  // Daily cumulative trading PnL (realized + unrealized, after fees). Rebates and rewards
  // are left out: market makers earn them, a copier doesn't, so they'd fake consistency.
  const byDay = new Map<string, number>();
  for (const pt of pnl) {
    const value = pt.position_pnl ?? pt.economic_pnl ?? pt.realized_pnl;
    if (value === null || value === undefined) continue;
    byDay.set(new Date(pt.timestamp * 1000).toISOString().slice(0, 10), value);
  }
  await db.delete(traderPnlDaily).where(eq(traderPnlDaily.wallet, wallet));
  const pnlRows = [...byDay].map(([day, value]) => ({ wallet, day, pnl: value }));
  for (const part of chunk(pnlRows, 1000)) await db.insert(traderPnlDaily).values(part);

  // Last real trade: the last day the cumulative trade count went up.
  const points = [...pnl].sort((a, b) => a.timestamp - b.timestamp);
  let lastTrade: number | null = null;
  for (let i = 1; i < points.length; i++) {
    if ((points[i].trade_count ?? 0) > (points[i - 1].trade_count ?? 0)) {
      lastTrade = points[i].timestamp;
    }
  }
  const stake = typicalStake(
    rows.map((r) => ({ cost: r.totalCost ?? 0, firstEntryAt: toEpoch(r.firstEntryAt) })),
    Date.now() / 1000,
  );
  await db
    .update(traders)
    .set({ lastBackfillAt: new Date(), lastTradeAt: toDate(lastTrade), typicalStakeUsd: stake })
    .where(eq(traders.wallet, wallet));
  return { positions: rows.length, pnlPoints: pnlRows.length };
}

/**
 * Fetch market metadata for positions whose outcome is still unknown and whose end date
 * has passed (or is unknown), then mark positions won/lost.
 */
export async function resolveMarkets(
  db: Db,
  log: (m: string) => void,
): Promise<{ fetched: number; resolved: number }> {
  const pending = await db
    .selectDistinct({ conditionId: traderPositions.conditionId })
    .from(traderPositions)
    .leftJoin(markets, eq(markets.conditionId, traderPositions.conditionId))
    .where(
      and(
        isNull(traderPositions.won),
        or(isNull(traderPositions.endDate), lt(traderPositions.endDate, new Date())),
        // A 50/50 market has no winner but is settled: don't refetch it every day.
        or(isNull(markets.conditionId), and(isNull(markets.winnerIndex), isNull(markets.payouts))),
      ),
    );
  const ids = pending.map((r) => r.conditionId);
  log(`resolving ${ids.length} markets`);

  let fetched = 0;
  for (const part of chunk(ids, 200)) {
    const found = await getMarketsByConditionIds(part);
    fetched += found.length;
    const rows = found.map((m) => {
      const winner = winnerIndex(m);
      return {
        conditionId: m.conditionId,
        question: m.question,
        slug: m.slug ?? null,
        eventId: m.events?.[0]?.id ?? null,
        eventSlug: m.events?.[0]?.slug ?? null,
        image: m.image ?? m.icon ?? null,
        endDate: m.endDate ? new Date(m.endDate) : null,
        gameStartTime: gammaTime(m.gameStartTime),
        closed: m.closed ?? false,
        outcomes: m.outcomes,
        tokenIds: m.clobTokenIds,
        winnerIndex: winner,
        payouts: resolvedPayouts(m),
        resolvedAt: winner === null ? null : m.closedTime ? new Date(m.closedTime) : new Date(),
      };
    });
    if (rows.length === 0) continue;
    await db
      .insert(markets)
      .values(rows)
      .onConflictDoUpdate({
        target: markets.conditionId,
        set: {
          closed: sql`excluded.closed`,
          gameStartTime: sql`coalesce(excluded.game_start_time, ${markets.gameStartTime})`,
          winnerIndex: sql`excluded.winner_index`,
          payouts: sql`excluded.payouts`,
          resolvedAt: sql`excluded.resolved_at`,
          image: sql`excluded.image`,
          updatedAt: new Date(),
        },
      });
  }

  const updated = await db
    .update(traderPositions)
    .set({ won: sql`${markets.winnerIndex} = ${traderPositions.outcomeIndex}` })
    .from(markets)
    .where(
      and(
        eq(markets.conditionId, traderPositions.conditionId),
        isNotNull(markets.winnerIndex),
        isNotNull(traderPositions.outcomeIndex),
        isNull(traderPositions.won),
      ),
    )
    .returning({ id: traderPositions.id });
  log(`fetched ${fetched} markets, marked ${updated.length} positions won/lost`);
  return { fetched, resolved: updated.length };
}

/** Wallets whose history is never dropped: followed (paused too) or with a copy still open. */
export async function keptWallets(db: Db): Promise<Set<string>> {
  const [followed, held] = await Promise.all([
    db.select({ w: follows.wallet }).from(follows),
    db
      .selectDistinct({ w: paperPositions.sourceWallet })
      .from(paperPositions)
      .where(eq(paperPositions.status, "open")),
  ]);
  return new Set([...followed, ...held].map((r) => r.w));
}

/**
 * Remove bulky history for wallets that were rejected. Their score row stays (so the UI
 * can explain why), and `lastBackfillAt` is cleared so later scoring runs skip them
 * instead of re-scoring an empty history. Followed traders (paused too) and traders whose
 * copy we still hold are never pruned: their page and sizing need that history.
 */
export async function prunePositions(db: Db, wallets: string[]): Promise<number> {
  const keep = await keptWallets(db);
  let removed = 0;
  for (const part of chunk(
    wallets.filter((w) => !keep.has(w)),
    500,
  )) {
    const res = await db
      .delete(traderPositions)
      .where(inArray(traderPositions.wallet, part))
      .returning({ id: traderPositions.id });
    removed += res.length;
    await db.delete(traderPnlDaily).where(inArray(traderPnlDaily.wallet, part));
    await db.update(traders).set({ lastBackfillAt: null }).where(inArray(traders.wallet, part));
  }
  return removed;
}

/**
 * Keep the database inside the Supabase free tier (500 MB): drop markets nothing refers
 * to any more and raw trades older than `tradeRetentionDays`.
 */
export async function cleanupStorage(
  db: Db,
  tradeRetentionDays = 120,
  // Only the baseline reads snapshots (last 6 h); owner approved 30 days (2026-11-08).
  snapshotRetentionDays = 30,
  // Owner, 2026-11-09: Rejected wallets' scores (~2.8 KB each, ~170 new a day). Only the last
  // 30 days feed the pooled skill test; the cool-down uses traders.last_checked_at; rotation
  // and the backtest read other tiers. Followed (even paused) and hidden wallets keep theirs
  // (their pages and the Hidden list join scores).
  rejectedScoreRetentionDays = 30,
  // Batch 6: a wallet re-picked after its cool-down starts a fresh holdout, and evidence
  // from an older holdout is never reused (withRunningEvidence), so a rejected wallet's
  // running evidence is dropped once its cool-down (rotation cooldownDays, 30) is over.
  rejectedEvidenceAfterDays = 30,
): Promise<{
  markets: number;
  trades: number;
  snapshots: number;
  scores: number;
  evidence: number;
}> {
  const orphanMarkets = await db.execute(sql`
    delete from markets m
    where not exists (select 1 from trader_positions p where p.condition_id = m.condition_id)
      and not exists (select 1 from paper_positions pp where pp.condition_id = m.condition_id)
      and not exists (select 1 from signals s where s.condition_id = m.condition_id)
  `);
  const cutoff = new Date(Date.now() - tradeRetentionDays * 86_400_000);
  const oldTrades = await db
    .delete(traderTrades)
    .where(lt(traderTrades.ts, cutoff))
    .returning({ id: traderTrades.id });
  // Leaderboard history (~6k rows/day) is useful for a while, then just costs space.
  const oldSnapshots = await db
    .delete(leaderboardSnapshots)
    .where(
      lt(
        leaderboardSnapshots.capturedAt,
        new Date(Date.now() - snapshotRetentionDays * 86_400_000),
      ),
    )
    .returning({ id: leaderboardSnapshots.id });
  const oldScores = await db.execute(sql`
    delete from trader_scores s
    where s.tier = 'rejected'
      and s.computed_at < ${new Date(Date.now() - rejectedScoreRetentionDays * 86_400_000).toISOString()}::timestamptz
      and not exists (select 1 from follows f where f.wallet = s.wallet)
      and not exists (select 1 from hidden_traders h where h.wallet = s.wallet)
  `);
  // No score row left means it was a rejected one (only those are deleted, above).
  const oldEvidence = await db.execute(sql`
    delete from skill_evidence e
    where not exists (
        select 1 from trader_scores s where s.wallet = e.wallet and s.tier <> 'rejected'
      )
      and coalesce(
        (select t.last_checked_at from traders t where t.wallet = e.wallet),
        e.updated_at
      ) < ${new Date(Date.now() - rejectedEvidenceAfterDays * 86_400_000).toISOString()}::timestamptz
      and not exists (select 1 from follows f where f.wallet = e.wallet)
      and not exists (select 1 from hidden_traders h where h.wallet = e.wallet)
  `);
  return {
    markets: affectedRows(orphanMarkets),
    trades: oldTrades.length,
    snapshots: oldSnapshots.length,
    scores: affectedRows(oldScores),
    evidence: affectedRows(oldEvidence),
  };
}

/** Row count from a raw `execute` result (postgres-js and PGlite report it differently). */
function affectedRows(result: unknown): number {
  const r = result as { count?: number; affectedRows?: number };
  return r.count ?? r.affectedRows ?? 0;
}
