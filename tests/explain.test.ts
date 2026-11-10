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

describe("sell floor on a leader merge (batch 6)", () => {
  it("explains the floor against the midpoint, not 'sold at 0¢'", async () => {
    const e = explain({
      reason: "Best bid 20.0¢ is below your sell floor",
      code: "sell_floor",
      details: { bestBid: 0.2, leaderPrice: 0, limitPrice: 0.396, midpoint: 0.495 },
    });
    expect(e.body.join(" ")).toContain("midpoint (49.5¢)");
    expect(e.body.join(" ")).not.toContain("sold at 0");
  });
});

describe("display helpers (UI polish 2026-11-10)", () => {
  it("shortens any hex-only name like a wallet, not just exact 40-character ones", async () => {
    const { traderName } = await import("@/lib/format");
    const wallet = "0x94d6530c8d6cf9a89c7f2e6a9cf4f2cb50df1210";
    expect(traderName({ name: "0x94d6530C8d6CF9A89c7F2E6a9CF4f2Cb50dF121", wallet })).toBe(
      "0x94d6…1210",
    );
    expect(traderName({ name: "CrazyCat-Kiwi", wallet })).toBe("CrazyCat-Kiwi");
    expect(traderName({ name: "0xKitty", wallet })).toBe("0xKitty"); // a real name
  });

  it("puts the trader's trade before our copy of it, oldest first", async () => {
    const { chronological } = await import("@/lib/live");
    const at = (s: number) => new Date(Date.UTC(2026, 10, 9, 21, 41, s));
    const items = [
      { key: "f1", kind: "ours" as const, ts: at(5) },
      { key: "s1", kind: "trader" as const, ts: at(0) },
      { key: "f0", kind: "ours" as const, ts: at(0) },
      { key: "s0", kind: "trader" as const, ts: at(0) },
    ];
    expect(chronological(items).map((i) => i.key)).toEqual(["s1", "s0", "f0", "f1"]);
  });
});

describe("copy-delay label fallback (UI polish 2026-11-10)", () => {
  it("uses today's setting for scores computed before the delay was stored", async () => {
    const { copiedLate } = await import("@/lib/format");
    expect(copiedLate(undefined, 120)).toBe("2 min late");
    expect(copiedLate(300, 120)).toBe("5 min late"); // the stored delay wins
    expect(copiedLate(undefined)).toBe("late");
  });
});
