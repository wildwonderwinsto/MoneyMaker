/**
 * Personal bets (owner, 2026-11-26): paper bets placed by hand on any Polymarket market, in
 * portfolios kept apart from the copy engine's account. Fills walk the live order book like
 * copies do (slippage and taker fees included); bets settle at the market's payout.
 *
 * Polymarket data (books, midpoints, resolutions) is passed in, so this file only does the
 * bookkeeping and tests run without the network.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { simulateBuy, simulateSell } from "@/lib/copy/fillSim";
import type { Db } from "@/lib/db/client";
import { customBets, customFills, customPortfolios, customSnapshots } from "@/lib/db/schema";
import type { BookLevel } from "@/lib/polymarket/clob";

export type Portfolio = typeof customPortfolios.$inferSelect;
export type CustomBet = typeof customBets.$inferSelect;
export type CustomFill = typeof customFills.$inferSelect;

export const MAX_PORTFOLIOS = 20;
export const MIN_BET_USD = 1;
/** Never pay more than this per share (a 99¢ share can only make 1¢). */
const BUY_LIMIT = 0.99;
const SNAPSHOT_EVERY_MS = 5 * 60_000;

export class BetError extends Error {}

const markValue = (b: CustomBet) => b.shares * (b.currentPrice ?? b.avgPrice);

export async function listPortfolios(db: Db): Promise<Portfolio[]> {
  return db.select().from(customPortfolios).orderBy(asc(customPortfolios.id));
}

export async function createPortfolio(db: Db, name: string, balance: number): Promise<Portfolio> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(customPortfolios);
  if (n >= MAX_PORTFOLIOS) throw new BetError(`At most ${MAX_PORTFOLIOS} portfolios`);
  const [created] = await db
    .insert(customPortfolios)
    .values({ name, startingBalance: balance, cash: balance })
    .returning();
  await snapshot(db, created.id, 0);
  return created;
}

export async function deletePortfolio(db: Db, id: number): Promise<boolean> {
  const gone = await db
    .delete(customPortfolios)
    .where(eq(customPortfolios.id, id))
    .returning({ id: customPortfolios.id });
  return gone.length > 0;
}

/** Erase every bet and restore the balance (optionally a new one). */
export async function resetPortfolio(db: Db, id: number, balance: number): Promise<void> {
  await db.transaction(async (tx) => {
    // Fills and snapshots go with their bets / portfolio via the cascades.
    await tx.delete(customBets).where(eq(customBets.portfolioId, id));
    await tx.delete(customSnapshots).where(eq(customSnapshots.portfolioId, id));
    await tx
      .update(customPortfolios)
      .set({ startingBalance: balance, cash: balance, resetAt: new Date() })
      .where(eq(customPortfolios.id, id));
  });
  await snapshot(db, id, 0);
}

/** What placing a bet needs to know about the market. */
export interface BetMarket {
  conditionId: string;
  tokenId: string;
  outcomeIndex: number;
  outcome: string;
  title: string;
  slug: string | null;
  eventSlug: string | null;
  image: string | null;
  feeRate: number;
}

export interface BetResult {
  bet: CustomBet;
  shares: number;
  avgPrice: number;
  cost: number;
  partial: boolean;
}

/** Buy `usd` worth (fees included) of one outcome at the asks right now. */
export async function placeBet(
  db: Db,
  portfolioId: number,
  market: BetMarket,
  usd: number,
  asks: BookLevel[],
): Promise<BetResult> {
  if (!(usd >= MIN_BET_USD)) throw new BetError(`Bets start at $${MIN_BET_USD}`);
  return db.transaction(async (tx) => {
    const [p] = await tx
      .select()
      .from(customPortfolios)
      .where(eq(customPortfolios.id, portfolioId))
      .for("update");
    if (!p) throw new BetError("Portfolio not found");
    if (usd > p.cash + 1e-9) {
      throw new BetError(`Not enough cash: $${p.cash.toFixed(2)} left`);
    }
    const fill = simulateBuy(asks, usd, BUY_LIMIT, 0, market.feeRate);
    if (fill.shares <= 0) throw new BetError("Nobody is selling this outcome under 99¢ right now");
    const [bet] = await tx
      .insert(customBets)
      .values({
        portfolioId,
        conditionId: market.conditionId,
        tokenId: market.tokenId,
        outcomeIndex: market.outcomeIndex,
        outcome: market.outcome,
        title: market.title,
        slug: market.slug,
        eventSlug: market.eventSlug,
        image: market.image,
        feeRate: market.feeRate,
        shares: fill.shares,
        avgPrice: fill.notional / fill.shares,
        costBasis: fill.notional,
        currentPrice: fill.avgPrice,
      })
      .returning();
    await tx
      .update(customPortfolios)
      .set({ cash: sql`${customPortfolios.cash} - ${fill.notional}` })
      .where(eq(customPortfolios.id, portfolioId));
    await tx.insert(customFills).values({
      portfolioId,
      betId: bet.id,
      kind: "trade",
      side: "BUY",
      shares: fill.shares,
      avgPrice: fill.avgPrice,
      notional: fill.notional,
      fee: fill.fee,
    });
    return {
      bet,
      shares: fill.shares,
      avgPrice: fill.avgPrice,
      cost: fill.notional,
      partial: fill.partial,
    };
  });
}

