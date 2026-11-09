import { describe, expect, it } from "vitest";

import { codeFromReason, explain, positionsNote } from "@/lib/explain";

describe("explain", () => {
  it("explains a price-moved skip with the real numbers, including old signals", () => {
    const e = explain({
      reason: "Price moved to 73.0¢ (leader paid 47.3¢)",
      side: "BUY",
      outcome: "Yes",
    });
    expect(e.title).toMatch(/price ran away/);
    expect(e.body[0]).toContain("47.3¢");
    expect(e.body[0]).toContain("73.0¢");
    expect(e.body[0]).toContain("25.7¢ more");
  });

  it("mentions a whale order that swept the book", () => {
    const e = explain({
      reason: "x",
      code: "price_moved",
      details: {
        bestAsk: 0.73,
        leaderPrice: 0.473,
        limitPrice: 0.503,
        maxPriceDrift: 0.03,
        leaderShares: 1938,
        bestAskShares: 60,
      },
      retries: 2,
    });
    expect(e.body.join(" ")).toMatch(/1,938 shares/);
    expect(e.body.join(" ")).toMatch(/50\.3¢/);
    expect(e.body.join(" ")).toMatch(/re-checked it 2 times/);
  });

  it("maps every known reason text to a code", () => {
    expect(codeFromReason("Daily loss limit hit (10.5%)")).toBe("daily_loss");
    expect(codeFromReason("Leader trade too small ($7.71)")).toBe("leader_too_small");
    expect(codeFromReason("Copied on re-check: Bought 1 @ 2¢ ($3)")).toBe("bought");
    expect(codeFromReason("something new")).toBe("other");
    expect(codeFromReason("Already copied 2 buys into this position")).toBe("buy_limit");
    expect(codeFromReason("Best bid 1.0¢ is below your sell floor")).toBe("sell_floor");
    expect(explain({ reason: "Daily loss limit hit (10.5%)" }).body[0]).toContain("10.5%");
  });
});

describe("candidate history note", () => {
  it("tells the viewer a Candidate's history reloads at its next check", () => {
    // Owner request: candidates keep no position history between checks; the page must
    // say so instead of looking empty or broken.
    expect(positionsNote("candidate", 0)).toMatch(/reloads at the next check/);
    expect(positionsNote("rejected", 0)).toMatch(/only kept for/);
    expect(positionsNote("candidate", 12)).toBeNull();
  });
});
