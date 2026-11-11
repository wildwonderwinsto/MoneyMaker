/**
 * Cash comes first (owner, 2026-11-11): a buy we can't afford is skipped before any other
 * check and before any order book is fetched; sells still go through (they bring cash
 * back); the skip is re-checked while the trade is fresh, in case cash returns.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_RISK_CONFIG as cfg } from "@/lib/copy/config";
import { decideBuy, type BuyContext } from "@/lib/copy/engine";
import { runTick } from "@/lib/copy/tick";
import type { Db } from "@/lib/db/client";
import { follows, paperAccounts, paperPositions, signals } from "@/lib/db/schema";
import { explain } from "@/lib/explain";
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

let db: Db;
let close: () => Promise<void>;
/** Each test gets its own stretch of time, so earlier trades are never in its window. */
let t0 = Math.floor(Date.now() / 1000);

const activity = (over: Partial<data.Activity>): data.Activity => ({
  proxy_wallet: LEADER,
  timestamp: t0 + 10,
  condition_id: COND,
  type: "TRADE",
  size: 200,
  usdc_size: 100,
  transaction_hash: `0xtx${t0}`,
  price: 0.5,
  token_id: YES,
  side: "BUY",
  outcome_index: 0,
  title: "Will it happen?",
  slug: "will-it-happen",
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
const setCash = (cash: number) => db.update(paperAccounts).set({ cash });
/** $0.40 of cash left: the rest of the $1,000 sits in another trader's position. */
const spendAllCash = async () => {
  const [account] = await db.select().from(paperAccounts);
  await setCash(0.4);
  await db.insert(paperPositions).values({
    accountId: account.id,
    sourceWallet: "0xother",
    conditionId: "0xparked",
    tokenId: "999",
    shares: 1999.2,
    avgPrice: 0.5,
    costBasis: 999.6,
  });
  return account;
};
const cash = async () => (await db.select().from(paperAccounts))[0].cash;
const signal = async (tx: string) =>
  (await db.select().from(signals)).find((s) => s.id.startsWith(tx));
const copyOnly = (now: number) => runTick(db, now * 1000, { housekeeping: false });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(follows).values({ wallet: LEADER });
  vi.mocked(data.getActivity).mockResolvedValue(page([]));
  await runTick(db, t0 * 1000); // first tick only starts watching
});
afterAll(async () => close());

beforeEach(async () => {
  t0 += 1000;
  await db.delete(paperPositions);
  vi.mocked(data.getActivity).mockReset().mockResolvedValue(page([]));
  vi.mocked(data.getPositions).mockReset().mockResolvedValue(page([])); // leader fully out
  vi.mocked(data.getPortfolioValue).mockResolvedValue(1000);
  vi.mocked(clob.getMidpoints).mockResolvedValue(new Map());
  vi.mocked(clob.getBook)
    .mockReset()
    .mockResolvedValue({
      tokenId: YES,
      bids: [{ price: 0.6, size: 10_000 }],
      asks: [{ price: 0.51, size: 10_000 }],
      tickSize: 0.01,
      minOrderSize: 5,
      timestamp: Date.now(),
    });
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
    }),
  ]);
});

describe("decideBuy checks cash before anything else", () => {
  const ctx: BuyContext = {
    now: 1_800_000_000,
    trade: {
      id: "tx:tok:BUY",
      wallet: LEADER,
      ts: 1_800_000_000 - 30,
      conditionId: "c",
      tokenId: "tok",
      side: "BUY",
      price: 0.5,
      size: 1000,
      usdc: 500,
      outcome: "Yes",
      title: "Will it?",
      slug: "will-it",
    },
    market: {
      conditionId: "c",
      question: "Will it?",
      slug: "will-it",
      image: null,
      endDate: null,
      closed: false,
      tokenIds: ["tok", "other"],
      outcomes: ["Yes", "No"],
      winnerIndex: null,
    },
    book: {
      tokenId: "tok",
      bids: [{ price: 0.49, size: 1000 }],
      asks: [{ price: 0.51, size: 1000 }],
      tickSize: 0.01,
      minOrderSize: 5,
      timestamp: 0,
    },
    equity: 1000,
    cash: 1000,
    leaderTypicalUsd: 250,
    weight: 1,
    marketExposure: 0,
    traderExposure: 0,
    dailyLossPct: 0,
    cfg,
  };

  it("says how much cash is left and how much is needed", () => {
    const d = decideBuy({ ...ctx, cash: 0.4 });
    expect(d).toMatchObject({
      action: "skip",
      code: "no_cash",
      reason: "Not enough cash: $0.40 left, need at least $1.00",
      details: { cash: 0.4, minOrderUsd: 1 },
    });
  });

  it("comes before every other reason to skip", () => {
    const broke = { ...ctx, cash: 0.4 };
    const code = (c: BuyContext) => {
      const d = decideBuy(c);
      return d.action === "skip" ? d.code : d.action;
    };
    expect(code({ ...broke, trade: { ...ctx.trade, ts: ctx.now - 3600 } })).toBe("no_cash");
    expect(code({ ...broke, market: null })).toBe("no_cash");
    expect(code({ ...broke, market: { ...ctx.market!, closed: true } })).toBe("no_cash");
    expect(code({ ...broke, trade: { ...ctx.trade, price: 0.99 } })).toBe("no_cash");
    expect(code({ ...broke, dailyLossPct: 0.5 })).toBe("no_cash");
    expect(code({ ...broke, book: null })).toBe("no_cash");
    expect(code({ ...broke, trade: { ...ctx.trade, usdc: 1 } })).toBe("no_cash");
  });

  it("with the smallest order set to $0, only an empty account is out of cash", () => {
    const free = { ...cfg, minOrderUsd: 0, minCopyUsd: 0 };
    expect(decideBuy({ ...ctx, cfg: free, cash: 0 })).toMatchObject({ code: "no_cash" });
    // 40¢ is allowed to try; it is then too few shares for the exchange.
    expect(decideBuy({ ...ctx, cfg: free, cash: 0.4 })).toMatchObject({
      code: "below_exchange_min",
    });
    expect(decideBuy({ ...ctx, cfg: free, cash: 4 }).action).toBe("buy");
  });

  it("still buys what the cash covers when it can't cover the whole copy", () => {
    const d = decideBuy({ ...ctx, cash: 8 }); // the copy wants $40
    expect(d.action).toBe("buy");
    if (d.action === "buy") expect(d.fill.notional).toBeCloseTo(8, 6);
  });

  it("explains the skip with the numbers", () => {
    const d = decideBuy({ ...ctx, cash: 0.4 });
    if (d.action !== "skip") throw new Error("expected a skip");
    const text = explain({ reason: d.reason, code: d.code, details: d.details }).body.join(" ");
    expect(text).toContain("$0.40");
    expect(text).toContain("$1.00");
  });
});

