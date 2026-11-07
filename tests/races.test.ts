/**
 * Locking and races: engine work that overlaps (a slow run outliving its lease, a deploy's
 * SIGTERM, admin actions running beside a tick, a stale position row) must never buy,
 * sell or credit anything twice, and auto-hedge must never buy the same hedge again.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyBuy, applySell, ensureDefaultAccount, settlePosition } from "@/lib/copy/account";
import { DEFAULT_RISK_CONFIG } from "@/lib/copy/config";
import { simulateSell } from "@/lib/copy/fillSim";
import { EngineRunner } from "@/lib/copy/runner";
import { exitTrader, LEASE, LEASE_TTL_MS, runStreamBatch, runTick } from "@/lib/copy/tick";
import type { Db } from "@/lib/db/client";
import { cursors, follows, paperAccounts, paperFills, paperPositions } from "@/lib/db/schema";
import { acquireLease } from "@/lib/lease";
import * as clob from "@/lib/polymarket/clob";
import * as data from "@/lib/polymarket/data";
import * as gamma from "@/lib/polymarket/gamma";
import { writeSetting } from "@/lib/settings";

import { createTestDb } from "./helpers/db";
import { expectBalanced } from "./helpers/invariant";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ refresh: () => {} }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
vi.mock("@/lib/admin", () => ({
  requireAdmin: async () => {},
  checkPasswordAndSetCookie: async () => false,
  clearAdminCookie: async () => {},
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
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
type Book = Awaited<ReturnType<typeof clob.getBook>>;
const book = (tokenId: string, bids = [{ price: 0.49, size: 10_000 }]): Book => ({
  tokenId,
  asks: [{ price: 0.5, size: 10_000 }],
  bids,
  tickSize: 0.01,
  minOrderSize: 1,
  timestamp: Date.now(),
});
let books: Record<string, Book>;
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

/** Holds every order-book request for `tokenId` until `open()` (a slow API call). */
function holdBook(tokenId: string) {
  let open!: () => void;
  const released = new Promise<void>((r) => (open = r));
  const prev = vi.mocked(clob.getBook).getMockImplementation()!;
  vi.mocked(clob.getBook).mockImplementation(async (id: string) => {
    if (id === tokenId) await released;
    return prev(id);
  });
  return open;
}
const settle = () => new Promise((r) => setTimeout(r, 50));
const open = async () => db.select().from(paperPositions).where(eq(paperPositions.status, "open"));
const gammaInfo = async () =>
  (await import("@/lib/copy/markets")).getMarketInfo(db, [COND]).then((m) => m.get(COND)!);
const cash = async () => (await db.select().from(paperAccounts))[0].cash;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(follows).values({ wallet: LEADER });
  await db.insert(cursors).values({ wallet: LEADER, lastTs: t0 - 60 });
  // Fixed $20 copies at 50¢ = 40 shares.
  await writeSetting(db, "risk", {
    ...DEFAULT_RISK_CONFIG,
    sizingMode: "fixed",
    fixedUsd: 20,
    realtime: false,
  });
  rows = [];
  books = { [YES]: book(YES), [NO]: book(NO) };
  vi.mocked(clob.getBook).mockImplementation(async (id: string) => books[id]);
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
  vi.useRealTimers();
  await expectBalanced(db);
  await close();
});

describe("auto-hedge with an orphaned hedge (#5)", () => {
  it("hedges a new copy once instead of buying again on every tick", async () => {
    await writeSetting(db, "risk", {
      ...DEFAULT_RISK_CONFIG,
      sizingMode: "fixed",
      fixedUsd: 20,
      realtime: false,
      autoHedge: "lock",
      hedgeTriggerLossPct: 0.3,
      hedgeMaxCostPct: 0.05,
    });
    const { hedgeAction } = await import("@/app/actions");
    rows = [act({ transaction_hash: "0xbuy1" })];
    await runTick(db, (t0 + 15) * 1000);
    const [p1] = await open();
    expect((await hedgeAction(p1.id, "lock")).ok).toBe(true);
    // The leader exits; nobody bids for NO, so our copy sells and its hedge is left alone.
    books[NO] = book(NO, []);
    rows.push(act({ transaction_hash: "0xsell1", side: "SELL", timestamp: t0 + 20 }));
    await runTick(db, (t0 + 25) * 1000);
    expect((await open()).map((p) => p.kind)).toEqual(["hedge"]);

    // They buy YES again (new copy), YES drops to 20¢ → auto-hedge, tick after tick.
    books[NO] = book(NO);
    rows.push(act({ transaction_hash: "0xbuy2", timestamp: t0 + 30 }));
    await runTick(db, (t0 + 35) * 1000);
    vi.mocked(clob.getMidpoints).mockResolvedValue(
      new Map([
        [YES, 0.2],
        [NO, 0.8],
      ]),
    );
    let hedged = 0;
    for (let k = 0; k < 4; k++) hedged += (await runTick(db, (t0 + 40 + k * 15) * 1000)).hedged;
    expect(hedged).toBe(1);
    const p2 = (await open()).find((p) => p.kind === "copy")!;
    const hedges = (await open()).filter((p) => p.kind === "hedge");
    expect(hedges).toHaveLength(1);
    expect(hedges[0].hedgeOf).toBe(p2.id);
  });
});