export async function getBet(db: Db, betId: number): Promise<CustomBet | null> {
  const [bet] = await db.select().from(customBets).where(eq(customBets.id, betId));
  return bet ?? null;
}

export interface SellResult {
  shares: number;
  proceeds: number;
  pnl: number;
  /** Shares still held (the bids ran out first). */
  left: number;
}

/** Sell the whole bet into the bids right now; whatever the book can't take stays open. */
export async function sellBet(db: Db, betId: number, bids: BookLevel[]): Promise<SellResult> {
  return db.transaction(async (tx) => {
    const [bet] = await tx.select().from(customBets).where(eq(customBets.id, betId)).for("update");
    if (!bet || bet.status !== "open" || bet.shares <= 0) {
      throw new BetError("This bet is no longer open");
    }
    const fill = simulateSell(bids, bet.shares, 0, 0, bet.feeRate);
    if (fill.shares <= 0) throw new BetError("Nobody is buying this outcome right now");
    const sold = Math.min(fill.shares, bet.shares);
    const costPortion = bet.costBasis * (sold / bet.shares);
    const pnl = fill.notional - costPortion;
    const left = bet.shares - sold;
    const done = left < 1e-6;
    await tx
      .update(customBets)
      .set({
        shares: done ? 0 : left,
        costBasis: done ? 0 : bet.costBasis - costPortion,
        realizedPnl: bet.realizedPnl + pnl,
        currentPrice: fill.avgPrice,
        status: done ? "closed" : "open",
        closedAt: done ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(customBets.id, bet.id));
    await tx
      .update(customPortfolios)
      .set({ cash: sql`${customPortfolios.cash} + ${fill.notional}` })
      .where(eq(customPortfolios.id, bet.portfolioId));
    await tx.insert(customFills).values({
      portfolioId: bet.portfolioId,
      betId: bet.id,
      kind: "trade",
      side: "SELL",
      shares: sold,
      avgPrice: fill.avgPrice,
      notional: fill.notional,
      fee: fill.fee,
      realizedPnl: pnl,
    });
    return { shares: sold, proceeds: fill.notional, pnl, left: done ? 0 : left };
  });
}

/** Pay out a bet at the market's resolution (USDC per share: 1, 0 or 0.5). */
async function settleBet(db: Db, betId: number, payoutPerShare: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [bet] = await tx.select().from(customBets).where(eq(customBets.id, betId)).for("update");
    if (!bet || bet.status !== "open") return;
    const payout = bet.shares * payoutPerShare;
    const pnl = payout - bet.costBasis;
    await tx
      .update(customBets)
      .set({
        shares: 0,
        costBasis: 0,
        currentPrice: payoutPerShare,
        realizedPnl: bet.realizedPnl + pnl,
        status: "settled",
        closedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(customBets.id, bet.id));
    await tx
      .update(customPortfolios)
      .set({ cash: sql`${customPortfolios.cash} + ${payout}` })
      .where(eq(customPortfolios.id, bet.portfolioId));
    await tx.insert(customFills).values({
      portfolioId: bet.portfolioId,
      betId: bet.id,
      kind: "settlement",
      side: payoutPerShare >= 1 ? "WIN" : payoutPerShare <= 0 ? "LOSS" : "SPLIT",
      shares: bet.shares,
      avgPrice: payoutPerShare,
      notional: payout,
      fee: 0,
      realizedPnl: pnl,
    });
  });
}

/** Live data for open bets, fetched by the caller. */
export interface MarketData {
  /** Midpoint per token id. */
  mids: Map<string, number>;
  /** Payout per outcome for each resolved condition id (unresolved ones are absent). */
  payouts: Map<string, number[]>;
}

/**
 * Bring every open bet up to date: settle the resolved ones, mark the rest at the midpoint,
 * then record equity if the last snapshot is older than five minutes.
 */
