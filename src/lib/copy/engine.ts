/**
 * Copy decisions (pure). Given a leader's trade and our account/market state, decide
 * whether to copy it, how much, and at what simulated fill — or explain why not.
 */
import type { OrderBook } from "@/lib/polymarket/clob";

import type { RiskConfig } from "./config";
import { simulateBuy, simulateSell, type Fill } from "./fillSim";
import { sizeBuy } from "./sizing";

export interface LeaderTrade {
  id: string;
  wallet: string;
  /** Epoch seconds. */
  ts: number;
  conditionId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  usdc: number;
  outcome: string | null;
  title: string | null;
  slug: string | null;
}

export interface MarketInfo {
  conditionId: string;
  question: string;
  slug: string | null;
  image: string | null;
  endDate: Date | null;
  closed: boolean;
  tokenIds: string[];
  outcomes: string[];
  winnerIndex: number | null;
}

export type Decision =
  | { action: "buy"; fill: Fill; usd: number; limitPrice: number }
  | { action: "sell"; fill: Fill; fraction: number }
  | { action: "skip"; reason: string };

export interface BuyContext {
  now: number;
  trade: LeaderTrade;
  market: MarketInfo | null;
  book: OrderBook | null;
  equity: number;
  cash: number;
  leaderPortfolioUsd: number;
  weight: number;
  marketExposure: number;
  traderExposure: number;
  /** Today's loss as a fraction of start-of-day equity (positive = losing). */
  dailyLossPct: number;
  cfg: RiskConfig;
}

const cents = (x: number) => `${(x * 100).toFixed(1)}¢`;
const skip = (reason: string): Decision => ({ action: "skip", reason });

export function decideBuy(ctx: BuyContext): Decision {
  const { trade, market, book, cfg, now } = ctx;
  const age = now - trade.ts;
  if (age > cfg.maxSignalAgeSeconds) return skip(`Signal is ${Math.round(age / 60)} min old`);
  if (!market) return skip("Market info unavailable");
  if (market.closed) return skip("Market is closed");
  if (market.endDate && market.endDate.getTime() / 1000 - now < cfg.minMinutesToEnd * 60) {
    return skip(`Market ends in under ${cfg.minMinutesToEnd} min`);
  }
  if (trade.price > cfg.maxEntryPrice) {
    return skip(`Leader paid ${cents(trade.price)} (above ${cents(cfg.maxEntryPrice)} max)`);
  }
  if (trade.price < cfg.minEntryPrice) {
    return skip(`Leader paid ${cents(trade.price)} (below ${cents(cfg.minEntryPrice)} min)`);
  }
  if (ctx.dailyLossPct >= cfg.maxDailyLossPct) {
    return skip(`Daily loss limit hit (${(ctx.dailyLossPct * 100).toFixed(1)}%)`);
  }
  if (!book || book.asks.length === 0) return skip("No sellers in the order book");

  const limitPrice = Math.min(trade.price + cfg.maxPriceDrift, cfg.maxEntryPrice);
  const bestAsk = book.asks[0].price;
  if (bestAsk > limitPrice + 1e-9) {
    return skip(`Price moved to ${cents(bestAsk)} (leader paid ${cents(trade.price)})`);
  }

  const size = sizeBuy(
    {
      equity: ctx.equity,
      cash: ctx.cash,
      leaderUsd: trade.usdc,
      leaderPortfolioUsd: ctx.leaderPortfolioUsd,
      weight: ctx.weight,
      marketExposure: ctx.marketExposure,
      traderExposure: ctx.traderExposure,
    },
    cfg,
  );
  if ("reason" in size) return skip(size.reason);

  const fill = simulateBuy(book.asks, size.usd, limitPrice, cfg.takerFeeBps);
  if (fill.shares <= 0) return skip("Not enough liquidity within the price limit");
  if (fill.shares < book.minOrderSize) {
    return skip(`Order of ${fill.shares.toFixed(1)} shares is below the exchange minimum`);
  }
  return { action: "buy", fill, usd: size.usd, limitPrice };
}

export interface SellContext {
  trade: LeaderTrade;
  /** Our open shares copied from this leader in this outcome. */
  ourShares: number;
  /** Share of their position the leader just sold (0–1). */
  leaderSoldFraction: number;
  book: OrderBook | null;
  cfg: RiskConfig;
}

export function decideSell(ctx: SellContext): Decision {
  const { cfg, book } = ctx;
  if (ctx.ourShares <= 1e-9) return skip("No copied position to close");
  if (!cfg.copySells) return skip("Copying sells is turned off");
  if (!book || book.bids.length === 0) return skip("No buyers in the order book");

  const fraction = ctx.leaderSoldFraction >= 0.98 ? 1 : Math.max(0, ctx.leaderSoldFraction);
  if (fraction <= 0) return skip("Leader's sell size is unknown");
  const shares = ctx.ourShares * fraction;
  // Exits take whatever the book offers: getting out matters more than the price.
  const fill = simulateSell(book.bids, shares, 0, cfg.takerFeeBps);
  if (fill.shares <= 0) return skip("No buyers in the order book");
  return { action: "sell", fill, fraction };
}
