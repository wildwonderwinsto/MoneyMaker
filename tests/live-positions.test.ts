/**
 * Recent positions on a trader page when none are stored (owner, 2026-11-10): Candidates'
 * positions are pruned after scoring, so an unlocked admin gets them live from Polymarket.
 */
import { describe, expect, it } from "vitest";

import { positionResult, recentPositions } from "@/lib/jobs/backfill";
import type { Position } from "@/lib/polymarket/data";

const pos = (over: Partial<Position>): Position => ({
  proxy_wallet: "0xABC",
  token_id: "t1",
  condition_id: "c1",
  current_size: 0,
  avg_price: 0.5,
  total_size: 100,
  total_cost_usdc: 50,
  current_price: 0.5,
  current_value: 0,
  realized_pnl: 0,
  unrealized_pnl: 0,
  total_pnl: 0,
  status: "OPEN",
  redeemable: false,
  negative_risk: false,
  title: "Q",
  slug: "q",
  icon: null,
  event_id: "e1",
  event_slug: "e",
  outcome: "Yes",
  outcome_index: 0,
  end_date: null,
  first_entry_at: 1_790_000_000,
  last_event_at: 1_790_000_000,
  ...over,
});

describe("recentPositions", () => {
  it("merges open and closed newest first, at most `limit`, like the stored list", () => {
    const open = [pos({ token_id: "o1", status: "OPEN", current_size: 10, last_event_at: 300 })];
    const closed = [
      pos({ token_id: "c1", status: "CLOSED", last_event_at: 500 }),
      pos({ token_id: "c2", status: "REDEEMABLE", last_event_at: 100 }),
      // Shares from a split: no known cost, so (like the stored list) not shown.
      pos({ token_id: "split", status: "CLOSED", total_size: 0, last_event_at: 400 }),
    ];
    const rows = recentPositions(open, closed, 2);
    expect(rows.map((r) => r.tokenId)).toEqual(["c1", "o1"]);
    expect(rows[0].wallet).toBe("0xabc");
  });

  it("knows the result from Polymarket's status", () => {
    const rows = recentPositions(
      [],
      [
        pos({ token_id: "w", status: "REDEEMABLE", last_event_at: 3 }),
        pos({ token_id: "l", status: "REDEEMABLE_LOST", last_event_at: 2 }),
        pos({ token_id: "s", status: "CLOSED", last_event_at: 1 }),
      ],
      40,
    );
    expect(rows.map((r) => [r.tokenId, r.won])).toEqual([
      ["w", true],
      ["l", false],
      ["s", null],
    ]);
  });
});

describe("positionResult", () => {
  it("Won / Lost when settled, Sold when exited before, else Open", () => {
    expect(positionResult({ won: true, status: "CLOSED", size: 0 })).toBe("won");
    expect(positionResult({ won: false, status: "OPEN", size: 5 })).toBe("lost");
    // Sold before the market settled: was shown as "Open".
    expect(positionResult({ won: null, status: "CLOSED", size: 0.01 })).toBe("sold");
    expect(positionResult({ won: null, status: "OPEN", size: 0 })).toBe("sold");
    expect(positionResult({ won: null, status: "OPEN", size: 12 })).toBe("open");
  });

  it("live rows say Closed: Polymarket's CLOSED list marks settled-and-redeemed ones CLOSED too", () => {
    // Live check 2026-11-10: a wallet's 40 newest CLOSED positions all had status "CLOSED".
    expect(positionResult({ won: null, status: "CLOSED", size: 0 }, { live: true })).toBe("closed");
    expect(positionResult({ won: null, status: "OPEN", size: 3 }, { live: true })).toBe("open");
    expect(positionResult({ won: true, status: "REDEEMABLE", size: 3 }, { live: true })).toBe(
      "won",
    );
  });
});
