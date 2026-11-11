/**
 * Proven tier (owner, 2026-11-10): a Verified/Elite trader whose copies SINCE they became
 * Verified — replayed with the real delay, slippage and fees, like the copy check — cover
 * at least `provenMinDays` days and `provenMinCopies` copied bets, with a cautious copy
 * return (average − copyRoiZ standard errors) above 0. Below that they drop back to
 * Elite/Verified. Tier order: Proven > Elite > Verified > Candidate > Watchlist > Rejected.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@/lib/db/client";
import { TIER_ORDER, traders, traderScores } from "@/lib/db/schema";
import { DEFAULT_ROTATION, pickDailyWallets } from "@/lib/jobs/rotation";
import { buildReplays, DEFAULT_SCORE, stampVerified } from "@/lib/jobs/score";
import * as clob from "@/lib/polymarket/clob";
import * as data from "@/lib/polymarket/data";
import * as gamma from "@/lib/polymarket/gamma";
import {
  DEFAULT_SCORING_CONFIG,
  ScoringConfigSchema,
  type ScoringConfig,
} from "@/lib/scoring/config";
import {
  computeMetrics,
  type CopyReplay,
  type MetricsInput,
  type TraderMetrics,
} from "@/lib/scoring/metrics";
import { provenStatus, scoreTrader } from "@/lib/scoring/score";
import { TIER_TABS } from "@/lib/tiers";

import { createTestDb } from "./helpers/db";
import { DAY, inputAt, skilledTrader } from "./helpers/skillPipeline";

vi.mock("@/lib/polymarket/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/data")>()),
  getActivity: vi.fn(),
}));
vi.mock("@/lib/polymarket/clob", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/clob")>()),
  getPriceHistory: vi.fn(),
  getMidpoints: vi.fn(),
}));
vi.mock("@/lib/polymarket/gamma", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/gamma")>()),
  getMarketsByConditionIds: vi.fn(),
}));

// ---------------------------------------------------------------------------------------
// Pure tier logic

const day0 = 1_790_000_000;
const sim = skilledTrader("0xproven", 0.08, 6.4, day0, 180, 1);
const base = inputAt(sim, day0 + 120 * DAY, day0);
const NOW = base.now;
const CTX = { eThreshold: 1, candidates: 1 };
const cfg = DEFAULT_SCORING_CONFIG;

/** Every one of the 19 checks passing (as in the eliteScore sweep test). */
const allPass = (m: TraderMetrics): TraderMetrics => ({
  ...m,
  nHoldout: null,
  eSkill: 1e9,
  // z only feeds the composite score (no check): 0 keeps the score below 100, so
  // eliteScore 100 means Verified and 0 means Elite.
  zSkill: 0,
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
});

/**
 * `n` copies spread over the last `days` days, each returning `ret` ± `spread`
 * (alternating), equal stakes: average `ret`, standard error ≈ spread / √n.
 */
function copies(n: number, days: number, ret: number, spread = 0.1, end = NOW): CopyReplay[] {
  return Array.from({ length: n }, (_, i) => ({
    delayedPrice: 0.5,
    exitValue: 0.5 * (1 + ret + (i % 2 ? spread : -spread)),
    weight: 50,
    ts: Math.floor(end - days * DAY + ((i + 0.5) / n) * days * DAY),
  }));
}

function metricsWith(
  record: { from: number | null; replays: CopyReplay[] | null },
  c: ScoringConfig = cfg,
): TraderMetrics {
  const input: MetricsInput = {
    ...base,
    verifiedFrom: record.from,
    sinceVerifiedReplays: record.replays,
  };
  return allPass(computeMetrics(input, c));
}

const tierOf = (m: TraderMetrics, c: ScoringConfig = cfg) => scoreTrader(m, c, CTX).tier;

