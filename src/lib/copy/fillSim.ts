/**
 * Realistic paper fills: walk the live order book level by level instead of assuming we
 * get the leader's price. Books must be best-first (see clob.normalizeBook).
 *
 * Fees: copies always cross the book (taker), so each level pays Polymarket's taker fee,
 * shares × feeRate × p × (1 − p) (see gamma.takerFeeRate), plus any extra flat `feeBps`.
 */
import type { BookLevel } from "@/lib/polymarket/clob";

/** Polymarket taker fee in USDC for `shares` at price `p`. */
export const takerFee = (shares: number, p: number, feeRate: number) =>
  shares * feeRate * p * (1 - p);

export interface Fill {
  shares: number;
  /** Volume-weighted average price, fees excluded. */
  avgPrice: number;
  /** USDC paid (buy) or received (sell), fees included. */
  notional: number;
  fee: number;
  levels: number;
  /** True when the book ran out (or hit the limit) before the full size filled. */
  partial: boolean;
}

const EMPTY: Fill = { shares: 0, avgPrice: 0, notional: 0, fee: 0, levels: 0, partial: true };

/** Spend up to `usd` (fees included) buying from `asks`, never paying more than `limitPrice`. */
export function simulateBuy(
  asks: BookLevel[],
  usd: number,
  limitPrice: number,
  feeBps = 0,
  feeRate = 0,
): Fill {
  const bps = feeBps / 10_000;
  let remaining = usd;
  let shares = 0;
  let cost = 0;
  let fee = 0;
  let levels = 0;
  for (const level of asks) {
    if (level.price > limitPrice + 1e-9 || remaining <= 1e-9) break;
    // All-in USDC per share at this level: price + flat fee + Polymarket's taker fee.
    const perShare = level.price * (1 + bps) + takerFee(1, level.price, feeRate);
    const take = Math.min(level.size, remaining / perShare);
    shares += take;
    cost += take * level.price;
    fee += take * (perShare - level.price);
    remaining -= take * perShare;
    levels++;
  }
  if (shares <= 0) return EMPTY;
  return {
    shares,
    avgPrice: cost / shares,
    notional: cost + fee,
    fee,
    levels,
    partial: remaining > usd * 1e-6,
  };
}

/** Sell up to `shares` into `bids`, never accepting less than `limitPrice`. */
export function simulateSell(
  bids: BookLevel[],
  shares: number,
  limitPrice: number,
  feeBps = 0,
  feeRate = 0,
): Fill {
  let remaining = shares;
  let sold = 0;
  let proceeds = 0;
  let curveFee = 0;
  let levels = 0;
  for (const level of bids) {
    if (level.price < limitPrice - 1e-9 || remaining <= 1e-9) break;
    const take = Math.min(level.size, remaining);
    sold += take;
    proceeds += take * level.price;
    curveFee += takerFee(take, level.price, feeRate);
    remaining -= take;
    levels++;
  }
  if (sold <= 0) return EMPTY;
  const fee = (proceeds * feeBps) / 10_000 + curveFee;
  return {
    shares: sold,
    avgPrice: proceeds / sold,
    notional: proceeds - fee,
    fee,
    levels,
    partial: remaining > shares * 1e-6,
  };
}