export async function refreshBets(db: Db, open: CustomBet[], data: MarketData): Promise<number> {
  let settled = 0;
  const now = new Date();
  for (const bet of open) {
    const payouts = data.payouts.get(bet.conditionId);
    const payout = payouts?.[bet.outcomeIndex];
    if (payout !== undefined) {
      await settleBet(db, bet.id, payout);
      settled++;
      continue;
    }
    const mid = data.mids.get(bet.tokenId);
    if (mid !== undefined && mid !== bet.currentPrice) {
      await db
        .update(customBets)
        .set({ currentPrice: mid, updatedAt: now })
        .where(and(eq(customBets.id, bet.id), eq(customBets.status, "open")));
    }
  }
  return settled;
}

export async function openBets(db: Db, portfolioIds?: number[]): Promise<CustomBet[]> {
  const open = eq(customBets.status, "open");
  return db
    .select()
    .from(customBets)
    .where(portfolioIds ? and(open, inArray(customBets.portfolioId, portfolioIds)) : open);
}

/** Record equity now, unless the last snapshot is younger than `everyMs` (0 = always). */
export async function snapshot(db: Db, portfolioId: number, everyMs = SNAPSHOT_EVERY_MS) {
  const [last] = await db
    .select({ ts: customSnapshots.ts })
    .from(customSnapshots)
    .where(eq(customSnapshots.portfolioId, portfolioId))
    .orderBy(desc(customSnapshots.ts))
    .limit(1);
  if (last && everyMs > 0 && Date.now() - last.ts.getTime() < everyMs) return false;
  const [p] = await db.select().from(customPortfolios).where(eq(customPortfolios.id, portfolioId));
  if (!p) return false;
  const open = await openBets(db, [portfolioId]);
  const positionsValue = open.reduce((a, b) => a + markValue(b), 0);
  await db
    .insert(customSnapshots)
    .values({
      portfolioId,
      ts: new Date(),
      equity: p.cash + positionsValue,
      cash: p.cash,
      positionsValue,
    })
    .onConflictDoNothing();
  return true;
}

export interface PortfolioSummary {
  portfolio: Portfolio;
  equity: number;
  positionsValue: number;
  totalReturn: number;
  openCount: number;
}

export function summarize(portfolio: Portfolio, open: CustomBet[]): PortfolioSummary {
  const positionsValue = open.reduce((a, b) => a + markValue(b), 0);
  const equity = portfolio.cash + positionsValue;
  return {
    portfolio,
    equity,
    positionsValue,
    totalReturn: portfolio.startingBalance > 0 ? equity / portfolio.startingBalance - 1 : 0,
    openCount: open.length,
  };
}

/** Every portfolio with its current value (prices as last marked). */
export async function portfolioSummaries(db: Db): Promise<PortfolioSummary[]> {
  const [portfolios, open] = await Promise.all([listPortfolios(db), openBets(db)]);
  return portfolios.map((p) =>
    summarize(
      p,
      open.filter((b) => b.portfolioId === p.id),
    ),
  );
}

export interface PortfolioDetail extends PortfolioSummary {
  open: CustomBet[];
  finished: CustomBet[];
  realized: number;
  unrealized: number;
  winRate: number | null;
  curve: Array<{ t: string; equity: number }>;
  fills: Array<CustomFill & { title: string | null; outcome: string | null }>;
}

export async function getPortfolioDetail(db: Db, id: number): Promise<PortfolioDetail | null> {
  const [portfolio] = await db.select().from(customPortfolios).where(eq(customPortfolios.id, id));
  if (!portfolio) return null;
  const [bets, snaps, fills] = await Promise.all([
    db
      .select()
      .from(customBets)
      .where(eq(customBets.portfolioId, id))
      .orderBy(desc(customBets.openedAt), desc(customBets.id)),
    db
      .select({ ts: customSnapshots.ts, equity: customSnapshots.equity })
      .from(customSnapshots)
      .where(eq(customSnapshots.portfolioId, id))
      .orderBy(asc(customSnapshots.ts)),
    db
      .select({ fill: customFills, title: customBets.title, outcome: customBets.outcome })
      .from(customFills)
      .innerJoin(customBets, eq(customBets.id, customFills.betId))
      .where(eq(customFills.portfolioId, id))
      .orderBy(asc(customFills.ts)),
  ]);
  const open = bets.filter((b) => b.status === "open");
  const finished = bets
    .filter((b) => b.status !== "open")
    .sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0));
  const wins = finished.filter((b) => b.realizedPnl > 0).length;
  return {
    ...summarize(portfolio, open),
    open,
    finished,
    realized: bets.reduce((a, b) => a + b.realizedPnl, 0),
    unrealized: open.reduce((a, b) => a + markValue(b) - b.costBasis, 0),
    winRate: finished.length > 0 ? wins / finished.length : null,
    curve: snaps.map((s) => ({ t: s.ts.toISOString(), equity: s.equity })),
    fills: fills.map((f) => ({ ...f.fill, title: f.title, outcome: f.outcome })),
  };
}
