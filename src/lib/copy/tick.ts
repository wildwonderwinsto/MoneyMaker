/**
 * One copy-engine tick (called every minute by cron-job.org via /api/cron/tick):
 *   1. pull new trades from every followed leader (cursor per leader, idempotent)
 *   2. decide + simulate fills against the live order book, record every decision
 *   3. settle resolved positions, mark open ones to market, snapshot equity
 * A database lease guarantees only one tick runs at a time.
 */
import { and, eq, inArray } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import { cursors, follows, paperPositions, signals } from "@/lib/db/schema";
import { acquireLease, releaseLease } from "@/lib/lease";
import { getBook, getMidpoints, type OrderBook } from "@/lib/polymarket/clob";
import {
  getActivity,
  getPortfolioValue,
  getPositions,
  tradeId,
  type Activity,
} from "@/lib/polymarket/data";
import { getRiskConfig } from "@/lib/settings";

import {
  applyBuy,
  applySell,
  dailyLossPct,
  ensureDefaultAccount,
  exposure,
  loadAccountState,
  maybeSnapshot,
  settlePosition,
} from "./account";
import type { RiskConfig } from "./config";
import { decideBuy, decideSell, type Decision, type LeaderTrade, type MarketInfo } from "./engine";
import { getMarketInfo } from "./markets";

export interface TickStats {
  skipped?: string;
  leaders: number;
  newTrades: number;
  copied: number;
  closed: number;
  ignored: number;
  settled: number;
  errors: string[];
  durationMs: number;
}

const LEASE = "tick";
const LEASE_TTL_MS = 4 * 60_000;

export function toLeaderTrade(a: Activity): LeaderTrade | null {
  if (!a.token_id || (a.side !== "BUY" && a.side !== "SELL") || a.price == null) return null;
  return {
    id: tradeId(a),
    wallet: a.proxy_wallet.toLowerCase(),
    ts: a.timestamp,
    conditionId: a.condition_id,
    tokenId: a.token_id,
    side: a.side,
    price: a.price,
    size: a.size,
    usdc: a.usdc_size,
    outcome: a.outcome ?? null,
    title: a.title ?? null,
    slug: a.slug ?? null,
  };
}

