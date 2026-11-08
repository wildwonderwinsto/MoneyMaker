/** Pure pieces of the engine: fill merging, sell fractions, the real-time feed, hedges. */
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_RISK_CONFIG, RiskConfigSchema } from "@/lib/copy/config";
import { mergeFills, type LeaderTrade } from "@/lib/copy/engine";
import { oppositeToken, planHedge } from "@/lib/copy/hedge";
import { parseFeedMessage, TradeStream } from "@/lib/copy/stream";
import { leaderSoldFraction, toLeaderTrade } from "@/lib/copy/tick";
import { parseSetting } from "@/lib/settings";

const trade = (over: Partial<LeaderTrade>): LeaderTrade => ({
  id: "t",
  wallet: "0xa",
  ts: 100,
  conditionId: "c",
  tokenId: "yes",
  side: "BUY",
  price: 0.5,
  size: 100,
  usdc: 50,
  outcome: "Yes",
  title: null,
  slug: null,
  ...over,
});

describe("mergeFills", () => {
  it("combines the pieces of one order into one trade at the average price", () => {
    const out = mergeFills([
      trade({ id: "a", size: 100, usdc: 85, price: 0.85 }),
      trade({ id: "b", ts: 102, size: 50, usdc: 43, price: 0.86 }),
      trade({ id: "c", ts: 103, side: "SELL", size: 10 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: "a", ids: ["a", "b"], size: 150, usdc: 128 });
    expect(out[0].price).toBeCloseTo((0.85 * 100 + 0.86 * 50) / 150, 9);
    expect(out[1].ids).toEqual(["c"]);
  });

  it("keeps orders apart when far apart in time or price", () => {
    expect(mergeFills([trade({ id: "a" }), trade({ id: "b", ts: 200 })])).toHaveLength(2);
    expect(mergeFills([trade({ id: "a" }), trade({ id: "b", ts: 101, price: 0.97 })])).toHaveLength(
      2,
    );
    expect(mergeFills([trade({ id: "a" }), trade({ id: "b", tokenId: "no" })])).toHaveLength(2);
  });

  it("does not mutate its input", () => {
    const a = trade({ id: "a" });
    mergeFills([a, trade({ id: "b", ts: 101 })]);
    expect(a.size).toBe(100);
    expect(a.ids).toBeUndefined();
  });
});

describe("leaderSoldFraction", () => {
  it("uses the position size when the API already includes the sell", () => {
    const sell = trade({ side: "SELL", size: 100, ts: 100 });
    expect(leaderSoldFraction(sell, [sell], { size: 100, lastEventAt: 100 })).toBeCloseTo(0.5);
  });

  it("applies the sell itself when the API hasn't caught up yet (real-time feed)", () => {
    // Leader held 200 and sold all 200; the API still shows 200 (last event before the sell).
    const sell = trade({ side: "SELL", size: 200, ts: 100 });
    expect(leaderSoldFraction(sell, [sell], { size: 200, lastEventAt: 50 })).toBe(1);
  });

  it("measures each sell against the size right after it, not the final size", () => {
    // Held 300: sold 100 (→200), then sold 200 (→0). API shows 0, fully up to date.
    const s1 = trade({ id: "1", side: "SELL", size: 100, ts: 100 });
    const s2 = trade({ id: "2", side: "SELL", size: 200, ts: 105 });
    const pos = { size: 0, lastEventAt: 105 };
    expect(leaderSoldFraction(s1, [s1, s2], pos)).toBeCloseTo(1 / 3);
    expect(leaderSoldFraction(s2, [s1, s2], pos)).toBe(1);
  });

  it("treats a vanished position as a full exit", () => {
    const sell = trade({ side: "SELL", size: 50 });
    expect(leaderSoldFraction(sell, [sell], undefined)).toBe(1);
  });

  it("a 0-share sell is a 0 fraction, never NaN", () => {
    // Regression (C-F13): 0 / (0 + 0) = NaN, which passed every check in decideSell and
    // wrote NaN shares and cash to the database.
    const sell = trade({ side: "SELL", size: 0, usdc: 0 });
    expect(leaderSoldFraction(sell, [sell], undefined)).toBe(0);
    expect(leaderSoldFraction(sell, [sell], { size: 0, lastEventAt: 50 })).toBe(0);
  });
});

const feed = (payload: Record<string, unknown>) =>
  JSON.stringify({ topic: "activity", type: "trades", timestamp: 1, payload });
const payload = {
  proxyWallet: "0xABC0000000000000000000000000000000000001",
  asset: "111",
  conditionId: "0xcond",
  side: "BUY",
  price: 0.5,
  size: 20,
  timestamp: 1000,
  transactionHash: "0xTX",
  outcome: "Yes",
  title: "Will it?",
  slug: "will-it",
  icon: "https://x/y.png",
};

describe("real-time feed", () => {
  it("parses a trade with the same id the Data API would get", () => {
    const t = parseFeedMessage(feed(payload));
    expect(t).toMatchObject({
      baseId: "0xtx:111:BUY:20",
      wallet: "0xabc0000000000000000000000000000000000001",
      usdc: 10,
      icon: "https://x/y.png",
    });
  });

  it("sizes the leader's trade the same from the feed and from the Data API (no fee)", () => {
    // Regression (A3, live Nov 2026): the Data API's usdc_size includes the leader's taker
    // fee (BUY 2000 @ 0.11647 = $232.94, usdc_size $247.35), the feed has only price and
    // size. The same trade could pass minLeaderUsd on one path and fail it on the other.
    const live = { ...payload, price: 0.11647, size: 2000 };
    const fromFeed = parseFeedMessage(feed(live))!;
    const fromApi = toLeaderTrade({
      proxy_wallet: live.proxyWallet,
      timestamp: live.timestamp,
      condition_id: live.conditionId,
      type: "TRADE",
      size: live.size,
      usdc_size: 247.34666,
      transaction_hash: live.transactionHash,
      price: live.price,
      token_id: live.asset,
      side: "BUY",
    })!;
    expect(fromApi.usdc).toBeCloseTo(232.94, 6);
    expect(fromApi.usdc).toBeCloseTo(fromFeed.usdc, 9);
  });

  it("ignores everything that is not a trade", () => {
    expect(parseFeedMessage("")).toBeNull();
    expect(parseFeedMessage("not json")).toBeNull();
    expect(
      parseFeedMessage(JSON.stringify({ topic: "crypto_prices", type: "update", payload: {} })),
    ).toBeNull();
    expect(parseFeedMessage(feed({ ...payload, side: "MERGE" }))).toBeNull();
    // Seen live: some events have no market id. Leave those to the poll.
    expect(parseFeedMessage(feed({ ...payload, conditionId: "" }))).toBeNull();
    expect(parseFeedMessage(feed({ ...payload, asset: "" }))).toBeNull();
  });

  it("batches a followed wallet's fills, numbers identical fills, drops strangers", () => {
    vi.useFakeTimers();
    const onTrades = vi.fn();
    const s = new TradeStream({ onTrades, batchMs: 1000 });
    s.setFollowed([payload.proxyWallet]);
    s.handleMessage(feed(payload));
    s.handleMessage(feed(payload)); // identical second fill in the same transaction
    s.handleMessage(feed({ ...payload, size: 7 }));
    s.handleMessage(
      feed({ ...payload, proxyWallet: "0x9999999999999999999999999999999999999999" }),
    );
    expect(onTrades).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onTrades).toHaveBeenCalledTimes(1);
    expect(onTrades.mock.calls[0][0].map((t: LeaderTrade) => t.id)).toEqual([
      "0xtx:111:BUY:20",
      "0xtx:111:BUY:20#2",
      "0xtx:111:BUY:7",
    ]);
    expect(s.status.matched).toBe(3);
    vi.useRealTimers();
  });
});

describe("planHedge", () => {
  // We hold 100 Yes that cost $60; Yes fell, No now sells at 60¢ (plenty of size).
  const base = {
    shares: 100,
    costBasis: 60,
    realizedPnl: 0,
    asks: [{ price: 0.6, size: 10_000 }],
    maxCost: 1_000,
  };

  it("lock: equal shares of the other side make both results the same", () => {
    const q = planHedge({ ...base, mode: "lock" });
    expect(q.ok).toBe(true);
    expect(q.shares).toBeCloseTo(100);
    expect(q.cost).toBeCloseTo(60);
    expect(q.pnlIfOursWins).toBeCloseTo(-20);
    expect(q.pnlIfOppositeWins).toBeCloseTo(-20);
    expect(q.unhedgedIfOppositeWins).toBeCloseTo(-60);
  });

  it("breakeven: a flip costs nothing, a win keeps less", () => {
    const q = planHedge({ ...base, mode: "breakeven" });
    // N − 0.6N = 60 → N = 150, cost $90
    expect(q.shares).toBeCloseTo(150);
    expect(q.cost).toBeCloseTo(90);
    expect(q.pnlIfOppositeWins).toBeCloseTo(0);
    expect(q.pnlIfOursWins).toBeCloseTo(100 - 60 - 90);
  });

  it("includes Polymarket's taker fee in the hedge cost", () => {
    // Fee per share at 60¢, rate 0.05: 0.05 × 0.6 × 0.4 = 1.2¢ → all-in 61.2¢.
    const lock = planHedge({ ...base, mode: "lock", feeRate: 0.05 });
    expect(lock.cost).toBeCloseTo(61.2);
    expect(lock.pnlIfOppositeWins).toBeCloseTo(100 - 60 - 61.2);
    const be = planHedge({ ...base, mode: "breakeven", feeRate: 0.05 });
    // N − 0.612N = 60 → a flip still costs nothing after fees.
    expect(be.pnlIfOppositeWins).toBeCloseTo(0);
  });

  it("walks the book and counts fees", () => {
    const q = planHedge({
      ...base,
      mode: "lock",
      asks: [
        { price: 0.5, size: 40 },
        { price: 0.7, size: 1000 },
      ],
      feeBps: 100,
    });
    expect(q.shares).toBeCloseTo(100);
    expect(q.cost).toBeCloseTo((40 * 0.5 + 60 * 0.7) * 1.01);
  });

  it("refuses when too expensive, too pricey, or the book is too thin", () => {
    expect(planHedge({ ...base, mode: "breakeven", maxCost: 50 }).reason).toMatch(/above the \$50/);
    expect(planHedge({ ...base, mode: "lock", maxPrice: 0.5 }).reason).toMatch(/more than 50¢/);
    expect(planHedge({ ...base, mode: "lock", asks: [{ price: 0.6, size: 10 }] }).reason).toMatch(
      /Not enough sellers/,
    );
  });

  it("counts profit already banked toward break-even", () => {
    const q = planHedge({ ...base, mode: "breakeven", realizedPnl: 60 });
    expect(q.ok).toBe(false);
    expect(q.reason).toMatch(/break-even or better/);
  });

  it("finds the other side only in two-outcome markets", () => {
    expect(oppositeToken(["y", "n"], ["Yes", "No"], "y")).toEqual({ tokenId: "n", outcome: "No" });
    expect(oppositeToken(["a", "b", "c"], ["A", "B", "C"], "a")).toBeNull();
    expect(oppositeToken(["y", "n"], ["Yes", "No"], "zzz")).toBeNull();
  });
});

describe("parseSetting", () => {
  it("keeps every valid saved value when one field is invalid", () => {
    const cfg = parseSetting(RiskConfigSchema, {
      sizingMode: "fixed",
      fixedUsd: 40,
      maxEntryPrice: 7, // invalid (> 1)
    });
    expect(cfg.sizingMode).toBe("fixed");
    expect(cfg.fixedUsd).toBe(40);
    expect(cfg.maxEntryPrice).toBe(DEFAULT_RISK_CONFIG.maxEntryPrice);
  });

  it("falls back to defaults for garbage", () => {
    expect(parseSetting(RiskConfigSchema, "nope")).toEqual(DEFAULT_RISK_CONFIG);
    expect(parseSetting(RiskConfigSchema, null)).toEqual(DEFAULT_RISK_CONFIG);
  });
});
