import { describe, expect, it } from "vitest";

import { groupSignals, type GroupableSignal } from "@/lib/live";

const sig = (over: Partial<GroupableSignal>): GroupableSignal => ({
  id: "x",
  wallet: "0xa",
  tokenId: "t",
  side: "BUY",
  decision: "skipped",
  reason: "Daily loss limit hit (10.5%)",
  reasonCode: null,
  groupId: null,
  leaderTs: new Date(1_000_000),
  leaderPrice: 0.85,
  leaderSize: 100,
  leaderUsdc: 85,
  ...over,
});

describe("groupSignals", () => {
  it("groups the same trader's repeated buys skipped for the same reason (the Tate McRae case)", () => {
    const rows = [
      sig({ id: "1", leaderUsdc: 118.74, leaderSize: 139.7 }),
      sig({ id: "2", leaderUsdc: 7.71, leaderSize: 9.07 }),
      sig({ id: "3", leaderUsdc: 105.57, leaderSize: 124.2 }),
      sig({ id: "4", wallet: "0xkimchi", tokenId: "no", leaderPrice: 0.12 }),
    ];
    const g = groupSignals(rows);
    expect(g).toHaveLength(2);
    expect(g[0].rows.map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(g[0].totalUsdc).toBeCloseTo(232.02);
    expect(g[0].avgPrice).toBeCloseTo(232.02 / 272.97);
  });

  it("keeps different decisions, reasons and distant times apart", () => {
    expect(
      groupSignals([sig({ id: "1" }), sig({ id: "2", decision: "copied", reason: "Bought" })]),
    ).toHaveLength(2);
    expect(
      groupSignals([sig({ id: "1" }), sig({ id: "2", reason: "Leader trade too small ($3)" })]),
    ).toHaveLength(2);
    expect(
      groupSignals([sig({ id: "1" }), sig({ id: "2", leaderTs: new Date(1_000_000 + 3_600_000) })]),
    ).toHaveLength(2);
  });

  it("always keeps an engine-merged order together", () => {
    const g = groupSignals([
      sig({ id: "1", groupId: "1", decision: "copied", reason: "Bought" }),
      sig({
        id: "2",
        groupId: "1",
        decision: "copied",
        reason: "Bought",
        leaderTs: new Date(9e12),
      }),
    ]);
    expect(g).toHaveLength(1);
  });
});