export async function runTick(db: Db, nowMs = Date.now()): Promise<TickStats> {
  const started = Date.now();
  const stats: TickStats = {
    leaders: 0,
    newTrades: 0,
    copied: 0,
    closed: 0,
    ignored: 0,
    settled: 0,
    errors: [],
    durationMs: 0,
  };
  if (!(await acquireLease(db, LEASE, LEASE_TTL_MS))) {
    return { ...stats, skipped: "Another tick is still running" };
  }
  try {
    const cfg = await getRiskConfig(db);
    const account = await ensureDefaultAccount(db);
    const now = Math.floor(nowMs / 1000);

    const leaders = await db.select().from(follows).where(eq(follows.enabled, true));
    stats.leaders = leaders.length;
    const cursorRows = leaders.length
      ? await db
          .select()
          .from(cursors)
          .where(
            inArray(
              cursors.wallet,
              leaders.map((l) => l.wallet),
            ),
          )
      : [];
    const cursorOf = new Map(cursorRows.map((c) => [c.wallet, c.lastTs]));
    const portfolioCache = new Map<string, number>();

    for (const leader of leaders) {
      try {
        await processLeader(db, {
          accountId: account.id,
          leader,
          cursor: cursorOf.get(leader.wallet) ?? null,
          now,
          cfg,
          stats,
          portfolioCache,
        });
      } catch (err) {
        stats.errors.push(`${leader.wallet}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    try {
      stats.settled = await settleAndMark(db, account.id);
    } catch (err) {
      stats.errors.push(`settle: ${err instanceof Error ? err.message : String(err)}`);
    }
    await maybeSnapshot(db, account.id);
  } finally {
    await releaseLease(db, LEASE);
  }
  stats.durationMs = Date.now() - started;
  return stats;
}

interface LeaderContext {
  accountId: number;
  leader: typeof follows.$inferSelect;
  cursor: number | null;
  now: number;
  cfg: RiskConfig;
  stats: TickStats;
  portfolioCache: Map<string, number>;
}

async function setCursor(db: Db, wallet: string, lastTs: number) {
  await db
    .insert(cursors)
    .values({ wallet, lastTs })
    .onConflictDoUpdate({ target: cursors.wallet, set: { lastTs, updatedAt: new Date() } });
}

async function processLeader(db: Db, ctx: LeaderContext) {
  const { leader, now, stats } = ctx;
  // First sighting: start watching from now; never copy history.
  if (ctx.cursor === null) {
    await setCursor(db, leader.wallet, now);
    return;
  }

  const page = await getActivity({
    user: leader.wallet,
    type: "TRADE",
    start: ctx.cursor,
    sortDirection: "ASC",
    limit: 200,
  });
  const trades = page.data
    .map(toLeaderTrade)
    .filter((t): t is LeaderTrade => t !== null && t.ts >= ctx.cursor!);
  if (trades.length === 0) return;

  // `start` is inclusive, so skip anything already recorded.
  const seen = new Set(
    (
      await db
        .select({ id: signals.id })
        .from(signals)
        .where(
          inArray(
            signals.id,
            trades.map((t) => t.id),
          ),
        )
    ).map((r) => r.id),
  );
  const fresh = trades.filter((t) => !seen.has(t.id));
  stats.newTrades += fresh.length;

  const marketInfo = await getMarketInfo(
    db,
    fresh.map((t) => t.conditionId),
  );
  const books = new Map<string, OrderBook | null>();
  const bookFor = async (tokenId: string) => {
    if (!books.has(tokenId)) books.set(tokenId, await getBook(tokenId).catch(() => null));
    return books.get(tokenId)!;
  };

  for (const trade of fresh) {
    const market = marketInfo.get(trade.conditionId) ?? null;
    const decision =
      trade.side === "BUY"
        ? await decideBuyFor(db, ctx, trade, market, await bookFor(trade.tokenId))
        : await decideSellFor(db, ctx, trade, bookFor);
    await recordDecision(db, ctx.accountId, trade, market, decision);
    if (decision.action === "buy") stats.copied++;
    else if (decision.action === "sell") stats.closed++;
    else stats.ignored++;
  }

  await setCursor(db, leader.wallet, Math.max(...trades.map((t) => t.ts)));
}

async function decideBuyFor(
  db: Db,
  ctx: LeaderContext,
  trade: LeaderTrade,
  market: MarketInfo | null,
  book: OrderBook | null,
): Promise<Decision> {
  const state = await loadAccountState(db, ctx.accountId);
  if (!ctx.portfolioCache.has(trade.wallet)) {
    ctx.portfolioCache.set(trade.wallet, await getPortfolioValue(trade.wallet).catch(() => 0));
  }
  const exp = exposure(state, trade.conditionId, trade.wallet);
  return decideBuy({
    now: ctx.now,
    trade,
    market,
    book,
    equity: state.equity,
    cash: state.cash,
    leaderPortfolioUsd: ctx.portfolioCache.get(trade.wallet)!,
    weight: ctx.leader.weight,
    marketExposure: exp.market,
    traderExposure: exp.trader,
    dailyLossPct: await dailyLossPct(db, ctx.accountId, state.equity),
    cfg: ctx.cfg,
  });
}

async function openPositionFor(db: Db, accountId: number, trade: LeaderTrade) {
  const [position] = await db
    .select()
    .from(paperPositions)
    .where(
      and(
        eq(paperPositions.accountId, accountId),
        eq(paperPositions.tokenId, trade.tokenId),
        eq(paperPositions.sourceWallet, trade.wallet),
        eq(paperPositions.status, "open"),
      ),
    );
  return position ?? null;
}

async function decideSellFor(
  db: Db,
  ctx: LeaderContext,
  trade: LeaderTrade,
  bookFor: (tokenId: string) => Promise<OrderBook | null>,
): Promise<Decision> {
  const position = await openPositionFor(db, ctx.accountId, trade);
  if (!position) return { action: "skip", reason: "No copied position to close" };
  // What share of their position did they sell? remaining is read after the sell.
  const res = await getPositions({ user: trade.wallet, condition: trade.conditionId });
  const remaining = res.data.find((p) => p.token_id === trade.tokenId)?.current_size ?? 0;
  const fraction = trade.size / (remaining + trade.size);
  return decideSell({
    trade,
    ourShares: position.shares,
    leaderSoldFraction: fraction,
    book: await bookFor(trade.tokenId),
    cfg: ctx.cfg,
  });
}

async function recordDecision(
  db: Db,
  accountId: number,
  trade: LeaderTrade,
  market: MarketInfo | null,
  decision: Decision,
) {
  const reason =
    decision.action === "buy"
      ? `Bought ${decision.fill.shares.toFixed(1)} @ ${(decision.fill.avgPrice * 100).toFixed(1)}¢ ($${decision.fill.notional.toFixed(2)})`
      : decision.action === "sell"
        ? `Sold ${Math.round(decision.fraction * 100)}% (${decision.fill.shares.toFixed(1)} @ ${(decision.fill.avgPrice * 100).toFixed(1)}¢)`
        : decision.reason;

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(signals)
      .values({
        id: trade.id,
        wallet: trade.wallet,
        leaderTs: new Date(trade.ts * 1000),
        conditionId: trade.conditionId,
        tokenId: trade.tokenId,
        outcome: trade.outcome,
        side: trade.side,
        leaderPrice: trade.price,
        leaderSize: trade.size,
        leaderUsdc: trade.usdc,
        title: market?.question ?? trade.title,
        slug: market?.slug ?? trade.slug,
        image: market?.image ?? null,
        decision:
          decision.action === "buy" ? "copied" : decision.action === "sell" ? "closed" : "skipped",
        reason,
        accountId,
      })
      .onConflictDoNothing()
      .returning({ id: signals.id });
    // Lost the race to a concurrent insert: the other writer already applied it.
    if (inserted.length === 0) return;

    if (decision.action === "buy" && market) {
      await applyBuy(tx, accountId, trade, market, decision.fill);
    } else if (decision.action === "sell") {
      const [position] = await tx
        .select()
        .from(paperPositions)
        .where(
          and(
            eq(paperPositions.accountId, accountId),
            eq(paperPositions.tokenId, trade.tokenId),
            eq(paperPositions.sourceWallet, trade.wallet),
            eq(paperPositions.status, "open"),
          ),
        );
      if (position) await applySell(tx, position, trade, decision.fill);
    }
  });
}

/** Settle resolved markets at $1/$0 and refresh prices of the rest. Returns # settled. */
async function settleAndMark(db: Db, accountId: number): Promise<number> {
  const open = await db
    .select()
    .from(paperPositions)
    .where(and(eq(paperPositions.accountId, accountId), eq(paperPositions.status, "open")));
  if (open.length === 0) return 0;

  const info = await getMarketInfo(
    db,
    open.map((p) => p.conditionId),
  );
  let settled = 0;
  const live: typeof open = [];
  for (const p of open) {
    const m = info.get(p.conditionId);
    if (m && m.winnerIndex !== null && m.tokenIds.length > 0) {
      const won = m.tokenIds[m.winnerIndex] === p.tokenId;
      await db.transaction((tx) => settlePosition(tx, p, won));
      settled++;
    } else {
      live.push(p);
    }
  }

  if (live.length > 0) {
    const mids = await getMidpoints(live.map((p) => p.tokenId));
    for (const p of live) {
      const mid = mids.get(p.tokenId);
      if (mid === undefined) continue;
      await db
        .update(paperPositions)
        .set({ currentPrice: mid, updatedAt: new Date() })
        .where(eq(paperPositions.id, p.id));
    }
  }
  return settled;
}
