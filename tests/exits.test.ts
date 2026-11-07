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
import { leaderSoldFraction, runTick } from "@/lib/copy/tick";
import type { Db } from "@/lib/db/client";
import { cursors, follows, paperPositions, signals } from "@/lib/db/schema";
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
