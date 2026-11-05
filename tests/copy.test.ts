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

  it("charges Polymarket's taker fee curve: shares × rate × p × (1 − p)", () => {
    const asks = [{ price: 0.5, size: 10_000 }];
    // Sports rate 0.05 at 50¢: 0.05 × 0.25 = 1.25¢ per share, so $102.50 buys 200 shares.
    const buy = simulateBuy(asks, 102.5, 0.6, 0, 0.05);
    expect(buy.shares).toBeCloseTo(200, 6);
    expect(buy.avgPrice).toBeCloseTo(0.5, 6);
    expect(buy.fee).toBeCloseTo(2.5, 6);
    expect(buy.notional).toBeCloseTo(102.5, 6);
    const sell = simulateSell([{ price: 0.9, size: 10_000 }], 200, 0, 0, 0.05);
    // 200 × 0.05 × 0.9 × 0.1 = $0.90 fee on $180 of proceeds.
    expect(sell.fee).toBeCloseTo(0.9, 6);
    expect(sell.notional).toBeCloseTo(179.1, 6);
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
    leaderTypicalUsd: 250,
    weight: 1,
    marketExposure: 0,
    traderExposure: 0,
  };

  it("matches their conviction: twice their usual stake → twice our usual stake", () => {
    // Usual copy = 2% of $1000 = $20; this bet is 2× their usual → $40.
    expect(sizeBuy(base, cfg)).toMatchObject({ usd: 40 });
  });

  it("uses the usual stake when theirs isn't known yet", () => {
    expect(sizeBuy({ ...base, leaderTypicalUsd: null }, cfg)).toMatchObject({ usd: 20 });
  });

  it("caps conviction, so one huge bet can't take over the account", () => {
    // 400× their usual counts as 3× → $60.
    expect(sizeBuy({ ...base, leaderUsd: 100_000, leaderTypicalUsd: 250 }, cfg)).toMatchObject({
      usd: 60,
    });
  });

  it("caps at the per-market limit", () => {
    const big = { ...cfg, stakePct: 0.1 }; // 10% × 3 = 30% wanted, 10% allowed
    expect(sizeBuy({ ...base, leaderUsd: 5000 }, big)).toMatchObject({ usd: 100 });
  });

  it("ignores the leader's dust trades with a clear reason", () => {
    const r = sizeBuy({ ...base, leaderUsd: 5 }, cfg);
    expect(r.usd).toBe(0);
    expect("reason" in r && r.reason).toMatch(/too small/);
  });

  it("applies the minimum copy size to a small bet for them", () => {
    // $25 vs a usual $10,000 = 0.0025× → $0.05, floored to $5.
    expect(sizeBuy({ ...base, leaderUsd: 25, leaderTypicalUsd: 10_000 }, cfg)).toMatchObject({
      usd: 5,
    });
  });

  it("skips copies below the order minimum", () => {
    const r = sizeBuy({ ...base, leaderTypicalUsd: 1_000_000 }, { ...cfg, minCopyUsd: 0 });
    expect("reason" in r && r.reason).toMatch(/below/);
  });

  it("respects exposure already taken", () => {
    const r = sizeBuy({ ...base, marketExposure: 100 }, cfg);
    expect(r).toMatchObject({ usd: 0, reason: "Per-market limit reached", code: "market_cap" });
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
    leaderTypicalUsd: 250,
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
      expect(d.fill.notional).toBeCloseTo(40, 6); // 2× their usual stake → 2 × 2% of $1000
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

  it("pays the market's taker fee on the way out", () => {
    const d = decideSell({
      trade,
      ourShares: 100,
      leaderSoldFraction: 1,
      book,
      cfg,
      feeRate: 0.04,
    });
    // 100 @ 0.49: fee = 100 × 0.04 × 0.49 × 0.51
    if (d.action === "sell") expect(d.fill.fee).toBeCloseTo(100 * 0.04 * 0.49 * 0.51, 6);
    expect(d.action).toBe("sell");
  });

  it("skips when we never copied the position", () => {
    const d = decideSell({ trade, ourShares: 0, leaderSoldFraction: 1, book, cfg });
    expect(d).toMatchObject({
      action: "skip",
      reason: "No copied position to close",
      code: "no_position",
    });
  });
});