describe("Proven tier", () => {
  it("defaults: 30 days and 50 copied bets, judged at the copy-return confidence setting", () => {
    expect(cfg.provenMinDays).toBe(30);
    expect(cfg.provenMinCopies).toBe(50);
  });

  it("a passing trader with 30+ days, 50+ copies since Verified and a cautious return above 0 is Proven", () => {
    const m = metricsWith({ from: NOW - 31 * DAY, replays: copies(60, 31, 0.1) });
    expect(m.sinceVerifiedCopies).toBe(60);
    expect(m.sinceVerifiedDays).toBeCloseTo(31, 5);
    expect(m.sinceVerifiedCopyRoi).toBeGreaterThan(0);
    expect(provenStatus(m, cfg).proven).toBe(true);
    expect(tierOf(m)).toBe("proven");
    // Proven sits above Elite: a top score doesn't keep a proven trader at Elite.
    expect(tierOf(m, { ...cfg, eliteScore: 0 })).toBe("proven");
  });

  it("drops back to Elite/Verified with under 30 days since Verified", () => {
    const m = metricsWith({ from: NOW - 29 * DAY, replays: copies(60, 29, 0.1) });
    expect(provenStatus(m, cfg).proven).toBe(false);
    expect(tierOf(m, { ...cfg, eliteScore: 0 })).toBe("elite");
    expect(tierOf(m, { ...cfg, eliteScore: 100 })).toBe("verified");
  });

  it("drops back with fewer than 50 copied bets", () => {
    const m = metricsWith({ from: NOW - 40 * DAY, replays: copies(49, 40, 0.1) });
    expect(m.sinceVerifiedCopies).toBe(49);
    expect(tierOf(m, { ...cfg, eliteScore: 100 })).toBe("verified");
  });

  it("drops back when the cautious copy return isn't above 0, even with a positive average", () => {
    // Average +2%, but ±50% swings: average − 1.28 standard errors is below 0.
    const m = metricsWith({ from: NOW - 40 * DAY, replays: copies(60, 40, 0.02, 0.5) });
    expect(m.sinceVerifiedCopyRoiMean).toBeGreaterThan(0);
    expect(m.sinceVerifiedCopyRoi).toBeLessThanOrEqual(0);
    expect(tierOf(m, { ...cfg, eliteScore: 100 })).toBe("verified");
    // With the confidence setting at 0 (plain average) the same record is enough.
    const plain = { ...cfg, eliteScore: 100, copyRoiZ: 0 };
    const m0 = metricsWith({ from: NOW - 40 * DAY, replays: copies(60, 40, 0.02, 0.5) }, plain);
    expect(m0.sinceVerifiedCopyRoi).toBeCloseTo(0.02, 10);
    expect(tierOf(m0, plain)).toBe("proven");
  });

  it("counts only copies of bets placed since the trader became Verified", () => {
    const before = copies(100, 60, 0.3, 0.1, NOW - 35 * DAY); // great, but before verification
    const after = copies(49, 35, 0.1);
    const m = metricsWith({ from: NOW - 35 * DAY, replays: [...before, ...after] });
    expect(m.sinceVerifiedCopies).toBe(49);
    expect(tierOf(m, { ...cfg, eliteScore: 100 })).toBe("verified");
  });

  it("never Proven without a record: not Verified yet, or no replays this run", () => {
    const never = metricsWith({ from: null, replays: copies(60, 40, 0.1) });
    expect(never.sinceVerifiedCopies).toBeNull();
    expect(never.sinceVerifiedDays).toBeNull();
    expect(tierOf(never, { ...cfg, eliteScore: 100 })).toBe("verified");
    const unmeasured = metricsWith({ from: NOW - 40 * DAY, replays: null });
    expect(unmeasured.sinceVerifiedCopies).toBeNull();
    expect(tierOf(unmeasured, { ...cfg, eliteScore: 100 })).toBe("verified");
  });

  it("is never given to a trader who fails a check, however good the record", () => {
    const m = { ...metricsWith({ from: NOW - 60 * DAY, replays: copies(80, 60, 0.2) }) };
    m.profitableMonthsPct = 0.1; // one soft failure → Watchlist
    expect(tierOf(m)).toBe("watchlist");
    m.topMarketShare = 0.99; // a hard failure → Rejected
    expect(tierOf(m)).toBe("rejected");
  });

  it("provenMinDays and provenMinCopies settings move the line", () => {
    const m = metricsWith({ from: NOW - 20 * DAY, replays: copies(30, 20, 0.1) });
    expect(tierOf(m, { ...cfg, eliteScore: 100 })).toBe("verified");
    const loose = { ...cfg, eliteScore: 100, provenMinDays: 20, provenMinCopies: 30 };
    expect(tierOf(m, loose)).toBe("proven");
    expect(tierOf(m, { ...loose, provenMinDays: 21 })).toBe("verified");
    expect(tierOf(m, { ...loose, provenMinCopies: 31 })).toBe("verified");
  });

  it("settings have sensible bounds", () => {
    const parse = (v: Partial<ScoringConfig>) =>
      ScoringConfigSchema.safeParse({ ...cfg, ...v }).success;
    expect(parse({ provenMinDays: 14 })).toBe(true);
    expect(parse({ provenMinDays: 365 })).toBe(true);
    expect(parse({ provenMinDays: 13 })).toBe(false);
    expect(parse({ provenMinDays: 366 })).toBe(false);
    expect(parse({ provenMinDays: 30.5 })).toBe(false);
    expect(parse({ provenMinCopies: 20 })).toBe(true);
    // The since-Verified sample is at most replaysPerTrader copies: more could never pass.
    expect(parse({ provenMinCopies: DEFAULT_SCORE.replaysPerTrader })).toBe(true);
    expect(parse({ provenMinCopies: DEFAULT_SCORE.replaysPerTrader + 1 })).toBe(false);
    expect(parse({ provenMinCopies: 19 })).toBe(false);
  });
});