describe("the engine when the account is out of cash", () => {
  it("skips the buy, says why, and fetches no order book", async () => {
    await spendAllCash();
    vi.mocked(data.getActivity).mockResolvedValue(page([activity({})]));
    const s = await copyOnly(t0 + 30);
    expect(s).toMatchObject({ newTrades: 1, copied: 0, ignored: 1, errors: [] });
    expect(await signal(`0xtx${t0}`)).toMatchObject({
      decision: "skipped",
      reasonCode: "no_cash",
      reason: "Not enough cash: $0.40 left, need at least $1.00",
    });
    expect(clob.getBook).not.toHaveBeenCalled();
    expect(await cash()).toBe(0.4);
  });

  it("still mirrors a sell, which brings cash back", async () => {
    const account = await spendAllCash();
    await db.insert(paperPositions).values({
      accountId: account.id,
      sourceWallet: LEADER,
      conditionId: COND,
      tokenId: YES,
      shares: 100,
      avgPrice: 0.5,
      costBasis: 50,
    });
    vi.mocked(data.getActivity).mockResolvedValue(
      page([activity({ side: "SELL", price: 0.6, usdc_size: 120 })]),
    );
    const s = await copyOnly(t0 + 30);
    expect(s).toMatchObject({ closed: 1, errors: [] });
    expect(await cash()).toBeCloseTo(60.4, 4); // 100 shares at the 60¢ bid
  });

  it("copies a buy that follows a sell in the same batch: the sell paid for it", async () => {
    const account = await spendAllCash();
    await db.insert(paperPositions).values({
      accountId: account.id,
      sourceWallet: LEADER,
      conditionId: COND,
      tokenId: YES,
      shares: 100,
      avgPrice: 0.5,
      costBasis: 50,
    });
    vi.mocked(data.getActivity).mockResolvedValue(
      page([
        activity({ side: "SELL", price: 0.6, usdc_size: 120, transaction_hash: `0xsell${t0}` }),
        activity({ timestamp: t0 + 11, token_id: NO, outcome: "No", outcome_index: 1 }),
      ]),
    );
    const s = await copyOnly(t0 + 30);
    expect(s).toMatchObject({ closed: 1, copied: 1, errors: [] });
    expect(await signal(`0xtx${t0}`)).toMatchObject({ decision: "copied" });
  });

  it("re-checks the skipped buy and copies it once cash is back", async () => {
    await spendAllCash();
    vi.mocked(data.getActivity).mockResolvedValue(page([activity({})]));
    await copyOnly(t0 + 30);
    expect(await signal(`0xtx${t0}`)).toMatchObject({ reasonCode: "no_cash" });

    // Still out of cash: nothing to re-check with, so no market or book requests.
    vi.mocked(data.getActivity).mockResolvedValue(page([]));
    vi.mocked(clob.getBook).mockClear();
    await copyOnly(t0 + 45);
    expect(clob.getBook).not.toHaveBeenCalled();
    expect(await signal(`0xtx${t0}`)).toMatchObject({ decision: "skipped" });

    await setCash(1000);
    const s = await copyOnly(t0 + 60);
    expect(s).toMatchObject({ copied: 1, retried: 1 });
    expect(await signal(`0xtx${t0}`)).toMatchObject({ decision: "copied", reasonCode: "bought" });
    expect(await cash()).toBeLessThan(1000);
  });

  it("stops re-checking once the trade is too old to copy", async () => {
    await spendAllCash();
    vi.mocked(data.getActivity).mockResolvedValue(page([activity({})]));
    await copyOnly(t0 + 30);
    vi.mocked(data.getActivity).mockResolvedValue(page([]));
    await setCash(1000);
    const s = await copyOnly(t0 + 10 + cfg.maxSignalAgeSeconds + 5);
    expect(s.copied).toBe(0);
    expect(await signal(`0xtx${t0}`)).toMatchObject({ decision: "skipped", reasonCode: "no_cash" });
  });
});