describe("the engine lease (#6)", () => {
  it("is kept by a run that outlives its TTL, so no second run starts beside it", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    rows = [act({ transaction_hash: "0xbuy" })];
    const release = holdBook(YES);
    const slow = runTick(db, (t0 + 20) * 1000, { housekeeping: false });
    await settle();
    await vi.advanceTimersByTimeAsync(LEASE_TTL_MS + 1_000); // the run is still waiting
    const second = runTick(db, (t0 + 21) * 1000, { housekeeping: false });
    await settle();
    release();
    const [, s2] = await Promise.all([slow, second]);
    expect(s2.skipped).toBe("Another engine run is in progress");
  });

  it("is released only by the run that took it, never by a later run in the same process", async () => {
    rows = [act({ transaction_hash: "0xbuy" })];
    await runTick(db, (t0 + 15) * 1000); // a copy to exit later
    rows.push(act({ transaction_hash: "0xbuy2", token_id: NO, outcome: "No", timestamp: t0 + 20 }));
    const releaseA = holdBook(NO);
    const a = runTick(db, (t0 + 25) * 1000, { housekeeping: false });
    await settle();
    // A's lease lapses (say its renewals failed during a database blip) and the admin
    // hides the trader: exitTrader takes the lease and is still selling when A finishes.
    await db.execute(sql`
      update app_settings set value = jsonb_set(value, '{until}', '0') where key = 'lease:tick'
    `);
    const releaseC = holdBook(YES);
    const c = exitTrader(db, LEADER);
    await settle();
    releaseA();
    await a;
    const intruder = await acquireLease(db, LEASE, LEASE_TTL_MS, "someone-else");
    releaseC();
    await c;
    expect(intruder).toBe(false);
  });

  it("is not released on SIGTERM while a run is still in flight", async () => {
    const extra = () => {}; // Next.js owns shutdown; keeps the runner from exiting the test
    const before = { term: process.listeners("SIGTERM"), int: process.listeners("SIGINT") };
    process.on("SIGTERM", extra);
    rows = [act({ transaction_hash: "0xbuy" })];
    const release = holdBook(YES);
    const runner = new EngineRunner(
      () => db,
      () => {},
    );
    try {
      runner.start();
      await new Promise((r) => setTimeout(r, 300)); // the first tick is waiting on the book
      process.emit("SIGTERM", "SIGTERM");
      await settle();
      const nextInstance = await acquireLease(db, LEASE, LEASE_TTL_MS, "next-instance");
      release();
      expect(nextInstance).toBe(false);
      await vi.waitFor(
        async () => expect(await acquireLease(db, LEASE, LEASE_TTL_MS, "next-instance")).toBe(true),
        { timeout: 5_000, interval: 50 },
      );
    } finally {
      runner.stop();
      process.off("SIGTERM", extra);
      for (const [sig, kept] of [
        ["SIGTERM", before.term],
        ["SIGINT", before.int],
      ] as const) {
        for (const l of process.listeners(sig)) if (!kept.includes(l)) process.off(sig, l);
      }
    }
  });
});