describe("tier order and tabs", () => {
  it("Proven > Elite > Verified > Candidate > Watchlist > Rejected", () => {
    expect(TIER_ORDER).toEqual([
      "proven",
      "elite",
      "verified",
      "candidate",
      "watchlist",
      "rejected",
    ]);
  });

  it("tabs run best first, then a gap, then Following, Everyone, Hidden", () => {
    expect(TIER_TABS.map((t) => t.value)).toEqual([
      "proven",
      "elite",
      "verified",
      "candidate",
      "watchlist",
      "followed",
      "all",
      "hidden",
    ]);
    expect(TIER_TABS.map((t) => t.label)).toEqual([
      "Proven",
      "Elite",
      "Verified",
      "Candidates",
      "Watchlist",
      "Following",
      "Everyone",
      "Hidden",
    ]);
    // The gap: the first tab of the second group.
    expect(TIER_TABS.findIndex((t) => t.group === "lists")).toBe(5);
    expect(TIER_TABS.find((t) => t.value === "hidden")?.adminOnly).toBe(true);
    for (const t of TIER_TABS) expect(t.help(cfg).length).toBeGreaterThan(20);
    // Tooltips use the live settings, not hard-coded numbers.
    const proven = TIER_TABS[0].help({ ...cfg, provenMinDays: 45, provenMinCopies: 80 });
    expect(proven).toContain("45 days");
    expect(proven).toContain("80 copied bets");
    expect(TIER_TABS[1].help({ ...cfg, eliteScore: 75 })).toContain("75");
  });
});

// ---------------------------------------------------------------------------------------
// Jobs: the since-Verified record and its start date

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());
beforeEach(async () => {
  for (const t of [traderScores, traders]) await db.delete(t);
});

describe("since-Verified replays", () => {
  const now = Math.floor(Date.now() / 1000);
  const buy = (daysAgo: number, i: number): data.Activity => ({
    proxy_wallet: "0xleader",
    timestamp: now - Math.round(daysAgo * DAY),
    condition_id: `c${i}`,
    type: "TRADE",
    size: 100,
    usdc_size: 50,
    transaction_hash: `0xtx${i}`,
    price: 0.5,
    token_id: `t${i}`,
    side: "BUY",
    outcome_index: 0,
    title: null,
    slug: null,
    icon: null,
    event_slug: null,
    outcome: "Yes",
    name: null,
    pseudonym: null,
  });

  beforeEach(() => {
    vi.mocked(gamma.getMarketsByConditionIds).mockResolvedValue([]);
    vi.mocked(clob.getMidpoints).mockImplementation(
      async (ids: string[]) => new Map(ids.map((id) => [id, 0.6])),
    );
    vi.mocked(clob.getPriceHistory).mockImplementation(async (_t, o) => [
      { t: (o.startTs ?? 0) + 120, p: 0.5 },
    ]);
  });

  it("replays bets since Verified even past the 90-day window; the copy check's sample is unchanged", async () => {
    // One buy every 2 days for 200 days (newest first, like the API).
    const all = Array.from({ length: 100 }, (_, i) => buy(2 + 2 * i, i));
    vi.mocked(data.getActivity).mockImplementation(async (q) => ({
      data: all.filter((t) => t.timestamp >= (q.start ?? 0)),
      pagination: { has_more: false, next_cursor: null },
    }));
    const verifiedFrom = now - 120 * DAY;
    const r = await buildReplays(db, "0xleader", cfg, DEFAULT_SCORE, now, verifiedFrom);
    // The copy check: last 90 days only, as before.
    expect(r.replays.length).toBe(all.filter((t) => t.timestamp >= now - 90 * DAY).length);
    expect(Math.min(...r.replays.map((x) => x.ts!))).toBeGreaterThanOrEqual(now - 90 * DAY);
    // The since-Verified record: every buy since verification, including days 90–120.
    expect(r.verifiedFrom).toBe(verifiedFrom);
    expect(r.sinceVerified!.length).toBe(all.filter((t) => t.timestamp >= verifiedFrom).length);
    expect(Math.min(...r.sinceVerified!.map((x) => x.ts!))).toBeLessThan(now - 90 * DAY);
    expect(r.sinceVerified!.every((x) => x.ts! >= verifiedFrom)).toBe(true);

    // Not Verified yet: no record, and the fetch starts at the 90-day window as before.
    const none = await buildReplays(db, "0xleader", cfg, DEFAULT_SCORE, now, null);
    expect(none.sinceVerified).toBeNull();
    expect(none.replays.length).toBe(r.replays.length);
  });

  it("a fetch cut short by the trade cap starts the record at the oldest trade it has", async () => {
    const all = Array.from({ length: 100 }, (_, i) => buy(2 + 2 * i, i));
    vi.mocked(data.getActivity).mockImplementation(async () => ({
      data: all.slice(0, 40), // newest 40: back to day 80
      pagination: { has_more: false, next_cursor: null },
    }));
    const r = await buildReplays(
      db,
      "0xleader",
      cfg,
      { ...DEFAULT_SCORE, maxReplayTrades: 40 },
      now,
      now - 150 * DAY,
    );
    // Days are only counted where trades were actually seen.
    expect(r.verifiedFrom).toBe(all[39].timestamp);
  });
});

