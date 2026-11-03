/**
 * Realistic paper fills: walk the live order book level by level instead of assuming we
 * get the leader's price. Books must be best-first (see clob.normalizeBook).
 */
import type { BookLevel } from "@/lib/polymarket/clob";

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

/** Spend up to `usd` buying from `asks`, never paying more than `limitPrice`. */
export function simulateBuy(asks: BookLevel[], usd: number, limitPrice: number, feeBps = 0): Fill {
  const budget = usd / (1 + feeBps / 10_000);
  let remaining = budget;
  let shares = 0;
  let cost = 0;
  let levels = 0;
  for (const level of asks) {
    if (level.price > limitPrice + 1e-9 || remaining <= 1e-9) break;
    const take = Math.min(level.size, remaining / level.price);
    shares += take;
    cost += take * level.price;
    remaining -= take * level.price;
    levels++;
  }
  if (shares <= 0) return EMPTY;
  const fee = (cost * feeBps) / 10_000;
  return {
    shares,
    avgPrice: cost / shares,
    notional: cost + fee,
    fee,
    levels,
    partial: remaining > budget * 1e-6,
  };
}

/** Sell up to `shares` into `bids`, never accepting less than `limitPrice`. */
export function simulateSell(
  bids: BookLevel[],
  shares: number,
  limitPrice: number,
  feeBps = 0,
): Fill {
  let remaining = shares;
  let sold = 0;
  let proceeds = 0;
  let levels = 0;
  for (const level of bids) {
    if (level.price < limitPrice - 1e-9 || remaining <= 1e-9) break;
    const take = Math.min(level.size, remaining);
    sold += take;
    proceeds += take * level.price;
    remaining -= take;
    levels++;
  }
  if (sold <= 0) return EMPTY;
  const fee = (proceeds * feeBps) / 10_000;
  return {
    shares: sold,
    avgPrice: proceeds / sold,
    notional: proceeds - fee,
    fee,
    levels,
    partial: remaining > shares * 1e-6,
  };
}
