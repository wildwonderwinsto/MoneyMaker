/**
 * Settings sweep (batch 6): every setting must change behaviour when changed, and no saved
 * value (however large) may break the engine.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DEFAULT_RISK_CONFIG, RiskConfigSchema, type RiskConfig } from "@/lib/copy/config";
import { decideBuy, decideSell, type BuyContext, type SellContext } from "@/lib/copy/engine";
import { EngineRunner } from "@/lib/copy/runner";
import { sizeBuy, type SizingInput } from "@/lib/copy/sizing";
import { runTick } from "@/lib/copy/tick";
import type { Db } from "@/lib/db/client";
import { ensureDefaultAccount } from "@/lib/copy/account";
import { appSettings, cursors, follows, markets, paperPositions, signals } from "@/lib/db/schema";
import * as clob from "@/lib/polymarket/clob";
import * as data from "@/lib/polymarket/data";
import {
  DEFAULT_SCORING_CONFIG,
  ScoringConfigSchema,
  type ScoringConfig,
} from "@/lib/scoring/config";
import { computeMetrics, type TraderMetrics } from "@/lib/scoring/metrics";
import { buildChecks, scoreTrader } from "@/lib/scoring/score";
import { eBenjaminiHochbergThreshold } from "@/lib/scoring/stats";
import { getRiskConfig, writeSetting } from "@/lib/settings";

import { createTestDb } from "./helpers/db";
import { DAY, inputAt, skilledTrader } from "./helpers/skillPipeline";

// The runner would open Polymarket's WebSocket; only whether it was asked to matters here.
vi.mock("@/lib/copy/stream", () => ({
  TradeStream: class {
    status = { connected: false };
    started = false;
    start() {
      this.started = true;
    }
    stop() {
      this.started = false;
    }
    setFollowed() {}
  },
}));

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

let db: Db;
let close: () => Promise<void>;
const t0 = Math.floor(Date.now() / 1000);
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(follows).values({ wallet: "0xleader" });
  await db.insert(cursors).values({ wallet: "0xleader", lastTs: t0 - 60 });
  vi.mocked(data.getActivity).mockResolvedValue({
    data: [],
    pagination: { has_more: false, next_cursor: null },
  } as never);
  vi.mocked(clob.getMidpoints).mockResolvedValue(new Map());
});
afterAll(async () => close());

describe("huge values", () => {
  it("maxSignalAgeSeconds: a huge saved value can't break re-checking skipped trades", async () => {
    // 1e13 s turned the retry window's start into an invalid date: every tick logged
    // "retry: Invalid time value" and skipped trades were never re-checked.
    await db
      .insert(appSettings)
      .values({ key: "risk", value: { ...DEFAULT_RISK_CONFIG, maxSignalAgeSeconds: 1e13 } })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: { ...DEFAULT_RISK_CONFIG, maxSignalAgeSeconds: 1e13 } },
      });
    const s = await runTick(db, t0 * 1000, { housekeeping: false });
    expect(s.errors).toEqual([]);
    // Out of range → that one field falls back to its default; the rest is kept.
    expect((await getRiskConfig(db)).maxSignalAgeSeconds).toBe(
      DEFAULT_RISK_CONFIG.maxSignalAgeSeconds,
    );
    const top = RiskConfigSchema.safeParse({ maxSignalAgeSeconds: 7 * 86_400 });
    expect(top.success).toBe(true);
    expect(RiskConfigSchema.safeParse({ maxSignalAgeSeconds: 7 * 86_400 + 1 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// Risk settings: each one changes what the engine decides for the same trade.

const NOW = 1_800_000_000;
const market = (minutesLeft = 7 * 24 * 60) => ({
  conditionId: "c",
  question: "q",
  slug: null,
  image: null,
  endDate: new Date((NOW + minutesLeft * 60) * 1000),
  closed: false,
  tokenIds: ["y", "n"],
  outcomes: ["Yes", "No"],
  winnerIndex: null,
  takerFeeRate: 0,
});
const book = (asks: Array<[number, number]>, bids: Array<[number, number]>) => ({
  tokenId: "y",
  asks: asks.map(([price, size]) => ({ price, size })),
  bids: bids.map(([price, size]) => ({ price, size })),
  tickSize: 0.01,
  minOrderSize: 1,
  timestamp: 0,
});
const trade = (over: Record<string, unknown> = {}) =>
  ({
    id: "x",
    wallet: "0xl",
    ts: NOW - 5,
    conditionId: "c",
    tokenId: "y",
    side: "BUY",
    price: 0.5,
    size: 100,
    usdc: 50,
    outcome: "Yes",
    title: null,
    slug: null,
    icon: null,
    ...over,
  }) as BuyContext["trade"];
const buyCtx = (cfg: RiskConfig, over: Partial<BuyContext> = {}): BuyContext => ({
  now: NOW,
  trade: trade(),
  market: market(),
  book: book([[0.5, 10_000]], [[0.49, 10_000]]),
  equity: 1000,
  cash: 1000,
  leaderTypicalUsd: 50,
  weight: 1,
  marketExposure: 0,
  traderExposure: 0,
  dailyLossPct: 0,
  positionBuys: 0,
  cfg,
  ...over,
});
const buyOutcome = (cfg: RiskConfig, over: Partial<BuyContext> = {}) => {
  const d = decideBuy(buyCtx(cfg, over));
  return d.action === "buy"
    ? `buy ${d.fill.shares.toFixed(4)} for ${d.fill.notional.toFixed(4)}`
    : `skip ${d.action === "skip" ? d.code : ""}`;
};
const sizing = (cfg: RiskConfig, over: Partial<SizingInput> = {}) => {
  const r = sizeBuy(
    {
      equity: 1000,
      cash: 1000,
      leaderUsd: 50,
      leaderTypicalUsd: 50,
      weight: 1,
      marketExposure: 0,
      traderExposure: 0,
      ...over,
    },
    cfg,
  );
  return "code" in r ? r.code : r.usd.toFixed(4);
};
const sellOutcome = (cfg: RiskConfig, over: Partial<SellContext> = {}) => {
  const d = decideSell({
    trade: trade({ side: "SELL" }),
    ourShares: 100,
    leaderSoldFraction: 1,
    book: book(
      [],
      [
        [0.49, 50],
        [0.3, 100],
      ],
    ),
    feeRate: 0,
    cfg,
    ...over,
  });
  return d.action === "sell"
    ? `sell ${d.fill.shares.toFixed(4)} for ${d.fill.notional.toFixed(4)}`
    : `skip ${d.action === "skip" ? d.code : ""}`;
};

type RiskCase = [keyof RiskConfig, unknown, (cfg: RiskConfig) => string];
const riskCases: RiskCase[] = [
  ["maxEntryPrice", 0.4, (c) => buyOutcome(c)],
  ["minEntryPrice", 0.6, (c) => buyOutcome(c)],
  ["maxPriceDrift", 0.01, (c) => buyOutcome(c, { book: book([[0.52, 10_000]], []) })],
  ["minMinutesToEnd", 60, (c) => buyOutcome(c, { market: market(30) })],
  ["maxSignalAgeSeconds", 300, (c) => buyOutcome(c, { trade: trade({ ts: NOW - 200 }) })],
  ["maxDailyLossPct", 0.05, (c) => buyOutcome(c, { dailyLossPct: 0.08 })],
  ["maxBuysPerPosition", 2, (c) => buyOutcome(c, { positionBuys: 2 })],
  ["takerFeeBps", 100, (c) => buyOutcome(c)],
  ["sizingMode", "fixed", (c) => sizing(c)],
  ["stakePct", 0.04, (c) => sizing(c)],
  ["maxConviction", 4, (c) => sizing(c, { leaderUsd: 200 })],
  ["proportionalMultiplier", 2, (c) => sizing(c)],
  ["fixedUsd", 30, (c) => sizing({ ...c, sizingMode: "fixed" })],
  ["minCopyUsd", 8, (c) => sizing({ ...c, stakePct: 0.001 })],
  ["minLeaderUsd", 40, (c) => sizing(c, { leaderUsd: 30 })],
  ["minOrderUsd", 25, (c) => sizing(c)],
  ["maxPositionPct", 0.2, (c) => sizing(c, { marketExposure: 90 })],
  ["maxTraderExposurePct", 0.5, (c) => sizing(c, { traderExposure: 290 })],
  ["copySells", false, (c) => sellOutcome(c)],
  ["sellFloorPct", 0.2, (c) => sellOutcome(c)],
];

describe("every risk setting changes the decision", () => {
  it.each(riskCases)("%s → %j", (key, changed, observe) => {
    const before = observe(DEFAULT_RISK_CONFIG);
    const after = observe(RiskConfigSchema.parse({ ...DEFAULT_RISK_CONFIG, [key]: changed }));
    expect(after).not.toBe(before);
  });

  it("minMinutesToEnd at the boundary: refuses at 9 min left with 10, copies at 11", () => {
    const cfg = DEFAULT_RISK_CONFIG; // 10 min
    expect(buyOutcome(cfg, { market: market(9) })).toBe("skip ending_soon");
    expect(buyOutcome(cfg, { market: market(11) })).toMatch(/^buy /);
  });

  it("realtime and tickIntervalSeconds reach the running engine", async () => {
    const runner = new EngineRunner(
      () => db,
      () => {},
    );
    await writeSetting(db, "risk", {
      ...DEFAULT_RISK_CONFIG,
      realtime: true,
      tickIntervalSeconds: 15,
    });
    await runner.refresh();
    expect(runner.streamStatus.enabled).toBe(true);
    expect(runner.intervalSeconds).toBe(15);
    await writeSetting(db, "risk", {
      ...DEFAULT_RISK_CONFIG,
      realtime: false,
      tickIntervalSeconds: 60,
    });
    await runner.refresh();
    expect(runner.streamStatus.enabled).toBe(false);
    expect(runner.intervalSeconds).toBe(60);
  });
});

describe("engine-level risk settings", () => {
  const HY = "hy";
  const HN = "hn";
  const books: Record<string, ReturnType<typeof book>> = {
    [HY]: book([[0.31, 1000]], [[0.29, 1000]]),
    [HN]: book([[0.7, 1000]], [[0.69, 1000]]),
  };
  beforeAll(async () => {
    const account = await ensureDefaultAccount(db);
    await db.insert(markets).values({
      conditionId: "hc",
      question: "Hedge me?",
      endDate: new Date((t0 + 7 * 86_400) * 1000),
      outcomes: ["Yes", "No"],
      tokenIds: [HY, HN],
      takerFeeRate: 0,
    });
    // A followed trader's copy, bought at 50¢, now marked at 30¢: down 40%. A lock hedge is
    // 50 No shares at 70¢ = $35, inside the default 5% cap of the $1,000 paper account.
    await db.insert(paperPositions).values({
      accountId: account.id,
      sourceWallet: "0xleader",
      conditionId: "hc",
      tokenId: HY,
      outcome: "Yes",
      shares: 50,
      avgPrice: 0.5,
      costBasis: 25,
    });
    vi.mocked(clob.getBook).mockImplementation(async (id: string) => books[id]);
    vi.mocked(clob.getMidpoints).mockResolvedValue(new Map([[HY, 0.3]]));
  });

  it("autoHedge, hedgeTriggerLossPct, hedgeMaxCostPct and hedgeMaxPrice decide whether a losing copy is hedged", async () => {
    const on = { ...DEFAULT_RISK_CONFIG, autoHedge: "lock" as const }; // trigger 30%, cap 5%, 85¢
    const hedged = async (cfg: RiskConfig) => {
      await writeSetting(db, "risk", cfg);
      return (await runTick(db, t0 * 1000, { copy: false })).hedged;
    };
    // Each change alone keeps the hedge from being bought…
    expect(await hedged({ ...on, autoHedge: "off" })).toBe(0);
    expect(await hedged({ ...on, hedgeTriggerLossPct: 0.5 })).toBe(0); // down only 40%
    expect(await hedged({ ...on, hedgeMaxPrice: 0.6 })).toBe(0); // the No side costs 70¢
    expect(await hedged({ ...on, hedgeMaxCostPct: 0.001 })).toBe(0); // $1 < $35
    // …and with all four at the "on" values it is.
    expect(await hedged(on)).toBe(1);
  });

  it("retrySkipped decides whether a skipped buy is re-checked", async () => {
    const account = await ensureDefaultAccount(db);
    await db.insert(signals).values({
      id: "0xretry:hn:BUY:100",
      wallet: "0xleader",
      leaderTs: new Date((t0 - 10) * 1000),
      conditionId: "hc",
      tokenId: HN,
      outcome: "No",
      side: "BUY",
      leaderPrice: 0.5,
      leaderSize: 100,
      leaderUsdc: 50,
      decision: "skipped",
      reason: "Price moved",
      reasonCode: "price_moved",
      source: "poll",
      accountId: account.id,
    });
    // The No side is still at 70¢ (leader paid 50¢): a re-check leaves it skipped and
    // counts the attempt on the signal.
    const retries = async () =>
      (await db.select().from(signals).where(eq(signals.id, "0xretry:hn:BUY:100")))[0].retries;
    await writeSetting(db, "risk", { ...DEFAULT_RISK_CONFIG, retrySkipped: false });
    await runTick(db, t0 * 1000, { housekeeping: false });
    expect(await retries()).toBe(0);
    await writeSetting(db, "risk", { ...DEFAULT_RISK_CONFIG, retrySkipped: true });
    await runTick(db, t0 * 1000, { housekeeping: false });
    expect(await retries()).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------
// Verification rules: each one changes a trader's metrics or a check's verdict.

const day0 = 1_790_000_000;
const sim = skilledTrader("0xsweep", 0.08, 6.4, day0, 180, 1);
const input = inputAt(sim, day0 + 120 * DAY, day0);
const CTX = { eThreshold: 1, candidates: 1 };
type Adjust = (m: TraderMetrics) => TraderMetrics;
const view = (cfg: ScoringConfig, adjust: Adjust = (m) => m) => {
  const m = adjust(computeMetrics(input, cfg));
  return { m, checks: new Map(buildChecks(m, cfg, CTX).map((c) => [c.code, c])) };
};
const base = view(DEFAULT_SCORING_CONFIG);

/** A threshold just past the measured value, on the other side from today's verdict. */
function flip(ok: boolean, value: number, atLeast: boolean, int = false): number {
  const eps = int ? 1 : Math.max(1e-6, Math.abs(value) * 1e-3);
  const up = atLeast === ok; // passing an "at least" check → raise the bar
  return int ? (up ? Math.floor(value) + 1 : Math.ceil(value) - 1) : value + (up ? eps : -eps);
}

