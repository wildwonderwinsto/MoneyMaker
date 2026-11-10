/**
 * Copy decisions (pure). Given a leader's trade and our account/market state, decide
 * whether to copy it, how much, and at what simulated fill — or explain why not.
 * Every decision carries a machine-readable code plus the numbers behind it, so the UI
 * can explain it in plain English (see lib/explain.ts).
 */
import type { ReasonCode } from "@/lib/db/schema";
import type { OrderBook } from "@/lib/polymarket/clob";

import type { RiskConfig } from "./config";
import { simulateBuy, simulateSell, type Fill } from "./fillSim";
import { sizeBuy } from "./sizing";

export interface LeaderTrade {
  /** Id of the (first) fill; see polymarket/data.ts tradeId. */
  id: string;
  wallet: string;
  /** Epoch seconds. */
  ts: number;
  conditionId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  /** Volume-weighted price across `ids`. */
  price: number;
  size: number;
  usdc: number;
  outcome: string | null;
  title: string | null;
  slug: string | null;
  icon?: string | null;
  /** Every fill id merged into this trade (one leader order often fills in pieces). */
  ids?: string[];
}

export interface MarketInfo {
  conditionId: string;
  question: string;
  slug: string | null;
  eventSlug?: string | null;
  image: string | null;
  endDate: Date | null;
  closed: boolean;
  tokenIds: string[];
  outcomes: string[];
  winnerIndex: number | null;
  /** USDC per share for each outcome once settled (see gamma.resolvedPayouts). */
  payouts?: number[] | null;
  /** Polymarket taker fee rate (see gamma.takerFeeRate); missing = unknown, treated as 0. */
  takerFeeRate?: number | null;
}

export type Details = Record<string, number | string | boolean | null>;

export type Decision =
  | { action: "buy"; fill: Fill; usd: number; limitPrice: number; details: Details }
  | { action: "sell"; fill: Fill; fraction: number; details: Details }
  | { action: "skip"; reason: string; code: ReasonCode; details?: Details };

export interface BuyContext {
  now: number;
  trade: LeaderTrade;
  market: MarketInfo | null;
  book: OrderBook | null;
  equity: number;
  cash: number;
  /** Leader's usual stake per market; null if not known yet. */
  leaderTypicalUsd: number | null;
  weight: number;
  marketExposure: number;
  traderExposure: number;
  /** Today's loss as a fraction of start-of-day equity (positive = losing). */
  dailyLossPct: number;
  /** Copied buys already in our open position for this trader and outcome (0 = none). */
  positionBuys?: number;
  cfg: RiskConfig;
}

export const cents = (x: number) => `${(x * 100).toFixed(1)}¢`;
export const skip = (reason: string, code: ReasonCode, details?: Details): Decision => ({
  action: "skip",
  reason,
  code,
  details,
});

/**
 * Codes worth re-checking later: the market may come back within our limits, or (no_market)
 * Gamma may answer next time.
 */
export const RETRYABLE_CODES: ReadonlySet<ReasonCode> = new Set([
  "price_moved",
  "no_sellers",
  "no_liquidity",
  "no_market",
]);

/**
 * Sell skips worth re-checking while we still hold the copy: following the leader out
 * matters at any age (otherwise the copy sits until the market resolves).
 */
export const SELL_RETRYABLE_CODES: ReadonlySet<ReasonCode> = new Set([
  "no_buyers",
  "sell_floor",
  "sell_size_unknown",
]);