const ROTATION = { ...DEFAULT_ROTATION, earlyReturnMarkets: 50 };

describe("verified_at: when the since-Verified record starts", () => {
  const at = new Date("2026-11-08T10:00:00Z");
  const later = new Date("2026-11-20T10:00:00Z");

  it("is stamped the first time a trader is Verified, Elite or Proven, and kept after", async () => {
    await db
      .insert(traders)
      .values(["0xv", "0xe", "0xp", "0xc", "0xw"].map((wallet) => ({ wallet })));
    await stampVerified(
      db,
      [
        { wallet: "0xv", tier: "verified" },
        { wallet: "0xe", tier: "elite" },
        { wallet: "0xp", tier: "proven" },
        { wallet: "0xc", tier: "candidate" },
        { wallet: "0xw", tier: "watchlist" },
      ],
      at,
    );
    const stamp = async (w: string) =>
      (await db.select().from(traders).where(eq(traders.wallet, w)))[0].verifiedAt;
    expect(await stamp("0xv")).toEqual(at);
    expect(await stamp("0xe")).toEqual(at);
    expect(await stamp("0xp")).toEqual(at);
    expect(await stamp("0xc")).toBeNull();
    expect(await stamp("0xw")).toBeNull();
    // Later runs keep the first stamp, including after a dip to the Watchlist.
    await stampVerified(db, [{ wallet: "0xv", tier: "watchlist" }], later);
    await stampVerified(db, [{ wallet: "0xv", tier: "verified" }], later);
    expect(await stamp("0xv")).toEqual(at);
  });

  it("restarts when a wallet is re-picked after a cool-down (its holdout restarts too)", async () => {
    const now = new Date("2026-11-08T10:00:00Z");
    await db.insert(traders).values({
      wallet: "0xback",
      firstCheckedAt: new Date(now.getTime() - 90 * 86_400_000),
      lastCheckedAt: new Date(now.getTime() - 40 * 86_400_000),
      verifiedAt: new Date(now.getTime() - 80 * 86_400_000),
    });
    const r = await pickDailyWallets(db, ["0xback"], ROTATION, now);
    expect(r.returning).toBe(1);
    const [t] = await db.select().from(traders).where(eq(traders.wallet, "0xback"));
    expect(t.holdoutFrom).toEqual(now);
    expect(t.verifiedAt).toBeNull();
  });

  it("Proven traders are re-checked first among the scored tiers", async () => {
    const day = (d: number) => new Date(Date.parse("2026-11-08T10:00:00Z") - d * 86_400_000);
    for (const [wallet, tier, score] of [
      ["0xv", "verified", 90],
      ["0xp", "proven", 40],
      ["0xe", "elite", 80],
    ] as const) {
      await db.insert(traders).values({ wallet, lastCheckedAt: day(1) });
      await db.insert(traderScores).values({
        wallet,
        tier,
        score,
        passed: true,
        nResolved: 0,
        nEvents: 0,
        computedAt: day(1),
      });
    }
    const r = await pickDailyWallets(db, [], { ...ROTATION, recheckCap: 2 }, day(0));
    expect(r.wallets).toEqual(["0xp", "0xv"]);
  });
});
