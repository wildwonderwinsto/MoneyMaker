/** Paper account bookkeeping: positions, cash, fills, settlements and equity. */
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import { equitySnapshots, paperAccounts, paperFills, paperPositions } from "@/lib/db/schema";

import type { LeaderTrade, MarketInfo } from "./engine";
import type { Fill } from "./fillSim";

export type Account = typeof paperAccounts.$inferSelect;
export type PaperPosition = typeof paperPositions.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const DEFAULT_STARTING_BALANCE = 1000;

/** The paper account the engine trades (the oldest one); created on first use. */
export async function ensureDefaultAccount(db: Db): Promise<Account> {
  const [existing] = await db.select().from(paperAccounts).orderBy(asc(paperAccounts.id)).limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(paperAccounts)
    .values({
      name: "Paper",
      startingBalance: DEFAULT_STARTING_BALANCE,
      cash: DEFAULT_STARTING_BALANCE,
    })
    .returning();
  return created;
}

export interface AccountState {
  account: Account;
  open: PaperPosition[];
  cash: number;
  positionsValue: number;
  equity: number;
}

const markValue = (p: PaperPosition) => p.shares * (p.currentPrice ?? p.avgPrice);

export async function loadAccountState(db: Db, accountId: number): Promise<AccountState> {
  const [account] = await db.select().from(paperAccounts).where(eq(paperAccounts.id, accountId));
  const open = await db
    .select()
    .from(paperPositions)
    .where(and(eq(paperPositions.accountId, accountId), eq(paperPositions.status, "open")));
  const positionsValue = open.reduce((a, p) => a + markValue(p), 0);
  return {
    account,
    open,
    cash: account.cash,
    positionsValue,
    equity: account.cash + positionsValue,
  };
}

export function exposure(state: AccountState, conditionId: string, wallet: string) {
  let market = 0;
  let trader = 0;
  for (const p of state.open) {
    if (p.conditionId === conditionId) market += p.costBasis;
    if (p.sourceWallet === wallet) trader += p.costBasis;
  }
  return { market, trader };
}

/** Loss since the first snapshot of the current UTC day, as a fraction (positive = loss). */
export async function dailyLossPct(db: Db, accountId: number, equity: number): Promise<number> {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const [first] = await db
    .select({ equity: equitySnapshots.equity })
    .from(equitySnapshots)
    .where(and(eq(equitySnapshots.accountId, accountId), gte(equitySnapshots.ts, dayStart)))
    .orderBy(asc(equitySnapshots.ts))
    .limit(1);
  if (!first || first.equity <= 0) return 0;
  return Math.max(0, (first.equity - equity) / first.equity);
}

export async function applyBuy(
  tx: Tx,
  accountId: number,
  trade: LeaderTrade,
  market: MarketInfo,
  fill: Fill,
): Promise<void> {
  const [existing] = await tx
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

  let positionId: number;
  if (existing) {
    const shares = existing.shares + fill.shares;
    const costBasis = existing.costBasis + fill.notional;
    await tx
      .update(paperPositions)
      .set({ shares, costBasis, avgPrice: costBasis / shares, updatedAt: new Date() })
      .where(eq(paperPositions.id, existing.id));
    positionId = existing.id;
  } else {
    const [created] = await tx
      .insert(paperPositions)
      .values({
        accountId,
        sourceWallet: trade.wallet,
        conditionId: trade.conditionId,
        tokenId: trade.tokenId,
        outcome: trade.outcome,
        title: market.question,
        slug: market.slug,
        image: market.image,
        shares: fill.shares,
        costBasis: fill.notional,
        avgPrice: fill.notional / fill.shares,
        currentPrice: fill.avgPrice,
      })
      .returning({ id: paperPositions.id });
    positionId = created.id;
  }

  await tx
    .update(paperAccounts)
    .set({ cash: sql`${paperAccounts.cash} - ${fill.notional}` })
    .where(eq(paperAccounts.id, accountId));
  await tx.insert(paperFills).values({
    accountId,
    positionId,
    signalId: trade.id,
    kind: "trade",
    side: "BUY",
    shares: fill.shares,
    avgPrice: fill.avgPrice,
    notional: fill.notional,
    slippageBps: ((fill.avgPrice - trade.price) / trade.price) * 10_000,
  });
}

