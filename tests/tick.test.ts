/**
 * End-to-end tick against a real (in-memory) Postgres with the Polymarket APIs mocked.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { runTick } from "@/lib/copy/tick";
import type { Db } from "@/lib/db/client";
import { follows, markets, paperAccounts, paperPositions, signals, traders } from "@/lib/db/schema";
import { DEFAULT_RISK_CONFIG } from "@/lib/copy/config";
import { acquireLease, releaseLease } from "@/lib/lease";
import { writeSetting } from "@/lib/settings";
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

const activity = (over: Partial<data.Activity>): data.Activity => ({
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
  title: "Will it happen?",
  slug: "will-it-happen",
  icon: null,
  event_slug: null,
  outcome: "Yes",
  name: null,
  pseudonym: null,
  ...over,
});

const gammaMarket = (outcomePrices: string, closed: boolean) =>
  gamma.GammaMarket.parse({
    id: "1",
    question: "Will it happen?",
    conditionId: COND,
    slug: "will-it-happen",
    endDate: new Date((t0 + 7 * 86_400) * 1000).toISOString(),
    closed,
    outcomes: '["Yes","No"]',
    outcomePrices,
    clobTokenIds: `["${YES}","${NO}"]`,
  });

const page = <T>(items: T[]) => ({
  data: items,
  pagination: { has_more: false, next_cursor: null },
});

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(follows).values({ wallet: LEADER });
  // A usual-size bet copies 10% of $1000 = $100, exactly the per-market cap.
  await writeSetting(db, "risk", { ...DEFAULT_RISK_CONFIG, stakePct: 0.1 });
});
afterAll(async () => close());

beforeEach(() => {
  vi.mocked(data.getPortfolioValue).mockResolvedValue(1000); // leader's book
  vi.mocked(clob.getBook).mockResolvedValue({
    tokenId: YES,
    bids: [{ price: 0.6, size: 10_000 }],
    asks: [
      { price: 0.51, size: 100 },
      { price: 0.52, size: 10_000 },
    ],
    tickSize: 0.01,
    minOrderSize: 5,
    timestamp: Date.now(),
  });
  vi.mocked(clob.getMidpoints).mockResolvedValue(new Map([[YES, 0.55]]));
  vi.mocked(gamma.getMarketsByConditionIds).mockResolvedValue([
    gammaMarket('["0.5","0.5"]', false),
  ]);
});

const cash = async () => (await db.select().from(paperAccounts))[0].cash;
const openPosition = async () =>
  (await db.select().from(paperPositions).where(eq(paperPositions.status, "open")))[0];

describe("runTick", () => {
  it("first tick only starts watching (never copies history)", async () => {
    vi.mocked(data.getActivity).mockResolvedValue(page([activity({ timestamp: t0 - 999 })]));
    const s = await runTick(db, t0 * 1000);
    expect(s.leaders).toBe(1);
    expect(s.newTrades).toBe(0);
    expect(data.getActivity).not.toHaveBeenCalled();
    expect(await cash()).toBe(1000);
  });

  it("copies a buy at order-book prices and skips an overpriced one", async () => {
    vi.mocked(data.getActivity).mockResolvedValue(
      page([
        activity({}),
        activity({ transaction_hash: "0xtx2", price: 0.97, usdc_size: 50, timestamp: t0 + 11 }),
      ]),
    );
    const s = await runTick(db, (t0 + 30) * 1000);
    expect(s).toMatchObject({ newTrades: 2, copied: 1, ignored: 1, errors: [] });
    // Their usual stake isn't known yet → a usual bet: 10% of $1000 = $100 (= per-market cap).
    expect(await cash()).toBeCloseTo(900, 6);
    const pos = await openPosition();
    expect(pos.shares).toBeCloseTo(100 + 49 / 0.52, 4);
    const skipped = await db.select().from(signals).where(eq(signals.decision, "skipped"));
    expect(skipped[0].reason).toMatch(/above/);
  });

  it("is idempotent: the same trades are never processed twice", async () => {
    const s = await runTick(db, (t0 + 60) * 1000);
    expect(s.newTrades).toBe(0);
    expect(await cash()).toBeCloseTo(900, 6);
  });

  it("mirrors a partial sell", async () => {
    const before = await openPosition();
    vi.mocked(data.getActivity).mockResolvedValue(
      page([activity({ transaction_hash: "0xtx3", side: "SELL", size: 100, timestamp: t0 + 70 })]),
    );
    vi.mocked(data.getPositions).mockResolvedValue(
      page([{ token_id: YES, current_size: 100 } as data.Position]), // sold 100 of 200
    );
    const s = await runTick(db, (t0 + 90) * 1000);
    expect(s.closed).toBe(1);
    const after = await openPosition();
    expect(after.shares).toBeCloseTo(before.shares / 2, 4);
    expect(await cash()).toBeCloseTo(900 + (before.shares / 2) * 0.6, 4);
    expect(after.realizedPnl).toBeGreaterThan(0);
  });

  it("settles a resolved market at $1 per winning share", async () => {
    const pos = await openPosition();
    const cashBefore = await cash();
    vi.mocked(data.getActivity).mockResolvedValue(page([]));
    vi.mocked(gamma.getMarketsByConditionIds).mockResolvedValue([gammaMarket('["1","0"]', true)]);
    await db.update(markets).set({ updatedAt: new Date(0) }); // expire the cache
    const s = await runTick(db, (t0 + 120) * 1000);
    expect(s.settled).toBe(1);
    expect(await cash()).toBeCloseTo(cashBefore + pos.shares, 4);
    expect(await openPosition()).toBeUndefined();
  });

  it("settles a 50/50 resolution at $0.50 per share", async () => {
    const COND2 = "0xambiguous";
    const [account] = await db.select().from(paperAccounts);
    await db.insert(paperPositions).values({
      accountId: account.id,
      sourceWallet: LEADER,
      conditionId: COND2,
      tokenId: "333",
      shares: 100,
      avgPrice: 0.4,
      costBasis: 40,
    });
    const cashBefore = await cash();
    vi.mocked(data.getActivity).mockResolvedValue(page([]));
    vi.mocked(gamma.getMarketsByConditionIds).mockResolvedValue([
      gamma.GammaMarket.parse({
        id: "2",
        question: "Ambiguous?",
        conditionId: COND2,
        closed: true,
        umaResolutionStatus: "resolved",
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.5","0.5"]',
        clobTokenIds: '["333","444"]',
      }),
    ]);
    const s = await runTick(db, (t0 + 150) * 1000);
    expect(s.settled).toBe(1);
    expect(await cash()).toBeCloseTo(cashBefore + 50, 4);
    const [pos] = await db
      .select()
      .from(paperPositions)
      .where(eq(paperPositions.conditionId, COND2));
    expect(pos.status).toBe("settled");
    expect(pos.realizedPnl).toBeCloseTo(10, 4);
  });

  it("sizes a copy by how big the bet is for this trader", async () => {
    const COND3 = "0xsized";
    // They usually put $1000 into a market; this $100 bet is 0.1× usual → 0.1 × 10% ≈ 1%.
    await db
      .insert(traders)
      .values({ wallet: LEADER, typicalStakeUsd: 1000 })
      .onConflictDoUpdate({ target: traders.wallet, set: { typicalStakeUsd: 1000 } });
    vi.mocked(gamma.getMarketsByConditionIds).mockResolvedValue([
      gamma.GammaMarket.parse({
        id: "3",
        question: "Sized?",
        conditionId: COND3,
        closed: false,
        endDate: new Date((t0 + 7 * 86_400) * 1000).toISOString(),
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.5","0.5"]',
        clobTokenIds: '["555","666"]',
      }),
    ]);
    vi.mocked(data.getActivity).mockResolvedValue(
      page([
        activity({
          transaction_hash: "0xtx-sized",
          condition_id: COND3,
          token_id: "555",
          timestamp: t0 + 200,
        }),
      ]),
    );
    const before = await cash();
    const s = await runTick(db, (t0 + 230) * 1000);
    expect(s.copied).toBe(1);
    const spent = before - (await cash());
    expect(spent).toBeGreaterThan(9);
    expect(spent).toBeLessThan(12); // ~1% of equity, not the $100 a usual bet would get
  });

  it("refuses to run concurrently", async () => {
    expect(await acquireLease(db, "tick", 60_000)).toBe(true);
    const s = await runTick(db);
    expect(s.skipped).toMatch(/in progress/);
    await releaseLease(db, "tick");
  });
});