export function decideBuy(ctx: BuyContext): Decision {
  const { trade, market, book, cfg, now } = ctx;
  const age = now - trade.ts;
  if (age > cfg.maxSignalAgeSeconds) {
    return skip(`Signal is ${Math.round(age / 60)} min old`, "stale", {
      ageSeconds: age,
      maxAgeSeconds: cfg.maxSignalAgeSeconds,
    });
  }
  if (!market) return skip("Market info unavailable", "no_market");
  if (market.closed) return skip("Market is closed", "market_closed");
  if (market.endDate && market.endDate.getTime() / 1000 - now < cfg.minMinutesToEnd * 60) {
    return skip(`Market ends in under ${cfg.minMinutesToEnd} min`, "ending_soon", {
      minutesLeft: Math.max(0, Math.round((market.endDate.getTime() / 1000 - now) / 60)),
      minMinutesToEnd: cfg.minMinutesToEnd,
    });
  }
  if (trade.price > cfg.maxEntryPrice) {
    return skip(
      `Leader paid ${cents(trade.price)} (above ${cents(cfg.maxEntryPrice)} max)`,
      "price_too_high",
      { leaderPrice: trade.price, maxEntryPrice: cfg.maxEntryPrice },
    );
  }
  if (trade.price < cfg.minEntryPrice) {
    return skip(
      `Leader paid ${cents(trade.price)} (below ${cents(cfg.minEntryPrice)} min)`,
      "price_too_low",
      { leaderPrice: trade.price, minEntryPrice: cfg.minEntryPrice },
    );
  }
  if (ctx.dailyLossPct >= cfg.maxDailyLossPct) {
    return skip(`Daily loss limit hit (${(ctx.dailyLossPct * 100).toFixed(1)}%)`, "daily_loss", {
      dailyLossPct: ctx.dailyLossPct,
      maxDailyLossPct: cfg.maxDailyLossPct,
    });
  }
  const buys = ctx.positionBuys ?? 0;
  if (cfg.maxBuysPerPosition > 0 && buys >= cfg.maxBuysPerPosition) {
    return skip(
      `Already copied ${buys} buy${buys === 1 ? "" : "s"} into this position`,
      "buy_limit",
      { positionBuys: buys, maxBuysPerPosition: cfg.maxBuysPerPosition },
    );
  }
  if (!book || book.asks.length === 0) {
    return skip("No sellers in the order book", "no_sellers", { leaderPrice: trade.price });
  }

  const limitPrice = Math.min(trade.price + cfg.maxPriceDrift, cfg.maxEntryPrice);
  const bestAsk = book.asks[0].price;
  if (bestAsk > limitPrice + 1e-9) {
    return skip(
      `Price moved to ${cents(bestAsk)} (leader paid ${cents(trade.price)})`,
      "price_moved",
      {
        bestAsk,
        bestAskShares: book.asks[0].size,
        leaderPrice: trade.price,
        leaderShares: trade.size,
        limitPrice,
        maxPriceDrift: cfg.maxPriceDrift,
        fills: trade.ids?.length ?? 1,
      },
    );
  }

  const size = sizeBuy(
    {
      equity: ctx.equity,
      cash: ctx.cash,
      leaderUsd: trade.usdc,
      leaderTypicalUsd: ctx.leaderTypicalUsd,
      weight: ctx.weight,
      marketExposure: ctx.marketExposure,
      traderExposure: ctx.traderExposure,
    },
    cfg,
  );
  if ("reason" in size) return skip(size.reason, size.code, size.details);

  const fill = simulateBuy(
    book.asks,
    size.usd,
    limitPrice,
    cfg.takerFeeBps,
    market.takerFeeRate ?? 0,
  );
  if (fill.shares <= 0) {
    return skip("Not enough liquidity within the price limit", "no_liquidity", {
      limitPrice,
      leaderPrice: trade.price,
    });
  }
  if (fill.shares < book.minOrderSize) {
    return skip(
      `Order of ${fill.shares.toFixed(1)} shares is below the exchange minimum`,
      "below_exchange_min",
      { shares: fill.shares, minOrderSize: book.minOrderSize },
    );
  }
  return {
    action: "buy",
    fill,
    usd: size.usd,
    limitPrice,
    details: {
      ...size.details,
      leaderPrice: trade.price,
      leaderUsd: trade.usdc,
      fillPrice: fill.avgPrice,
      limitPrice,
      partial: fill.partial,
      fills: trade.ids?.length ?? 1,
    },
  };
}

