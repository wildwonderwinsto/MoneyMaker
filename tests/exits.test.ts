/**
 * Exits and missed trades: the copy must follow the leader out by the right amount, and a
 * failure anywhere (positions API, order book, database write) must never silently turn
 * into a wrong exit or a lost trade.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as account from "@/lib/copy/account";
import { DEFAULT_RISK_CONFIG } from "@/lib/copy/config";
import { mergeFills, type LeaderTrade } from "@/lib/copy/engine";
import { executeHedge, exitTrader, leaderSoldFraction, runTick } from "@/lib/copy/tick";
import type { Db } from "@/lib/db/client";
import { cursors, follows, paperAccounts, paperPositions, signals } from "@/lib/db/schema";
import * as clob from "@/lib/polymarket/clob";
import * as data from "@/lib/polymarket/data";
import * as gamma from "@/lib/polymarket/gamma";
import { writeSetting } from "@/lib/settings";

import { createTestDb } from "./helpers/db";
import { expectBalanced } from "./helpers/invariant";

vi.mock("@/lib/polymarket/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/data")>()),
  getActivity: vi.fn(),
  getPositions: vi.fn(),
}));
vi.mock("@/lib/polymarket/clob", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/clob")>()),
  getBook: vi.fn(),
  getMidpoints: vi.fn(),
}));
vi.mock("@/lib/polymarket/gamma", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/gamma")>()),
  getMarketsByConditionIds: vi.fn(),
}));
vi.mock("@/lib/copy/account", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/lib/copy/account")>();
  return { ...m, applyBuy: vi.fn(m.applyBuy) };
});

const LEADER = "0xleader";
const COND = "0xcond";
const YES = "111";
const NO = "222";
const t0 = Math.floor(Date.now() / 1000);

let db: Db;
let close: () => Promise<void>;
let rows: data.Activity[];

const act = (over: Partial<data.Activity>): data.Activity => ({
  proxy_wallet: LEADER,
  timestamp: t0 + 10,
  condition_id: COND,
  type: "TRADE",
  size: 200,
  usdc_size: 100,
  transaction_hash: "0xtx1",
  price: 0.5,
  token_id: YES,
  side: "BUY",
  outcome_index: 0,
  title: "Q",
  slug: "q",
  icon: null,
  event_slug: null,
  outcome: "Yes",
  name: null,
  pseudonym: null,
  ...over,
});
const page = <T>(items: T[]) => ({
  data: items,
  pagination: { has_more: false, next_cursor: null },
});
const position = (size: number, lastEventAt: number) =>
  ({ token_id: YES, current_size: size, last_event_at: lastEventAt }) as unknown as data.Position;
const book = (tokenId: string) => ({
  tokenId,
  asks: [{ price: 0.5, size: 10_000 }],
  bids: [{ price: 0.49, size: 10_000 }],
  tickSize: 0.01,
  minOrderSize: 1,
  timestamp: Date.now(),
});
const market = gamma.GammaMarket.parse({
  id: "1",
  question: "Q",
  conditionId: COND,
  slug: "q",
  endDate: new Date((t0 + 7 * 86_400) * 1000).toISOString(),
  closed: false,
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.5","0.5"]',
  clobTokenIds: `["${YES}","${NO}"]`,
});

const openShares = async () =>
  (await db.select().from(paperPositions).where(eq(paperPositions.status, "open"))).map(
    (p) => p.shares,
  );
const signalOf = async (hash: string) =>
  (await db.select().from(signals)).find((s) => s.id.startsWith(hash));

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(follows).values({ wallet: LEADER });
  await db.insert(cursors).values({ wallet: LEADER, lastTs: t0 - 60 });
  // Fixed $20 copies at 50¢ = 40 shares, so every fraction is easy to check by hand.
  await writeSetting(db, "risk", { ...DEFAULT_RISK_CONFIG, sizingMode: "fixed", fixedUsd: 20 });
  rows = [];
  vi.mocked(clob.getBook).mockImplementation(async (id: string) => book(id));
  vi.mocked(clob.getMidpoints).mockResolvedValue(new Map());
  vi.mocked(gamma.getMarketsByConditionIds).mockResolvedValue([market]);
  vi.mocked(data.getActivity).mockImplementation(async ({ user, start, limit }) =>
    page(
      rows
        .filter((r) => r.proxy_wallet === user && r.timestamp >= (start ?? 0))
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(0, limit ?? 1000),
    ),
  );
  vi.mocked(data.getPositions).mockResolvedValue(page([]));
});
afterEach(async () => {
  await expectBalanced(db);
  await close();
  vi.mocked(data.getPositions).mockReset();
});

describe("leader's position can't be loaded", () => {
  it("does not treat a partial sell as a full exit; re-checks once the position loads", async () => {
    rows = [act({ transaction_hash: "0xbuy" })];
    await runTick(db, (t0 + 20) * 1000);
    expect(await openShares()).toEqual([40]);

    // Leader sells 20 of 200 (10%) while /positions is down.
    rows.push(
      act({
        transaction_hash: "0xsell",
        side: "SELL",
        size: 20,
        usdc_size: 9.8,
        timestamp: t0 + 30,
      }),
    );
    vi.mocked(data.getPositions).mockRejectedValue(new Error("HTTP 503"));
    await runTick(db, (t0 + 40) * 1000);
    expect(await openShares()).toEqual([40]); // nothing sold on a guess
    expect((await signalOf("0xsell"))?.reasonCode).toBe("sell_size_unknown");

    // Positions are back: 180 left after the sell → 10% sold → we sell 4 of 40.
    vi.mocked(data.getPositions).mockResolvedValue(page([position(180, t0 + 30)]));
    await runTick(db, (t0 + 55) * 1000);
    expect((await openShares())[0]).toBeCloseTo(36, 6);
    expect((await signalOf("0xsell"))?.decision).toBe("closed");
  });

  it("a brand-new position the API doesn't list yet is sized from the trades we saw", async () => {
    // Leader buys 200 at t+10, then sells 50 at t+15, before /positions lists the position.
    rows = [act({ transaction_hash: "0xbuy" })];
    await runTick(db, (t0 + 12) * 1000);
    rows.push(
      act({
        transaction_hash: "0xsell",
        side: "SELL",
        size: 50,
        usdc_size: 24.5,
        timestamp: t0 + 15,
      }),
    );
    await runTick(db, (t0 + 16) * 1000);
    expect((await openShares())[0]).toBeCloseTo(30, 6); // 25% of 40 sold, not 100%
  });

  it("an unlisted position is sized from the leader trades recorded for our copy, however old", async () => {
    // Leader buys 200 at t+10 (copied); /positions still doesn't list it 50 s later, when
    // they sell 20 (10%). A lag longer than any fixed window must not become a full exit.
    rows = [act({ transaction_hash: "0xbuy" })];
    await runTick(db, (t0 + 20) * 1000);
    rows.push(
      act({
        transaction_hash: "0xsell",
        side: "SELL",
        size: 20,
        usdc_size: 9.8,
        timestamp: t0 + 60,
      }),
    );
    await runTick(db, (t0 + 65) * 1000);
    expect((await openShares())[0]).toBeCloseTo(36, 6); // 10% of 40 sold, not 100%
  });

  it("a listed but stale position also counts the trades we recorded after its snapshot", async () => {
    // Leader buys 100 at t+10 and 100 at t+40 (both copied: 80 shares). /positions still
    // shows 100 as of t+10 when they sell 20 at t+60, so they sold 10%, not 20%.
    rows = [act({ transaction_hash: "0xbuy1", size: 100, usdc_size: 50 })];
    await runTick(db, (t0 + 20) * 1000);
    rows.push(act({ transaction_hash: "0xbuy2", size: 100, usdc_size: 50, timestamp: t0 + 40 }));
    vi.mocked(data.getPositions).mockResolvedValue(page([position(100, t0 + 10)]));
    await runTick(db, (t0 + 45) * 1000);
    rows.push(
      act({
        transaction_hash: "0xsell",
        side: "SELL",
        size: 20,
        usdc_size: 9.8,
        timestamp: t0 + 60,
      }),
    );
    await runTick(db, (t0 + 65) * 1000);
    expect((await openShares())[0]).toBeCloseTo(72, 6);
  });

  it("the same on re-check: trades recorded between the snapshot and the exit count", async () => {
    rows = [act({ transaction_hash: "0xbuy1", size: 100, usdc_size: 50 })];
    await runTick(db, (t0 + 20) * 1000);
    rows.push(act({ transaction_hash: "0xbuy2", size: 100, usdc_size: 50, timestamp: t0 + 40 }));
    vi.mocked(data.getPositions).mockResolvedValue(page([position(100, t0 + 10)]));
    await runTick(db, (t0 + 45) * 1000);
    rows.push(
      act({
        transaction_hash: "0xsell",
        side: "SELL",
        size: 20,
        usdc_size: 9.8,
        timestamp: t0 + 60,
      }),
    );
    vi.mocked(clob.getBook).mockRejectedValue(new Error("timeout"));
    await runTick(db, (t0 + 65) * 1000);
    vi.mocked(clob.getBook).mockImplementation(async (id: string) => book(id));
    expect((await signalOf("0xsell"))?.reasonCode).toBe("no_buyers");
    await runTick(db, (t0 + 80) * 1000); // re-check; snapshot still 100 as of t+10
    expect((await openShares())[0]).toBeCloseTo(72, 6);
  });

  it("an unlisted position also counts the leader's buys we skipped before our copy opened", async () => {
    // A $10 buy (100 @ 10¢: under the $25 minimum, skipped; 40 s before the next, so not
    // merged with it), then a $50 buy we copy (40 shares). They
    // hold 200 when they sell 20 with /positions lagging: 10%, not 20%.
    rows = [
      act({
        transaction_hash: "0xsmall",
        price: 0.1,
        usdc_size: 10,
        size: 100,
        timestamp: t0 - 30,
      }),
    ];
    rows.push(act({ transaction_hash: "0xbuy", size: 100, usdc_size: 50 }));
    await runTick(db, (t0 + 20) * 1000);
    expect((await signalOf("0xsmall"))?.decision).toBe("skipped");
    rows.push(
      act({
        transaction_hash: "0xsell",
        side: "SELL",
        size: 20,
        usdc_size: 9.8,
        timestamp: t0 + 60,
      }),
    );
    await runTick(db, (t0 + 65) * 1000);
    expect((await openShares())[0]).toBeCloseTo(36, 6);
  });

  it("a re-checked exit of a position the API still doesn't list isn't a full exit either", async () => {
    rows = [act({ transaction_hash: "0xbuy" })];
    await runTick(db, (t0 + 20) * 1000);
    rows.push(
      act({
        transaction_hash: "0xsell",
        side: "SELL",
        size: 20,
        usdc_size: 9.8,
        timestamp: t0 + 60,
      }),
    );
    vi.mocked(clob.getBook).mockRejectedValue(new Error("timeout"));
    await runTick(db, (t0 + 65) * 1000);
    vi.mocked(clob.getBook).mockImplementation(async (id: string) => book(id));
    expect((await signalOf("0xsell"))?.reasonCode).toBe("no_buyers");

    await runTick(db, (t0 + 80) * 1000); // re-check; /positions still lags
    expect((await openShares())[0]).toBeCloseTo(36, 6);
    expect((await signalOf("0xsell"))?.decision).toBe("closed");
  });
});

describe("market info missing", () => {
  it("a buy skipped because Gamma didn't return the market is copied once it does", async () => {
    // Regression (C-F10): an empty Gamma answer made the buy a no_market skip that was
    // never re-checked, so the trade was lost for good.
    vi.mocked(gamma.getMarketsByConditionIds).mockResolvedValue([]);
    rows = [act({ transaction_hash: "0xbuy" })];
    await runTick(db, (t0 + 20) * 1000);
    expect((await signalOf("0xbuy"))?.reasonCode).toBe("no_market");
    expect(await openShares()).toEqual([]);

    vi.mocked(gamma.getMarketsByConditionIds).mockResolvedValue([market]);
    await runTick(db, (t0 + 40) * 1000);
    expect((await signalOf("0xbuy"))?.decision).toBe("copied");
    expect((await openShares())[0]).toBeCloseTo(40, 6);
  });
});

describe("a skipped exit is re-checked", () => {
  it("sells once buyers are back after an order-book failure", async () => {
    rows = [act({ transaction_hash: "0xbuy" })];
    await runTick(db, (t0 + 20) * 1000);
    rows.push(
      act({
        transaction_hash: "0xsell",
        side: "SELL",
        size: 200,
        usdc_size: 98,
        timestamp: t0 + 30,
      }),
    );
    // The order book can't be loaded for the whole first tick.
    vi.mocked(clob.getBook).mockRejectedValue(new Error("timeout"));
    await runTick(db, (t0 + 40) * 1000);
    vi.mocked(clob.getBook).mockImplementation(async (id: string) => book(id));
    expect((await signalOf("0xsell"))?.reasonCode).toBe("no_buyers");
    expect(await openShares()).toEqual([40]);

    await runTick(db, (t0 + 55) * 1000); // book is fine now; leader is fully out
    expect(await openShares()).toEqual([]);
    expect((await signalOf("0xsell"))?.decision).toBe("closed");
  });
});

describe("a trade whose database write fails", () => {
  it("is retried on the next tick instead of being skipped by the cursor", async () => {
    rows = [
      act({ transaction_hash: "0xboom", timestamp: t0 + 10 }),
      act({ transaction_hash: "0xok", timestamp: t0 + 20, token_id: NO, outcome: "No" }),
    ];
    vi.mocked(account.applyBuy).mockImplementationOnce(async () => {
      throw new Error("connection terminated unexpectedly");
    });
    const s1 = await runTick(db, (t0 + 30) * 1000);
    expect(s1.errors).toHaveLength(1);
    await runTick(db, (t0 + 45) * 1000);
    expect((await signalOf("0xboom"))?.decision).toBe("copied");
    expect(await openShares()).toHaveLength(2);
  });
});

describe("a leader exit that fills in pieces", () => {
  const sell = (id: string, ts: number, size: number): LeaderTrade => ({
    id,
    wallet: "0xl",
    ts,
    conditionId: "c",
    tokenId: "t",
    side: "SELL",
    price: 0.5,
    size,
    usdc: size / 2,
    outcome: "Yes",
    title: null,
    slug: null,
  });

  it("judges each piece by its own time when the positions API has seen only some", () => {
    // Held 200; sold 100 at t=1000 and 100 at t=1020 (fully out). /positions has applied
    // only the first piece: size 100, lastEventAt 1000.
    const pieces = [sell("a", 1000, 100), sell("b", 1020, 100)];
    const [merged] = mergeFills(pieces, 30, 0.03);
    expect(leaderSoldFraction(merged, pieces, { size: 100, lastEventAt: 1000 })).toBe(1);
  });
});

describe("leader exits by merge or conversion (owner, 2026-11-09)", () => {
  // A merge turns YES+NO pairs back into $1 each: no token, no side, just the market.
  const merge = (size: number, hash: string, ts = t0 + 30) =>
    act({
      type: "MERGE",
      transaction_hash: hash,
      token_id: "",
      side: null,
      price: 0,
      size,
      usdc_size: size,
      outcome_index: 999,
      timestamp: ts,
    });

  it("a merge of half the leader's holding sells half our copy", async () => {
    rows = [act({ transaction_hash: "0xbuy" })];
    await runTick(db, (t0 + 20) * 1000);
    expect(await openShares()).toEqual([40]);
    rows.push(merge(100, "0xmerge"));
    vi.mocked(data.getPositions).mockResolvedValue(page([position(100, t0 + 30)])); // 200 → 100
    await runTick(db, (t0 + 40) * 1000);
    expect((await openShares())[0]).toBeCloseTo(20, 6);
    expect((await signalOf("0xmerge"))?.decision).toBe("closed");
  });

  it("a merge of the whole holding closes our copy", async () => {
    rows = [act({ transaction_hash: "0xbuy" })];
    await runTick(db, (t0 + 20) * 1000);
    rows.push(merge(200, "0xmergeall"));
    vi.mocked(data.getPositions).mockResolvedValue(page([])); // leader holds none of it now
    await runTick(db, (t0 + 40) * 1000);
    expect(await openShares()).toEqual([]);
  });

  it("a conversion is flagged on the Live page, never sold automatically", async () => {
    rows = [act({ transaction_hash: "0xbuy" })];
    await runTick(db, (t0 + 20) * 1000);
    rows.push(
      act({
        type: "CONVERSION",
        transaction_hash: "0xconv",
        token_id: "",
        side: null,
        price: 0,
        size: 50,
        usdc_size: 100,
        outcome_index: 999,
        timestamp: t0 + 30,
      }),
    );
    await runTick(db, (t0 + 40) * 1000);
    expect(await openShares()).toEqual([40]);
    expect(await signalOf("0xconv")).toMatchObject({
      decision: "skipped",
      reasonCode: "leader_converted",
      tokenId: YES,
    });
  });

  it("a merge or conversion in a market we hold no copy in is ignored", async () => {
    rows = [merge(100, "0xother")];
    await runTick(db, (t0 + 40) * 1000);
    expect(await signalOf("0xother")).toBeUndefined();
  });
});

describe("the sell floor when there's no trader price (batch 6)", () => {
  // After the copy: 10 shares bid at 49¢, then nothing until 20¢. Midpoint (49 + 50) / 2.
  const thin = (tokenId: string) => ({
    ...book(tokenId),
    bids: [
      { price: 0.49, size: 10 },
      { price: 0.2, size: 10_000 },
    ],
  });
  const floor20 = {
    ...DEFAULT_RISK_CONFIG,
    sizingMode: "fixed" as const,
    fixedUsd: 20,
    sellFloorPct: 0.2,
  };

  it("Hide sells only what the floor allows below the market midpoint", async () => {
    rows = [act({ transaction_hash: "0xbuy" })];
    await runTick(db, (t0 + 20) * 1000);
    expect(await openShares()).toEqual([40]);
    await writeSetting(db, "risk", floor20);
    vi.mocked(clob.getBook).mockImplementation(async (id: string) => thin(id));
    // Floor 49.5¢ × 0.8 = 39.6¢: the 10 shares at 49¢ go, the 30 that would fetch 20¢ stay.
    const r = await exitTrader(db, LEADER, (t0 + 40) * 1000);
    expect(r).toMatchObject({ sold: 1, left: 1 });
    expect(r.proceeds).toBeCloseTo(10 * 0.49, 6);
    expect((await openShares())[0]).toBeCloseTo(30, 6);
  });

  it("a leader merge sells only what the floor allows below the market midpoint", async () => {
    rows = [act({ transaction_hash: "0xbuy" })];
    await runTick(db, (t0 + 20) * 1000);
    await writeSetting(db, "risk", floor20);
    vi.mocked(clob.getBook).mockImplementation(async (id: string) => thin(id));
    rows.push(
      act({
        type: "MERGE",
        transaction_hash: "0xmergefloor",
        token_id: "",
        side: null,
        price: 0,
        size: 200,
        usdc_size: 200,
        outcome_index: 999,
        timestamp: t0 + 30,
      }),
    );
    vi.mocked(data.getPositions).mockResolvedValue(page([])); // fully merged out
    await runTick(db, (t0 + 40) * 1000);
    // Floor 49.5¢ × 0.8 = 39.6¢: 10 shares sell at 49¢, 30 stay open (not dumped at 20¢).
    expect((await openShares())[0]).toBeCloseTo(30, 6);
    const sig = await signalOf("0xmergefloor");
    expect(sig?.decision).toBe("closed");
    expect((sig?.details as { limitPrice?: number }).limitPrice).toBeCloseTo(0.396, 6);
  });

  it("a hedge sold with the copy respects the floor too (owner, 2026-11-10)", async () => {
    rows = [act({ transaction_hash: "0xbuy" })];
    await runTick(db, (t0 + 20) * 1000);
    const [copy] = await db.select().from(paperPositions);
    const hedged = await executeHedge(db, copy.accountId, copy.id, "lock", DEFAULT_RISK_CONFIG, {
      maxCost: Number.POSITIVE_INFINITY,
    });
    expect(hedged.ok).toBe(true);
    await writeSetting(db, "risk", floor20);
    // Yes still has deep bids; the hedge's No side is thin (10 at 49¢, then 20¢).
    vi.mocked(clob.getBook).mockImplementation(async (id: string) =>
      id === NO ? thin(id) : book(id),
    );
    rows.push(act({ transaction_hash: "0xsellall", side: "SELL", size: 200, timestamp: t0 + 30 }));
    vi.mocked(data.getPositions).mockResolvedValue(page([])); // leader fully out
    await runTick(db, (t0 + 40) * 1000);
    const open = await db.select().from(paperPositions).where(eq(paperPositions.status, "open"));
    // Copy gone; hedge: 10 sold at 49¢, 30 kept rather than dumped at 20¢ (floor 39.6¢).
    expect(open.map((p) => [p.kind, Number(p.shares.toFixed(6))])).toEqual([["hedge", 30]]);
  });

  it("Hide with the floor off still sells everything", async () => {
    rows = [act({ transaction_hash: "0xbuy" })];
    await runTick(db, (t0 + 20) * 1000);
    vi.mocked(clob.getBook).mockImplementation(async (id: string) => thin(id));
    const r = await exitTrader(db, LEADER, (t0 + 40) * 1000);
    expect(r).toMatchObject({ sold: 1, left: 0 });
    expect(await openShares()).toEqual([]);
  });
});

describe("skips that can never be retried don't block ones that can (N1/N2)", () => {
  const dead = (i: number, side: "BUY" | "SELL", wallet: string, accountId: number) => ({
    id: `dead${side}${i}`,
    wallet,
    leaderTs: new Date((t0 - 100 + i * 0.01) * 1000),
    conditionId: COND,
    tokenId: "999",
    side,
    leaderPrice: 0.5,
    leaderSize: 10,
    leaderUsdc: 50,
    decision: "skipped" as const,
    reason: side === "SELL" ? "No buyers in the order book" : "Price moved",
    reasonCode: side === "SELL" ? ("no_buyers" as const) : ("price_moved" as const),
    source: "poll" as const,
    accountId,
  });

  it("a stranded exit is retried even with 200 older skips whose copy is gone (N1)", async () => {
    rows = [act({ transaction_hash: "0xbuy" })];
    await runTick(db, (t0 + 20) * 1000);
    const [copy] = await db.select().from(paperPositions);
    await db
      .insert(signals)
      .values(Array.from({ length: 200 }, (_, i) => dead(i, "SELL", LEADER, copy.accountId)));
    vi.mocked(clob.getBook).mockImplementation(async (id: string) => ({ ...book(id), bids: [] }));
    rows.push(act({ transaction_hash: "0xsell", side: "SELL", size: 200, timestamp: t0 + 30 }));
    await runTick(db, (t0 + 40) * 1000);
    expect((await signalOf("0xsell"))?.reasonCode).toBe("no_buyers");
    vi.mocked(clob.getBook).mockImplementation(async (id: string) => book(id)); // buyers back
    await runTick(db, (t0 + 60) * 1000);
    expect(await openShares()).toEqual([]);
  });

  it("a skipped buy is retried even with 200 older skips that can't be copied (N2)", async () => {
    await writeSetting(db, "risk", {
      ...DEFAULT_RISK_CONFIG,
      sizingMode: "fixed",
      fixedUsd: 20,
      maxSignalAgeSeconds: 600,
    });
    rows = [act({ transaction_hash: "0xbuy" })];
    vi.mocked(clob.getBook).mockImplementation(async (id: string) => ({
      ...book(id),
      asks: [{ price: 0.6, size: 10_000 }], // price ran away
    }));
    await runTick(db, (t0 + 20) * 1000);
    expect((await signalOf("0xbuy"))?.reasonCode).toBe("price_moved");
    // 200 older skips from a trader no longer followed: never copyable again.
    const [acct] = await db.select().from(paperAccounts);
    await db
      .insert(signals)
      .values(Array.from({ length: 200 }, (_, i) => dead(i, "BUY", "0xgone", acct.id)));
    vi.mocked(clob.getBook).mockImplementation(async (id: string) => book(id)); // sellers back
    await runTick(db, (t0 + 40) * 1000);
    expect(await openShares()).toEqual([40]);
  });
});

describe("copies in one batch share the order book (C-F16)", () => {
  it("the second copy fills only what the first left in the book", async () => {
    // Only 50 shares for sale at 50¢; each $20 copy wants 40.
    vi.mocked(clob.getBook).mockImplementation(async (id: string) => ({
      ...book(id),
      asks: [{ price: 0.5, size: 50 }],
    }));
    // Two separate orders (40 s apart, so not merged), seen in the same poll.
    rows = [
      act({ transaction_hash: "0xb1", timestamp: t0 + 10 }),
      act({ transaction_hash: "0xb2", timestamp: t0 + 50 }),
    ];
    await runTick(db, (t0 + 60) * 1000);
    const total = (await openShares()).reduce((a, x) => a + x, 0);
    expect(total).toBeCloseTo(50, 6); // was 80: both copies filled from the same 50
  });
});
