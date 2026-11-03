import { describe, expect, it } from "vitest";

import { DEFAULT_RISK_CONFIG as cfg } from "@/lib/copy/config";
import { decideBuy, decideSell, type BuyContext, type LeaderTrade } from "@/lib/copy/engine";
import { simulateBuy, simulateSell } from "@/lib/copy/fillSim";
import { sizeBuy } from "@/lib/copy/sizing";
import type { OrderBook } from "@/lib/polymarket/clob";

const NOW = 1_800_000_000;

const book: OrderBook = {
  tokenId: "tok",
  bids: [
    { price: 0.49, size: 100 },
    { price: 0.48, size: 1000 },
  ],
  asks: [
    { price: 0.51, size: 100 },
    { price: 0.52, size: 1000 },
    { price: 0.6, size: 5000 },
  ],
  tickSize: 0.01,
  minOrderSize: 5,
  timestamp: NOW * 1000,
};

describe("simulateBuy / simulateSell", () => {
  it("walks the asks and respects the limit price", () => {
    const f = simulateBuy(book.asks, 100, 0.53);
    // 100 @ 0.51 = 51, then 49 / 0.52 = 94.23 shares
    expect(f.shares).toBeCloseTo(100 + 49 / 0.52, 6);
    expect(f.notional).toBeCloseTo(100, 6);
    expect(f.avgPrice).toBeCloseTo(100 / f.shares, 6);
    expect(f.partial).toBe(false);
    expect(f.levels).toBe(2);
  });

  it("stops at the limit and reports a partial fill", () => {
    const f = simulateBuy(book.asks, 10_000, 0.52);
    expect(f.shares).toBe(1100);
    expect(f.partial).toBe(true);
  });

  it("includes taker fees in the notional", () => {
    const f = simulateBuy(book.asks, 101, 0.6, 100); // 1% fee → $100 of shares + $1 fee
    expect(f.notional).toBeCloseTo(101, 6);
    expect(f.fee).toBeCloseTo(1, 6);
  });

  it("sells into the bids best-first", () => {
    const f = simulateSell(book.bids, 150, 0);
    expect(f.notional).toBeCloseTo(100 * 0.49 + 50 * 0.48, 6);
  });
});

describe("sizeBuy", () => {
  const base = {
    equity: 1000,
    cash: 1000,
    leaderUsd: 500,
    leaderPortfolioUsd: 10_000,
    weight: 1,
    marketExposure: 0,
    traderExposure: 0,
  };

  it("mirrors the leader's conviction as a fraction of our equity", () => {
    expect(sizeBuy(base, cfg)).toEqual({ usd: 50 }); // 5% of their book → 5% of ours
  });

  it("caps at the per-market limit", () => {
    expect(sizeBuy({ ...base, leaderUsd: 5000 }, cfg)).toEqual({ usd: 100 });
  });

  it("explains why tiny copies are skipped", () => {
    const r = sizeBuy({ ...base, leaderUsd: 5 }, cfg);
    expect(r.usd).toBe(0);
    expect("reason" in r && r.reason).toMatch(/below/);
  });

  it("respects exposure already taken", () => {
    const r = sizeBuy({ ...base, marketExposure: 100 }, cfg);
    expect(r).toEqual({ usd: 0, reason: "Per-market limit reached" });
  });
});

describe("decideBuy", () => {
  const trade: LeaderTrade = {
    id: "tx:tok:BUY",
    wallet: "0xleader",
    ts: NOW - 30,
    conditionId: "c",
    tokenId: "tok",
    side: "BUY",
    price: 0.5,
    size: 1000,
    usdc: 500,
    outcome: "Yes",
    title: "Will it?",
    slug: "will-it",
  };
  const ctx: BuyContext = {
    now: NOW,
    trade,
    market: {
      conditionId: "c",
      question: "Will it?",
      slug: "will-it",
      image: null,
      endDate: new Date((NOW + 86_400) * 1000),
      closed: false,
      tokenIds: ["tok", "other"],
      outcomes: ["Yes", "No"],
      winnerIndex: null,
    },
    book,
    equity: 1000,
    cash: 1000,
    leaderPortfolioUsd: 10_000,
    weight: 1,
    marketExposure: 0,
    traderExposure: 0,
    dailyLossPct: 0,
    cfg,
  };
  const reason = (c: BuyContext) => {
    const d = decideBuy(c);
    return d.action === "skip" ? d.reason : d.action;
  };

  it("copies a fresh trade at a realistic fill", () => {
    const d = decideBuy(ctx);
    expect(d.action).toBe("buy");
    if (d.action === "buy") {
      expect(d.fill.notional).toBeCloseTo(50, 6);
      expect(d.fill.avgPrice).toBeCloseTo(0.51, 6);
    }
  });

  it("skips with a human-readable reason", () => {
    expect(reason({ ...ctx, trade: { ...trade, ts: NOW - 3600 } })).toMatch(/min old/);
    expect(reason({ ...ctx, market: { ...ctx.market!, closed: true } })).toMatch(/closed/);
    expect(
      reason({ ...ctx, market: { ...ctx.market!, endDate: new Date((NOW + 60) * 1000) } }),
    ).toMatch(/ends in under/);
    expect(reason({ ...ctx, trade: { ...trade, price: 0.95 } })).toMatch(/above/);
    expect(reason({ ...ctx, dailyLossPct: 0.2 })).toMatch(/Daily loss/);
    expect(reason({ ...ctx, book: { ...book, asks: [{ price: 0.6, size: 100 }] } })).toMatch(
      /Price moved/,
    );
    expect(reason({ ...ctx, book: null })).toMatch(/No sellers/);
  });
});

describe("decideSell", () => {
  const trade = { ...({} as LeaderTrade), side: "SELL" as const, price: 0.5 };

  it("sells the same fraction the leader sold", () => {
    const d = decideSell({ trade, ourShares: 100, leaderSoldFraction: 0.5, book, cfg });
    expect(d.action).toBe("sell");
    if (d.action === "sell") expect(d.fill.shares).toBeCloseTo(50);
  });

  it("closes everything when the leader (almost) fully exits", () => {
    const d = decideSell({ trade, ourShares: 100, leaderSoldFraction: 0.99, book, cfg });
    if (d.action === "sell") expect(d.fill.shares).toBeCloseTo(100);
  });

  it("skips when we never copied the position", () => {
    const d = decideSell({ trade, ourShares: 0, leaderSoldFraction: 1, book, cfg });
    expect(d).toEqual({ action: "skip", reason: "No copied position to close" });
  });
});
