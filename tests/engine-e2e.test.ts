/**
 * Real-time copying, re-checks, merged fills and hedges, end to end against an in-memory
 * Postgres with the Polymarket APIs mocked.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { executeHedge, quoteHedge, runStreamBatch, runTick } from "@/lib/copy/tick";
import { DEFAULT_RISK_CONFIG } from "@/lib/copy/config";
import type { LeaderTrade } from "@/lib/copy/engine";
import type { Db } from "@/lib/db/client";
import {
  appSettings,
  cursors,
  follows,
  paperAccounts,
  paperFills,
  paperPositions,
  signals,
} from "@/lib/db/schema";
import * as clob from "@/lib/polymarket/clob";
import * as data from "@/lib/polymarket/data";
import * as gamma from "@/lib/polymarket/gamma";

import { createTestDb } from "./helpers/db";

vi.mock("@/lib/polymarket/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/data")>()),
  getActivity: vi.fn(),
  getPortfolioValue: vi.fn(),
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

const LEADER = "0xleader";
const COND = "0xcond";
const YES = "111";
const NO = "222";
const t0 = Math.floor(Date.now() / 1000);

let db: Db;
let close: () => Promise<void>;

const book = (tokenId: string, asks: Array<[number, number]>, bids: Array<[number, number]>) => ({
  tokenId,
  asks: asks.map(([price, size]) => ({ price, size })),
  bids: bids.map(([price, size]) => ({ price, size })),
  tickSize: 0.01,
  minOrderSize: 1,
  timestamp: Date.now(),
});
let books: Record<string, ReturnType<typeof book>>;

const streamTrade = (over: Partial<LeaderTrade>): LeaderTrade => ({
  id: "0xs1:111:BUY:100",
  wallet: LEADER,
  ts: t0,
  conditionId: COND,
  tokenId: YES,
  side: "BUY",
  price: 0.5,
  size: 100,
  usdc: 50,
  outcome: "Yes",
  title: "Will it happen?",
  slug: "will-it-happen",
  icon: "https://img/x.png",
  ...over,
});

const activityFrom = (t: LeaderTrade, txHash: string): data.Activity => ({
  proxy_wallet: t.wallet,
  timestamp: t.ts,
  condition_id: t.conditionId,
  type: "TRADE",
  size: t.size,
  usdc_size: t.usdc,
  transaction_hash: txHash,
  price: t.price,
  token_id: t.tokenId,
  side: t.side,
  outcome_index: 0,
  title: t.title,
  slug: t.slug,
  icon: null,
  event_slug: null,
  outcome: t.outcome,
  name: null,
  pseudonym: null,
});

const page = <T>(items: T[]) => ({
  data: items,
  pagination: { has_more: false, next_cursor: null },
});

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(follows).values({ wallet: LEADER });
  await db.insert(cursors).values({ wallet: LEADER, lastTs: t0 - 60 });
  // Fixed $20 copies keep the arithmetic readable.
  await db.insert(appSettings).values({
    key: "risk",
    value: { ...DEFAULT_RISK_CONFIG, sizingMode: "fixed", fixedUsd: 20, minLeaderUsd: 25 },
  });
});
afterAll(async () => close());

beforeEach(() => {
  books = {
    [YES]: book(YES, [[0.5, 1000]], [[0.49, 1000]]),
    [NO]: book(NO, [[0.51, 1000]], [[0.5, 1000]]),
  };
  vi.mocked(clob.getBook).mockImplementation(async (id: string) => books[id]);
  vi.mocked(clob.getMidpoints).mockResolvedValue(new Map());
  vi.mocked(data.getPortfolioValue).mockResolvedValue(10_000);
  vi.mocked(data.getActivity).mockResolvedValue(page([]));
  vi.mocked(gamma.getMarketsByConditionIds).mockResolvedValue([
    gamma.GammaMarket.parse({
      id: "1",
      question: "Will it happen?",
      conditionId: COND,
      slug: "will-it-happen",
      endDate: new Date((t0 + 7 * 86_400) * 1000).toISOString(),
      closed: false,
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.5","0.5"]',
      clobTokenIds: `["${YES}","${NO}"]`,
      events: [{ id: "e1", slug: "the-event" }],
    }),
  ]);
});

const cash = async () => (await db.select().from(paperAccounts))[0].cash;
const openCopy = async () =>
  (
    await db
      .select()
      .from(paperPositions)
      .where(and(eq(paperPositions.status, "open"), eq(paperPositions.kind, "copy")))
  )[0];

describe("real-time copying", () => {
  it("copies a feed trade, merging the order's pieces so the size filter sees all of it", async () => {
    // $15 + $15: each piece is under the $25 minimum, the order as a whole is not.
    const s = await runStreamBatch(
      db,
      [
        streamTrade({ id: "0xs1:111:BUY:30", size: 30, usdc: 15 }),
        streamTrade({ id: "0xs1:111:BUY:30#2", size: 30, usdc: 15 }),
      ],
      (t0 + 2) * 1000,
    );
    expect(s).toMatchObject({ source: "stream", newTrades: 2, copied: 1, errors: [] });
    expect(await cash()).toBeCloseTo(980, 6);
    const rows = await db.select().from(signals);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.decision === "copied" && r.groupId === "0xs1:111:BUY:30")).toBe(
      true,
    );
    expect(rows[0].source).toBe("stream");
    // Gamma had no image for this market: the feed's icon is used instead.
    expect((await openCopy()).image).toBe("https://img/x.png");
  });

  it("never copies the same trade twice when the poll sees it later", async () => {
    vi.mocked(data.getActivity).mockResolvedValue(
      page([
        activityFrom(streamTrade({ size: 30, usdc: 15 }), "0xs1"),
        activityFrom(streamTrade({ size: 30, usdc: 15 }), "0xs1"),
      ]),
    );
    const s = await runTick(db, (t0 + 20) * 1000);
    expect(s.newTrades).toBe(0);
    expect(await cash()).toBeCloseTo(980, 6);
  });

  it("re-checks a 'price moved' skip and copies once sellers come back", async () => {
    books[YES] = book(YES, [[0.8, 1000]], [[0.49, 1000]]); // a whale swept the book
    const s1 = await runStreamBatch(
      db,
      [streamTrade({ id: "0xs2:111:BUY:200", size: 200, usdc: 100, ts: t0 + 30 })],
      (t0 + 31) * 1000,
    );
    expect(s1.ignored).toBe(1);
    const [skipped] = await db.select().from(signals).where(eq(signals.id, "0xs2:111:BUY:200"));
    expect(skipped).toMatchObject({ decision: "skipped", reasonCode: "price_moved" });
    expect(skipped.details).toMatchObject({ bestAsk: 0.8, leaderPrice: 0.5, leaderShares: 200 });

    // Still too high: stays skipped, retry counted.
    await runTick(db, (t0 + 45) * 1000);
    const [still] = await db.select().from(signals).where(eq(signals.id, "0xs2:111:BUY:200"));
    expect(still).toMatchObject({ decision: "skipped", retries: 1 });

    books[YES] = book(YES, [[0.51, 1000]], [[0.49, 1000]]); // sellers are back
    const cashBefore = await cash();
    const s2 = await runTick(db, (t0 + 60) * 1000);
    expect(s2.retried).toBe(1);
    const [copied] = await db.select().from(signals).where(eq(signals.id, "0xs2:111:BUY:200"));
    expect(copied.decision).toBe("copied");
    expect(copied.reason).toMatch(/Copied on re-check/);
    expect(await cash()).toBeCloseTo(cashBefore - 20, 6);
  });

  it("doesn't buy on re-check once the leader has sold", async () => {
    // The NO side, so the YES copy the hedging tests use stays untouched.
    books[NO] = book(NO, [[0.8, 1000]], [[0.49, 1000]]); // swept
    const leg = { tokenId: NO, outcome: "No", size: 200, usdc: 100 };
    const buy = streamTrade({ ...leg, id: "0xs3:222:BUY:200", ts: t0 + 70 });
    await runStreamBatch(db, [buy], (t0 + 71) * 1000);
    vi.mocked(data.getPositions).mockResolvedValue(page([])); // leader fully exited
    const sell = streamTrade({ ...leg, id: "0xs4:222:SELL:200", side: "SELL", ts: t0 + 80 });
    await runStreamBatch(db, [sell], (t0 + 81) * 1000);

    books[NO] = book(NO, [[0.51, 1000]], [[0.49, 1000]]); // price is back
    const s = await runTick(db, (t0 + 90) * 1000);
    expect(s.retried).toBe(0);
    const [sig] = await db.select().from(signals).where(eq(signals.id, buy.id));
    expect(sig).toMatchObject({ decision: "skipped", reasonCode: "price_moved" });
  });
});

describe("hedging", () => {
  it("quotes both hedge modes and buys a lock hedge on request", async () => {
    const pos = await openCopy();
    const cfg = { ...DEFAULT_RISK_CONFIG, hedgeMaxCostPct: 1 };
    const q = await quoteHedge(db, pos.accountId, pos.id, cfg);
    expect(q.ok).toBe(true);
    expect(q.opposite).toEqual({ tokenId: NO, outcome: "No" });
    expect(q.lock!.shares).toBeCloseTo(pos.shares, 6);
    expect(q.lock!.pnlIfOursWins).toBeCloseTo(q.lock!.pnlIfOppositeWins, 6);

    const res = await executeHedge(db, pos.accountId, pos.id, "lock", cfg);
    expect(res.ok).toBe(true);
    const [hedge] = await db.select().from(paperPositions).where(eq(paperPositions.kind, "hedge"));
    expect(hedge).toMatchObject({ hedgeOf: pos.id, tokenId: NO, outcome: "No", status: "open" });
    expect(hedge.shares).toBeCloseTo(pos.shares, 6);

    const again = await executeHedge(db, pos.accountId, pos.id, "lock", cfg);
    expect(again).toMatchObject({ ok: false, message: "Already hedged" });
  });

  it("sells the hedge together with the copy when the leader exits", async () => {
    const pos = await openCopy();
    vi.mocked(data.getActivity).mockResolvedValue(
      page([
        activityFrom(
          streamTrade({ side: "SELL", size: 200, usdc: 100, ts: t0 + 80, price: 0.5 }),
          "0xsell",
        ),
      ]),
    );
    vi.mocked(data.getPositions).mockResolvedValue(page([])); // leader fully out
    const s = await runTick(db, (t0 + 90) * 1000);
    expect(s.closed).toBe(1);
    const open = await db.select().from(paperPositions).where(eq(paperPositions.status, "open"));
    expect(
      open.filter((p) => p.conditionId === COND && p.id !== pos.id && p.kind === "copy"),
    ).toEqual([]);
    expect(open.find((p) => p.kind === "hedge")).toBeUndefined();
    const sells = await db.select().from(paperFills).where(eq(paperFills.side, "SELL"));
    expect(sells).toHaveLength(2);
    expect(sells.every((f) => typeof f.realizedPnl === "number")).toBe(true);
  });
});
