/**
 * Hedging a losing copied position by buying the OTHER outcome ("cancel out").
 *
 * In a Yes/No market exactly one side pays $1 per share. Holding S shares of our side
 * (cost C) and buying N shares of the opposite side (cost K):
 *   - if our side wins:      P&L = S − C − K
 *   - if the opposite wins:  P&L = N − C − K
 *
 * lock:      N = S. Both results are equal, so the outcome no longer matters. It locks in
 *            roughly today's loss and stops it growing (it never turns a loss into zero).
 * breakeven: smallest N with N − C − K = 0, so a flip costs us nothing; if our side
 *            still wins we lose the hedge cost on top. Expensive when the opposite side
 *            is pricey, which is why every hedge has a cost cap.
 */
import type { BookLevel } from "@/lib/polymarket/clob";

import type { Fill } from "./fillSim";

export type HedgeMode = "lock" | "breakeven";

export interface HedgeInput {
  mode: HedgeMode;
  /** Shares we hold of our side. */
  shares: number;
  /** What those shares cost (remaining cost basis). */
  costBasis: number;
  /** Profit already banked from earlier partial sells of this position. */
  realizedPnl: number;
  /** Opposite outcome's asks, cheapest first. */
  asks: BookLevel[];
  feeBps?: number;
  /** Most we're willing to spend on the hedge. */
  maxCost: number;
  /** Don't buy opposite shares above this price. */
  maxPrice?: number;
}

export interface HedgeQuote {
  ok: boolean;
  reason?: string;
  mode: HedgeMode;
  shares: number;
  cost: number;
  avgPrice: number;
  /** Total P&L of copy + hedge for each result. */
  pnlIfOursWins: number;
  pnlIfOppositeWins: number;
  /** Same numbers without hedging, for comparison. */
  unhedgedIfOursWins: number;
  unhedgedIfOppositeWins: number;
  fill: Fill | null;
}

/** Plan a hedge against the live order book. Pure. */
export function planHedge(input: HedgeInput): HedgeQuote {
  const fee = 1 + (input.feeBps ?? 0) / 10_000;
  const maxPrice = input.maxPrice ?? 0.99;
  const banked = input.realizedPnl;
  const base = {
    mode: input.mode,
    unhedgedIfOursWins: input.shares - input.costBasis + banked,
    unhedgedIfOppositeWins: -input.costBasis + banked,
  };
  const fail = (reason: string): HedgeQuote => ({
    ...base,
    ok: false,
    reason,
    shares: 0,
    cost: 0,
    avgPrice: 0,
    pnlIfOursWins: base.unhedgedIfOursWins,
    pnlIfOppositeWins: base.unhedgedIfOppositeWins,
    fill: null,
  });
  if (input.shares <= 1e-9) return fail("Nothing to hedge");
  const asks = input.asks.filter((l) => l.price <= maxPrice + 1e-9);
  if (asks.length === 0) {
    return fail(
      input.asks.length === 0
        ? "Nobody is selling the other side"
        : `The other side costs more than ${Math.round(maxPrice * 100)}¢`,
    );
  }

  // Walk the book until the target is met.
  // lock: buy `shares` shares. breakeven: N − K = C − banked (each share adds 1 − p·fee).
  const target = input.mode === "lock" ? input.shares : Math.max(0, input.costBasis - banked);
  if (target <= 1e-9) return fail("Already at break-even or better");
  let n = 0;
  let cost = 0; // before fees
  let progress = 0;
  let levels = 0;
  for (const level of asks) {
    const gainPerShare = input.mode === "lock" ? 1 : 1 - level.price * fee;
    if (gainPerShare <= 0) break;
    const need = (target - progress) / gainPerShare;
    const take = Math.min(level.size, need);
    n += take;
    cost += take * level.price;
    progress += take * gainPerShare;
    levels++;
    if (progress >= target - 1e-9) break;
  }
  if (progress < target - 1e-6) {
    return fail("Not enough sellers on the other side to finish the hedge");
  }
  const total = cost * fee;
  if (total > input.maxCost + 1e-9) {
    return fail(
      `Hedge would cost $${total.toFixed(2)}, above the $${input.maxCost.toFixed(2)} limit`,
    );
  }
  return {
    ...base,
    ok: true,
    shares: n,
    cost: total,
    avgPrice: cost / n,
    pnlIfOursWins: input.shares - input.costBasis - total + banked,
    pnlIfOppositeWins: n - input.costBasis - total + banked,
    fill: {
      shares: n,
      avgPrice: cost / n,
      notional: total,
      fee: total - cost,
      levels,
      partial: false,
    },
  };
}

/** The other outcome's token in a two-outcome market, or null. */
export function oppositeToken(
  tokenIds: string[],
  outcomes: string[],
  tokenId: string,
): { tokenId: string; outcome: string | null } | null {
  if (tokenIds.length !== 2) return null;
  const i = tokenIds.indexOf(tokenId);
  if (i < 0) return null;
  return { tokenId: tokenIds[1 - i], outcome: outcomes[1 - i] ?? null };
}
