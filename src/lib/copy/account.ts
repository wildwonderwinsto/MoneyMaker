/** Paper account bookkeeping: positions, cash, fills, settlements and equity. */
import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import {
  equitySnapshots,
  paperAccounts,
  paperFills,
  paperPositions,
  type PaperPositionKind,
} from "@/lib/db/schema";

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

/** Capital at work in one market (copies + hedges) and with one leader (copies only). */
export function exposure(state: AccountState, conditionId: string, wallet: string) {
  let market = 0;
  let trader = 0;
  for (const p of state.open) {
    if (p.conditionId === conditionId) market += p.costBasis;
    if (p.sourceWallet === wallet && p.kind === "copy") trader += p.costBasis;
  }
  return { market, trader };
}

/**
 * Equity at the first snapshot of the current UTC day; before today's first snapshot, the
 * last one before midnight (the daily loss limit was off until a snapshot was taken, C-F19).
 * Null only when there is no snapshot at all.
 */
export async function startOfDayEquity(
  db: Db,
  accountId: number,
  nowMs = Date.now(),
): Promise<number | null> {
  const dayStart = new Date(nowMs);
  dayStart.setUTCHours(0, 0, 0, 0);
  const [first] = await db
    .select({ equity: equitySnapshots.equity })
    .from(equitySnapshots)
    .where(and(eq(equitySnapshots.accountId, accountId), gte(equitySnapshots.ts, dayStart)))
    .orderBy(asc(equitySnapshots.ts))
    .limit(1);
  if (first) return first.equity > 0 ? first.equity : null;
  const [lastBefore] = await db
    .select({ equity: equitySnapshots.equity })
    .from(equitySnapshots)
    .where(and(eq(equitySnapshots.accountId, accountId), lt(equitySnapshots.ts, dayStart)))
    .orderBy(desc(equitySnapshots.ts))
    .limit(1);
  return lastBefore && lastBefore.equity > 0 ? lastBefore.equity : null;
}

/** Today's loss as a fraction of start-of-day equity (positive = loss, never negative). */
export function lossFraction(startEquity: number | null, equity: number): number {
  if (startEquity === null || startEquity <= 0) return 0;
  return Math.max(0, (startEquity - equity) / startEquity);
}

/** Loss since the first snapshot of the current UTC day, as a fraction (positive = loss). */
export async function dailyLossPct(db: Db, accountId: number, equity: number): Promise<number> {
  return lossFraction(await startOfDayEquity(db, accountId), equity);
}

export interface BuyOptions {
  kind?: PaperPositionKind;
  /** For hedges: the copy position being protected. */
  hedgeOf?: number | null;
  /** Override the outcome label (hedges buy the other side). */
  outcome?: string | null;
}

/** Add a fill to the open position (creating it if needed). Returns the position id. */
export async function applyBuy(
  tx: Tx,
  accountId: number,
  trade: LeaderTrade,
  market: MarketInfo,
  fill: Fill,
  opts: BuyOptions = {},
): Promise<number> {
  const kind = opts.kind ?? "copy";
  const [existing] = await tx
    .select()
    .from(paperPositions)
    .where(
      and(
        eq(paperPositions.accountId, accountId),
        eq(paperPositions.tokenId, trade.tokenId),
        eq(paperPositions.sourceWallet, trade.wallet),
        eq(paperPositions.kind, kind),
        eq(paperPositions.status, "open"),
      ),
    )
    .for("update");

  let positionId: number;
  if (existing) {
    const shares = existing.shares + fill.shares;
    const costBasis = existing.costBasis + fill.notional;
    // A hedge bought into an open hedge row (left from an earlier copy whose hedge couldn't
    // be sold) now protects this copy. Keeping the old link made auto-hedge see this copy
    // as unhedged and buy again on every tick.
    const hedgeOf = kind === "hedge" && opts.hedgeOf != null ? { hedgeOf: opts.hedgeOf } : {};
    await tx
      .update(paperPositions)
      .set({ shares, costBasis, avgPrice: costBasis / shares, updatedAt: new Date(), ...hedgeOf })
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
        outcome: opts.outcome !== undefined ? opts.outcome : trade.outcome,
        title: market.question,
        slug: market.slug,
        image: market.image ?? trade.icon ?? null,
        kind,
        hedgeOf: opts.hedgeOf ?? null,
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
    fee: fill.fee,
    slippageBps: trade.price > 0 ? ((fill.avgPrice - trade.price) / trade.price) * 10_000 : null,
  });
  return positionId;
}

