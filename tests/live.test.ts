import { describe, expect, it } from "vitest";

import { groupSignals, sectionsByAge, summarize, type GroupableSignal } from "@/lib/live";

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

describe("sectionsByAge / summarize", () => {
  const HOUR = 3_600_000;
  const now = 100 * HOUR;
  const at = (hoursAgo: number, over: Partial<GroupableSignal> = {}) =>
    sig({
      id: `h${hoursAgo}`,
      wallet: `0x${hoursAgo}`,
      leaderTs: new Date(now - hoursAgo * HOUR),
      ...over,
    });
  const groups = groupSignals([
    at(0.1, { decision: "copied", reason: "Copied $5" }),
    at(0.5, { reason: "Price moved too far", reasonCode: "price_moved" }),
    at(3, { reason: "Price moved too far (again)", reasonCode: "price_moved" }),
    at(5, { decision: "closed", side: "SELL", reason: "Sold with the trader" }),
    at(30, { decision: "copied", reason: "Copied $9" }),
  ]);

  it("splits the feed into last hour, last 24 hours and older, dropping empty sections", () => {
    const sections = sectionsByAge(groups, now);
    expect(sections.map(([label, list]) => [label, list.length])).toEqual([
      ["Last hour", 2],
      ["Last 24 hours", 2],
      ["Older", 1],
    ]);
    expect(sectionsByAge(groups.slice(0, 1), now).map(([l]) => l)).toEqual(["Last hour"]);
  });

  it("counts only the last 24 hours and ranks skip reasons by code", () => {
    const s = summarize(groups, now);
    expect(s).toMatchObject({ total: 4, copied: 1, closed: 1, skipped: 2 });
    expect(s.topSkipReasons).toEqual([{ label: "Price moved too far", n: 2 }]);
  });
});
