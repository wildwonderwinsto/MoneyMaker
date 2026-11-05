import { describe, expect, it } from "vitest";

import { normalizeBook, priceAtOrAfter } from "@/lib/polymarket/clob";
import { legacyTradeId, tradeId, tradeIds } from "@/lib/polymarket/data";
import {
  categoryFromTags,
  DEFAULT_TAKER_FEE_RATE,
  GammaMarket,
  resolvedPayouts,
  takerFeeRate,
  winnerIndex,
} from "@/lib/polymarket/gamma";

describe("normalizeBook", () => {
  it("sorts best-first regardless of API ordering and drops empty levels", () => {
    const book = normalizeBook({
      asset_id: "t",
      bids: [
        { price: 0.01, size: 100 },
        { price: 0.8, size: 5 },
        { price: 0.79, size: 0 },
      ],
      asks: [
        { price: 0.99, size: 1 },
        { price: 0.81, size: 10 },
      ],
      tick_size: 0.01,
    });
    expect(book.bids.map((l) => l.price)).toEqual([0.8, 0.01]);
    expect(book.asks.map((l) => l.price)).toEqual([0.81, 0.99]);
  });
});

describe("priceAtOrAfter", () => {
  const h = [
    { t: 10, p: 0.1 },
    { t: 20, p: 0.2 },
    { t: 30, p: 0.3 },
  ];
  it("finds the first point at or after ts", () => {
    expect(priceAtOrAfter(h, 5)).toBe(0.1);
    expect(priceAtOrAfter(h, 20)).toBe(0.2);
    expect(priceAtOrAfter(h, 21)).toBe(0.3);
    expect(priceAtOrAfter(h, 31)).toBeNull();
  });
});

describe("gamma parsing", () => {
  const base = {
    id: "1",
    question: "Q?",
    conditionId: "0xc",
    outcomes: '["Yes", "No"]',
    clobTokenIds: '["111", "222"]',
  };

  it("decodes JSON-string arrays and finds the winner of a closed market", () => {
    const m = GammaMarket.parse({ ...base, closed: true, outcomePrices: '["0", "1"]' });
    expect(m.outcomes).toEqual(["Yes", "No"]);
    expect(m.clobTokenIds).toEqual(["111", "222"]);
    expect(winnerIndex(m)).toBe(1);
  });

  it("returns null for open or unsettled markets", () => {
    const open = GammaMarket.parse({ ...base, closed: false, outcomePrices: '["0", "1"]' });
    const unsettled = GammaMarket.parse({ ...base, closed: true, outcomePrices: '["0.5", "0.5"]' });
    expect(winnerIndex(open)).toBeNull();
    expect(winnerIndex(unsettled)).toBeNull();
    expect(GammaMarket.parse({ ...base, outcomePrices: "not json" }).outcomePrices).toEqual([]);
  });

  it("pays $1/$0 for a winner and $0.50 each for a resolved 50/50", () => {
    const won = GammaMarket.parse({ ...base, closed: true, outcomePrices: '["0", "1"]' });
    expect(resolvedPayouts(won)).toEqual([0, 1]);
    const split = { ...base, closed: true, outcomePrices: '["0.5", "0.5"]' };
    expect(
      resolvedPayouts(GammaMarket.parse({ ...split, umaResolutionStatus: "resolved" })),
    ).toEqual([0.5, 0.5]);
    // Closed but the oracle hasn't ruled yet (an untraded market also sits at 0.5/0.5).
    expect(resolvedPayouts(GammaMarket.parse({ ...split, umaResolutionStatus: "proposed" }))).toBe(
      null,
    );
    expect(resolvedPayouts(GammaMarket.parse({ ...base, outcomePrices: '["0.5", "0.5"]' }))).toBe(
      null,
    );
  });

  it("maps event tags to a top-level category", () => {
    expect(categoryFromTags([{ slug: "senate-elections" }, { slug: "politics" }])).toBe("politics");
    expect(categoryFromTags([{ slug: "nba" }])).toBe("sports");
    expect(categoryFromTags([{ slug: "unknown" }])).toBeNull();
    expect(categoryFromTags(null)).toBeNull();
  });

  it("reads each market's taker fee rate (fee-free when disabled or absent)", () => {
    const sports = GammaMarket.parse({
      ...base,
      feesEnabled: true,
      feeSchedule: { rate: 0.05, exponent: 1, takerOnly: true, rebateRate: 0.15 },
    });
    expect(takerFeeRate(sports)).toBe(0.05);
    expect(takerFeeRate(GammaMarket.parse({ ...base, feesEnabled: false }))).toBe(0);
    expect(takerFeeRate(GammaMarket.parse(base))).toBe(0);
    expect(takerFeeRate(GammaMarket.parse({ ...base, feesEnabled: true }))).toBe(
      DEFAULT_TAKER_FEE_RATE,
    );
  });
});

describe("tradeId", () => {
  it("is stable for the same trade and tells same-transaction fills apart", () => {
    const a = { transaction_hash: "0xAB", token_id: "9", side: "BUY", size: 45.7 };
    expect(tradeId(a)).toBe("0xab:9:BUY:45.7");
    expect(tradeId({ ...a, size: 666 })).not.toBe(tradeId(a));
  });

  it("keeps identical fills in one batch with an occurrence suffix", () => {
    const a = { transaction_hash: "0xh", token_id: "9", side: "BUY", size: 5 };
    const b = { ...a, size: 7 };
    expect(tradeIds([a, b, a, a])).toEqual([
      "0xh:9:BUY:5",
      "0xh:9:BUY:7",
      "0xh:9:BUY:5#2",
      "0xh:9:BUY:5#3",
    ]);
  });

  it("still recognizes ids written before fills were told apart", () => {
    expect(legacyTradeId({ transaction_hash: "0xh", token_id: "9", side: "BUY" })).toBe(
      "0xh:9:BUY",
    );
  });
});