export interface SellContext {
  trade: LeaderTrade;
  /** Our open shares copied from this leader in this outcome. */
  ourShares: number;
  /** Share of their position the leader just sold (0–1). */
  leaderSoldFraction: number;
  book: OrderBook | null;
  /** The market's taker fee rate (MarketInfo.takerFeeRate). */
  feeRate?: number | null;
  cfg: RiskConfig;
}

/**
 * What a sell floor is measured from when there is no trader sell price (a Hide, a leader
 * merge): the book's midpoint, or the best bid when nobody is selling. Null without bids.
 */
export function bookMidpoint(book: OrderBook): number | null {
  const bid = book.bids[0]?.price;
  if (bid === undefined) return null;
  const ask = book.asks[0]?.price;
  return ask === undefined ? bid : (bid + ask) / 2;
}

export function decideSell(ctx: SellContext): Decision {
  const { cfg, book } = ctx;
  if (ctx.ourShares <= 1e-9) return skip("No copied position to close", "no_position");
  if (!cfg.copySells) return skip("Copying sells is turned off", "sells_off");
  if (!book || book.bids.length === 0) return skip("No buyers in the order book", "no_buyers");

  const fraction = ctx.leaderSoldFraction >= 0.98 ? 1 : Math.max(0, ctx.leaderSoldFraction);
  // NaN slips past every comparison, so check finiteness: it would become NaN cash.
  if (!Number.isFinite(ctx.leaderSoldFraction) || fraction <= 0) {
    return skip("Leader's sell size is unknown", "sell_size_unknown");
  }
  const shares = ctx.ourShares * fraction;
  // By default exits take whatever the book offers: getting out matters more than the
  // price. With a floor, shares that would sell too far below the trader's price are held.
  const floor = cfg.sellFloorPct > 0 ? ctx.trade.price * (1 - cfg.sellFloorPct) : 0;
  const fill = simulateSell(book.bids, shares, floor, cfg.takerFeeBps, ctx.feeRate ?? 0);
  if (fill.shares <= 0) {
    return floor > 0
      ? skip(`Best bid ${cents(book.bids[0].price)} is below your sell floor`, "sell_floor", {
          bestBid: book.bids[0].price,
          leaderPrice: ctx.trade.price,
          limitPrice: floor,
          sellFloorPct: cfg.sellFloorPct,
        })
      : skip("No buyers in the order book", "no_buyers");
  }
  return {
    action: "sell",
    fill,
    fraction,
    details: {
      leaderPrice: ctx.trade.price,
      leaderSoldPct: fraction,
      fillPrice: fill.avgPrice,
      fills: ctx.trade.ids?.length ?? 1,
      ...(floor > 0 && { limitPrice: floor, partial: fill.partial }),
    },
  };
}

/**
 * Merge fills of one leader order (same wallet, token and side, a few seconds apart, at
 * about the same price) into a single trade. Sizing and the "too small" filter then see
 * the whole order, not the pieces it happened to fill in. Orders at clearly different
 * prices stay separate so each is judged on its own price. Input must be sorted by time.
 */
export function mergeFills(
  trades: LeaderTrade[],
  windowSeconds = 30,
  priceTolerance = 0.03,
): LeaderTrade[] {
  const out: LeaderTrade[] = [];
  const open = new Map<string, LeaderTrade>();
  for (const t of trades) {
    const key = `${t.wallet}|${t.tokenId}|${t.side}`;
    const cur = open.get(key);
    if (
      cur &&
      t.ts - cur.ts <= windowSeconds &&
      Math.abs(t.price - cur.price) <= priceTolerance + 1e-9
    ) {
      const size = cur.size + t.size;
      const usdc = cur.usdc + t.usdc;
      cur.price = size > 0 ? (cur.price * cur.size + t.price * t.size) / size : cur.price;
      cur.size = size;
      cur.usdc = usdc;
      cur.ids = [...(cur.ids ?? [cur.id]), ...(t.ids ?? [t.id])];
      cur.icon ??= t.icon;
      continue;
    }
    const copy: LeaderTrade = { ...t, ids: t.ids ?? [t.id] };
    open.set(key, copy);
    out.push(copy);
  }
  return out;
}