type CheckCase = [
  keyof ScoringConfig,
  string,
  (m: TraderMetrics) => number,
  boolean,
  boolean?,
  Adjust?,
];
const checkCases: CheckCase[] = [
  ["minResolved", "sample", (m) => m.nResolved, true, true],
  ["minEvents", "events", (m) => m.nEvents, true, true],
  ["minRoiShrunk", "roi", (m) => m.roiShrunk!, true],
  ["maxTopMarketShare", "top_market", (m) => m.topMarketShare!, false],
  ["maxTop3Share", "top3_markets", (m) => m.top3Share!, false],
  ["minMonths", "months", (m) => m.months, true, true],
  // The fixture sits on the bound (100% / 0 / 0 days): move it inside so both sides exist.
  [
    "minProfitableMonthsPct",
    "profitable_months",
    (m) => m.profitableMonthsPct!,
    true,
    false,
    (m) => ({ ...m, profitableMonthsPct: 0.7 }),
  ],
  ["minRecoveryFactor", "recovery", (m) => m.recoveryFactor!, true],
  ["maxTradesPerDay", "bot_activity", (m) => m.tradesPerDay!, false],
  [
    "maxBothSidesRatio",
    "both_sides",
    (m) => m.bothSidesRatio!,
    false,
    false,
    (m) => ({ ...m, bothSidesRatio: 0.2 }),
  ],
  ["minMedianHoldHours", "hold_time", (m) => m.medianHoldHours!, true],
  ["minCopyAdjRoi", "copy_roi", (m) => m.copyAdjRoi!, true],
  ["minOosRoi", "recent", (m) => m.oosRoi!, true],
  [
    "maxDaysSinceTrade",
    "active",
    (m) => m.daysSinceTrade!,
    false,
    true,
    (m) => ({ ...m, daysSinceTrade: 5 }),
  ],
  // Proven skill keeps a Candidate past the deadline by design; judge an unproven one.
  [
    "maxCandidateDays",
    "candidate_age",
    (m) => m.holdoutDays!,
    false,
    true,
    (m) => ({ ...m, eSkill: 0 }),
  ],
];

