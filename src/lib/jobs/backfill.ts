/**
 * Backfill: download each candidate's positions and PnL history, then resolve markets so
 * every finished position is marked won/lost.
 *
 * Verified against the live API: losing positions that were never redeemed stay under
 * status OPEN/REDEEMABLE (current_price 0) rather than CLOSED, so BOTH lists are
 * fetched — using CLOSED alone would hide most losses.
 */
import { and, eq, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import { markets, traderPnlDaily, traderPositions, traders, traderTrades } from "@/lib/db/schema";
import { collect, getPositions, getUserPnl, paginate, type Position } from "@/lib/polymarket/data";
import { getMarketsByConditionIds, winnerIndex } from "@/lib/polymarket/gamma";

import { chunk, toDate } from "./util";

export interface BackfillOptions {
  /** Max positions fetched per status per trader (bounds work and storage). */
  maxPositionsPerStatus: number;
}

export const DEFAULT_BACKFILL: BackfillOptions = { maxPositionsPerStatus: 1000 };

function positionRow(p: Position): typeof traderPositions.$inferInsert {
  const sharesBought = p.total_size ?? p.current_size;
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
    totalCost: sharesBought * p.avg_price,
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

  // De-duplicate by token (a position can move between lists between requests).
  const byToken = new Map<string, typeof traderPositions.$inferInsert>();
  for (const p of [...closed, ...open]) byToken.set(p.token_id, positionRow(p));
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

  // Daily cumulative PnL (economic = realized + unrealized + income − fees).
  const byDay = new Map<string, number>();
  for (const pt of pnl) {
    const value = pt.economic_pnl ?? pt.realized_pnl;
    if (value === null || value === undefined) continue;
    byDay.set(new Date(pt.timestamp * 1000).toISOString().slice(0, 10), value);
  }
  await db.delete(traderPnlDaily).where(eq(traderPnlDaily.wallet, wallet));
  const pnlRows = [...byDay].map(([day, value]) => ({ wallet, day, pnl: value }));
  for (const part of chunk(pnlRows, 1000)) await db.insert(traderPnlDaily).values(part);

  await db.update(traders).set({ lastBackfillAt: new Date() }).where(eq(traders.wallet, wallet));
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
        or(isNull(markets.conditionId), isNull(markets.winnerIndex)),
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
        closed: m.closed ?? false,
        outcomes: m.outcomes,
        tokenIds: m.clobTokenIds,
        winnerIndex: winner,
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
          winnerIndex: sql`excluded.winner_index`,
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

/**
 * Remove bulky history for wallets that were rejected. Their score row stays (so the UI
 * can explain why), and `lastBackfillAt` is cleared so later scoring runs skip them
 * instead of re-scoring an empty history.
 */
export async function prunePositions(db: Db, wallets: string[]): Promise<number> {
  let removed = 0;
  for (const part of chunk(wallets, 500)) {
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
): Promise<{ markets: number; trades: number }> {
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
  return { markets: affectedRows(orphanMarkets), trades: oldTrades.length };
}

/** Row count from a raw `execute` result (postgres-js and PGlite report it differently). */
function affectedRows(result: unknown): number {
  const r = result as { count?: number; affectedRows?: number };
  return r.count ?? r.affectedRows ?? 0;
}
