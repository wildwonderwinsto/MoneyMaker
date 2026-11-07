/**
 * Locking and races: engine work that overlaps (a slow run outliving its lease, a deploy's
 * SIGTERM, admin actions running beside a tick, a stale position row) must never buy,
 * sell or credit anything twice, and auto-hedge must never buy the same hedge again.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_RISK_CONFIG } from "@/lib/copy/config";
import { runTick } from "@/lib/copy/tick";
import type { Db } from "@/lib/db/client";
import { cursors, follows, paperPositions } from "@/lib/db/schema";
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

const open = async () => db.select().from(paperPositions).where(eq(paperPositions.status, "open"));
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