describe("every verification rule changes a verdict or a measurement", () => {
  it.each(checkCases)("%s flips the %s check", (key, code, value, atLeast, int, adjust) => {
    const before = view(DEFAULT_SCORING_CONFIG, adjust);
    const v = value(before.m);
    expect(Number.isFinite(v)).toBe(true);
    const ok = before.checks.get(code)!.ok;
    const changed = ScoringConfigSchema.parse({
      ...DEFAULT_SCORING_CONFIG,
      [key]: flip(ok, v, atLeast, int),
    });
    expect(view(changed, adjust).checks.get(code)!.ok).toBe(!ok);
  });

  type MetricCase = [keyof ScoringConfig, number, (m: TraderMetrics) => unknown];
  it.each<MetricCase>([
    ["roiShrinkK", 300, (m) => m.roiShrunk],
    ["minEntryPrice", 0.3, (m) => m.zSkill],
    ["maxEntryPrice", 0.7, (m) => m.zSkill],
    ["minEdge", 0.12, (m) => m.eNoEdge],
    ["oosDays", 20, (m) => m.oosRoi],
    ["copyRoiZ", 0, (m) => m.copyAdjRoi],
    ["copyLossZ", 0, (m) => m.copyRoiUpper],
    ["minCopyReplays", 100_000, (m) => m.copyAdjRoi],
  ])("%s → %j changes the trader's numbers", (key, changed, read) => {
    const after = view(ScoringConfigSchema.parse({ ...DEFAULT_SCORING_CONFIG, [key]: changed }));
    expect(read(after.m)).not.toEqual(read(base.m));
  });

  it("fdrQ moves the bar every trader's skill evidence must clear", () => {
    const pool = [base.m.eSkill, 40, 30, 25, 12, 8, 3, 1, 1, 1];
    expect(eBenjaminiHochbergThreshold(pool, 0.2)).not.toBe(
      eBenjaminiHochbergThreshold(pool, DEFAULT_SCORING_CONFIG.fdrQ),
    );
  });

  it("eliteScore splits Verified from Elite", () => {
    const pass = Object.fromEntries([...base.checks].map(([k]) => [k, true]));
    expect(Object.keys(pass).length).toBeGreaterThan(0);
    // Every check passing (skill proven, nothing else failed):
    const m: TraderMetrics = {
      ...base.m,
      nHoldout: null,
      eSkill: 1e9,
      topMarketShare: 0,
      top3Share: 0,
      profitableMonthsPct: 1,
      recoveryFactor: 99,
      tradesPerDay: 1,
      bothSidesRatio: 0,
      medianHoldHours: 99,
      copyAdjRoi: 0.5,
      copyRoiUpper: 0.5,
      oosRoi: 0.5,
      daysSinceTrade: 0,
      roiShrunk: 0.5,
    };
    const r = scoreTrader(m, DEFAULT_SCORING_CONFIG, CTX);
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    const elite = { ...DEFAULT_SCORING_CONFIG, eliteScore: Math.floor(r.score) };
    const verified = { ...DEFAULT_SCORING_CONFIG, eliteScore: Math.floor(r.score) + 1 };
    expect(scoreTrader(m, elite, CTX).tier).toBe("elite");
    expect(scoreTrader(m, verified, CTX).tier).toBe("verified");
  });
});