export async function applySell(
  tx: Tx,
  position: PaperPosition,
  trade: LeaderTrade,
  fill: Fill,
): Promise<void> {
  const sold = Math.min(fill.shares, position.shares);
  const costPortion = position.costBasis * (sold / position.shares);
  const remaining = position.shares - sold;
  const done = remaining < 1e-6;
  await tx
    .update(paperPositions)
    .set({
      shares: done ? 0 : remaining,
      costBasis: done ? 0 : position.costBasis - costPortion,
      realizedPnl: position.realizedPnl + (fill.notional - costPortion),
      status: done ? "closed" : "open",
      closedAt: done ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(paperPositions.id, position.id));
  await tx
    .update(paperAccounts)
    .set({ cash: sql`${paperAccounts.cash} + ${fill.notional}` })
    .where(eq(paperAccounts.id, position.accountId));
  await tx.insert(paperFills).values({
    accountId: position.accountId,
    positionId: position.id,
    signalId: trade.id,
    kind: "trade",
    side: "SELL",
    shares: sold,
    avgPrice: fill.avgPrice,
    notional: fill.notional,
    slippageBps: ((trade.price - fill.avgPrice) / trade.price) * 10_000,
  });
}

/** Pay out a resolved position at $1 (won) or $0 (lost) per share. */
export async function settlePosition(
  tx: Tx,
  position: PaperPosition,
  won: boolean,
): Promise<number> {
  const payout = won ? position.shares : 0;
  await tx
    .update(paperPositions)
    .set({
      shares: 0,
      costBasis: 0,
      currentPrice: won ? 1 : 0,
      realizedPnl: position.realizedPnl + payout - position.costBasis,
      status: "settled",
      closedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(paperPositions.id, position.id));
  await tx
    .update(paperAccounts)
    .set({ cash: sql`${paperAccounts.cash} + ${payout}` })
    .where(eq(paperAccounts.id, position.accountId));
  await tx.insert(paperFills).values({
    accountId: position.accountId,
    positionId: position.id,
    kind: "settlement",
    side: won ? "WIN" : "LOSS",
    shares: position.shares,
    avgPrice: won ? 1 : 0,
    notional: payout,
  });
  return payout - position.costBasis;
}

/** Record equity if the last snapshot is older than `everyMs`. */
export async function maybeSnapshot(db: Db, accountId: number, everyMs = 15 * 60_000) {
  const [last] = await db
    .select({ ts: equitySnapshots.ts })
    .from(equitySnapshots)
    .where(eq(equitySnapshots.accountId, accountId))
    .orderBy(desc(equitySnapshots.ts))
    .limit(1);
  if (last && Date.now() - last.ts.getTime() < everyMs) return false;
  const state = await loadAccountState(db, accountId);
  await db.insert(equitySnapshots).values({
    accountId,
    ts: new Date(),
    equity: state.equity,
    cash: state.cash,
    positionsValue: state.positionsValue,
  });
  return true;
}

/** Wipe an account's history and restore its starting balance. */
export async function resetAccount(db: Db, accountId: number, startingBalance: number) {
  await db.transaction(async (tx) => {
    await tx.delete(paperFills).where(eq(paperFills.accountId, accountId));
    await tx.delete(paperPositions).where(eq(paperPositions.accountId, accountId));
    await tx.delete(equitySnapshots).where(eq(equitySnapshots.accountId, accountId));
    await tx
      .update(paperAccounts)
      .set({ startingBalance, cash: startingBalance, resetAt: new Date() })
      .where(eq(paperAccounts.id, accountId));
  });
}