/**
 * The position row as it is now, locked until the transaction ends. Callers pass rows read
 * earlier (an account snapshot), which another run may have sold or settled since.
 */
async function lockOpen(tx: Tx, position: PaperPosition): Promise<PaperPosition | null> {
  const [current] = await tx
    .select()
    .from(paperPositions)
    .where(eq(paperPositions.id, position.id))
    .for("update");
  return current?.status === "open" ? current : null;
}

/** Sell from a position. Returns the realized P&L (0 if it was no longer open). */
export async function applySell(
  tx: Tx,
  stale: PaperPosition,
  trade: LeaderTrade,
  fill: Fill,
): Promise<number> {
  const position = await lockOpen(tx, stale);
  if (!position || position.shares <= 0) return 0;
  const sold = Math.min(fill.shares, position.shares);
  // Paid only for the shares we actually had.
  const notional = fill.shares > 0 ? fill.notional * (sold / fill.shares) : 0;
  const costPortion = position.costBasis * (sold / position.shares);
  const pnl = notional - costPortion;
  const remaining = position.shares - sold;
  const done = remaining < 1e-6;
  await tx
    .update(paperPositions)
    .set({
      shares: done ? 0 : remaining,
      costBasis: done ? 0 : position.costBasis - costPortion,
      realizedPnl: position.realizedPnl + pnl,
      status: done ? "closed" : "open",
      closedAt: done ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(paperPositions.id, position.id));
  await tx
    .update(paperAccounts)
    .set({ cash: sql`${paperAccounts.cash} + ${notional}` })
    .where(eq(paperAccounts.id, position.accountId));
  await tx.insert(paperFills).values({
    accountId: position.accountId,
    positionId: position.id,
    signalId: trade.id,
    kind: "trade",
    side: "SELL",
    shares: sold,
    avgPrice: fill.avgPrice,
    notional,
    // Pro rata like the proceeds: only the shares we actually had were sold.
    fee: fill.shares > 0 ? fill.fee * (sold / fill.shares) : 0,
    slippageBps: trade.price > 0 ? ((trade.price - fill.avgPrice) / trade.price) * 10_000 : null,
    realizedPnl: pnl,
  });
  return pnl;
}

/** Pay out a resolved position at $1 (won) or $0 (lost) per share (0 if no longer open). */
export async function settlePosition(
  tx: Tx,
  stale: PaperPosition,
  /** USDC per share: 1 (won), 0 (lost) or 0.5 (market resolved 50/50). */
  payoutPerShare: number,
): Promise<number> {
  const position = await lockOpen(tx, stale);
  if (!position) return 0;
  const payout = position.shares * payoutPerShare;
  await tx
    .update(paperPositions)
    .set({
      shares: 0,
      costBasis: 0,
      currentPrice: payoutPerShare,
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
    side: payoutPerShare >= 1 ? "WIN" : payoutPerShare <= 0 ? "LOSS" : "SPLIT",
    shares: position.shares,
    avgPrice: payoutPerShare,
    notional: payout,
    fee: 0,
    realizedPnl: payout - position.costBasis,
  });
  return payout - position.costBasis;
}

/** Record equity if the last snapshot is older than `everyMs` (0 = always). */
export async function maybeSnapshot(db: Db, accountId: number, everyMs = 5 * 60_000) {
  const [last] = await db
    .select({ ts: equitySnapshots.ts })
    .from(equitySnapshots)
    .where(eq(equitySnapshots.accountId, accountId))
    .orderBy(desc(equitySnapshots.ts))
    .limit(1);
  if (last && everyMs > 0 && Date.now() - last.ts.getTime() < everyMs) return false;
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