describe("admin actions beside the engine (#6)", () => {
  it("a double-clicked manual hedge buys it once", async () => {
    const { hedgeAction } = await import("@/app/actions");
    rows = [act({ transaction_hash: "0xbuy" })];
    await runTick(db, (t0 + 15) * 1000);
    const [p] = await open();
    const release = holdBook(NO);
    const clicks = [hedgeAction(p.id, "lock"), hedgeAction(p.id, "lock")];
    await settle();
    release();
    const res = await Promise.all(clicks);
    expect(res.map((r) => r.ok).sort()).toEqual([false, true]);
    const hedges = (await open()).filter((h) => h.kind === "hedge");
    expect(hedges).toHaveLength(1);
    expect(hedges[0].shares).toBeCloseTo(p.shares, 6);
  });

  it("a manual hedge never lands on a copy the leader's exit just closed", async () => {
    const { hedgeAction } = await import("@/app/actions");
    rows = [act({ transaction_hash: "0xbuy" })];
    await runTick(db, (t0 + 15) * 1000);
    const [p] = await open();
    const release = holdBook(NO); // the admin's hedge quote is slow
    const hedge = hedgeAction(p.id, "lock");
    await settle();
    const exit = runStreamBatch(
      db,
      [
        {
          id: "0xsell:111:SELL:200",
          wallet: LEADER,
          ts: t0 + 30,
          conditionId: COND,
          tokenId: YES,
          side: "SELL",
          price: 0.5,
          size: 200,
          usdc: 100,
          outcome: "Yes",
          title: "Q",
          slug: "q",
        },
      ],
      (t0 + 31) * 1000,
    );
    await settle();
    release();
    await Promise.all([hedge, exit]);
    const left = await open();
    const orphans = left.filter((h) => h.kind === "hedge" && !left.some((c) => c.id === h.hedgeOf));
    expect(orphans).toEqual([]);
  });

  it("a reset waits for the copy in progress instead of letting it land on the new balance", async () => {
    const { resetPaperAction } = await import("@/app/actions");
    const release = holdBook(YES);
    const copy = runStreamBatch(
      db,
      [
        {
          id: "0xnew:111:BUY:200",
          wallet: LEADER,
          ts: t0,
          conditionId: COND,
          tokenId: YES,
          side: "BUY",
          price: 0.5,
          size: 200,
          usdc: 100,
          outcome: "Yes",
          title: "Q",
          slug: "q",
        },
      ],
      (t0 + 2) * 1000,
    );
    await settle();
    const form = new FormData();
    form.set("balance", "10");
    const reset = resetPaperAction(null, form);
    await settle();
    release();
    await Promise.all([copy, reset]);
    expect(await cash()).toBe(10);
    expect(await open()).toEqual([]);
  });
});

describe("selling from a stale position row (#6)", () => {
  it("never sells shares twice or pays for shares we no longer hold", async () => {
    const acct = await ensureDefaultAccount(db);
    const t = {
      wallet: LEADER,
      ts: t0,
      conditionId: COND,
      tokenId: YES,
      side: "SELL" as const,
      price: 0.6,
      size: 100,
      usdc: 60,
      outcome: "Yes",
      title: null,
      slug: null,
    };
    const buy = { shares: 100, avgPrice: 0.5, notional: 50, fee: 0, levels: 1, partial: false };
    const info = { ...(await gammaInfo()), question: "Q" };
    const id = await db.transaction((tx) =>
      applyBuy(tx, acct.id, { ...t, id: "buy", side: "BUY", price: 0.5 }, info, buy),
    );
    const [p] = await db.select().from(paperPositions).where(eq(paperPositions.id, id));
    // Run A sells 60; run B still holds the 100-share row and sells 100 from it.
    const sixty = simulateSell([{ price: 0.6, size: 1000 }], 60, 0);
    const hundred = simulateSell([{ price: 0.6, size: 1000 }], 100, 0);
    await db.transaction((tx) => applySell(tx, p, { ...t, id: "a" }, sixty));
    await db.transaction((tx) => applySell(tx, p, { ...t, id: "b" }, hundred));
    await db.transaction((tx) => applySell(tx, p, { ...t, id: "c" }, hundred));
    await db.transaction((tx) => settlePosition(tx, p, 1));
    const fills = await db
      .select()
      .from(paperFills)
      .where(and(eq(paperFills.positionId, p.id)));
    const sold = fills.filter((f) => f.side === "SELL");
    expect(sold.reduce((s, f) => s + f.shares, 0)).toBeCloseTo(100, 6);
    expect(await cash()).toBeCloseTo(acct.cash - 50 + 100 * 0.6, 6);
    expect(fills.filter((f) => f.kind === "settlement")).toEqual([]);
  });
});
