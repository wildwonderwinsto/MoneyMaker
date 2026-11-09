/**
 * Discovery rotation (owner decision 2026-11-08, design #3) and the scoring changes it
 * relies on: who gets one of the daily slots, cool-downs, and "score only what was
 * checked today" (J1).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/lib/db/client";
import { follows, hiddenTraders, traders, traderScores } from "@/lib/db/schema";
import { DEFAULT_DISCOVER } from "@/lib/jobs/discover";
import { DEFAULT_ROTATION, pickDailyWallets } from "@/lib/jobs/rotation";
import { DEFAULT_SCORE, recentTestedEValues, scoreAll } from "@/lib/jobs/score";
import { DEFAULT_SCORING_CONFIG as cfg } from "@/lib/scoring/config";

import { createTestDb } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());
beforeEach(async () => {
  for (const t of [traderScores, follows, hiddenTraders, traders]) await db.delete(t);
});

const NOW = new Date("2026-11-08T10:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const opts = { ...DEFAULT_ROTATION, slots: 8, recheckCap: 4, earlyReturnMarkets: 50 };

async function scored(wallet: string, tier: string, score: number, lastCheckedAt: Date) {
  await db.insert(traders).values({ wallet, lastCheckedAt }).onConflictDoNothing();
  await db.insert(traderScores).values({
    wallet,
    tier: tier as "elite",
    score,
    passed: tier === "elite" || tier === "verified",
    nResolved: 0,
    nEvents: 0,
    computedAt: lastCheckedAt,
  });
}

describe("pickDailyWallets", () => {
  it("re-checks followed → Verified/Elite → due Candidates → Watchlist, up to the cap", async () => {
    // Owner decision (2026-11-08, revised): Candidates before Watchlist, or a big Watchlist
    // (104 in a live run) takes every slot and Candidates are never re-checked.
    await db.insert(follows).values([{ wallet: "0xf1" }, { wallet: "0xpaused", enabled: false }]);
    await scored("0xv-low", "verified", 40, daysAgo(1));
    await scored("0xe-high", "elite", 80, daysAgo(1));
    await scored("0xw", "watchlist", 50, daysAgo(1));
    await scored("0xc-due", "candidate", 60, daysAgo(8));
    await scored("0xc-notdue", "candidate", 90, daysAgo(2));
    const r = await pickDailyWallets(db, [], opts, NOW);
    // Cap 4: followed, then V/E by score, then the due candidate. Watchlist didn't fit.
    expect(r.wallets).toEqual(["0xf1", "0xe-high", "0xv-low", "0xc-due"]);
    expect(r.recheck).toBe(4);

    const roomy = await pickDailyWallets(db, [], { ...opts, recheckCap: 10 }, NOW);
    expect(roomy.wallets).toEqual(["0xf1", "0xe-high", "0xv-low", "0xc-due", "0xw"]);
  });

  it("re-checks due Candidates oldest first, not by score (owner, 2026-11-09)", async () => {
    // ~2,000 Candidates wait at steady state under the sequential skill test; in score order
    // the low-scored ones would never be re-checked before their 180-day limit.
    await scored("0xc-high-recent", "candidate", 90, daysAgo(8));
    await scored("0xc-low-oldest", "candidate", 20, daysAgo(30));
    await scored("0xc-mid-older", "candidate", 50, daysAgo(15));
    const r = await pickDailyWallets(db, [], { ...opts, recheckCap: 2 }, NOW);
    expect(r.wallets).toEqual(["0xc-low-oldest", "0xc-mid-older"]);
  });

  it("defaults: 120 re-checks in 210 daily slots (owner, 2026-11-09)", () => {
    expect(DEFAULT_ROTATION.recheckCap).toBe(120);
    expect(DEFAULT_DISCOVER.maxCandidates).toBe(210);
  });

  it("never drops a followed trader, even past the cap", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ wallet: `0xf${i}` }));
    await db.insert(follows).values(many);
    await scored("0xe", "elite", 90, daysAgo(1));
    const r = await pickDailyWallets(db, [], opts, NOW);
    expect(r.wallets.slice(0, 6).sort()).toEqual(many.map((m) => m.wallet).sort());
    expect(r.wallets).not.toContain("0xe"); // cap already used up by followed traders
  });

  it("fills the rest with new wallets; rejected ones cool down 30 days unless they traded 50+ new markets", async () => {
    await db.insert(traders).values([
      { wallet: "0xnew1" },
      { wallet: "0xcool", lastCheckedAt: daysAgo(10), marketsTraded: 120, marketsAtCheck: 100 },
      { wallet: "0xback", lastCheckedAt: daysAgo(10), marketsTraded: 150, marketsAtCheck: 100 },
      {
        wallet: "0xexpired",
        lastCheckedAt: daysAgo(31),
        marketsTraded: 100,
        marketsAtCheck: 100,
      },
      { wallet: "0xhidden" },
      { wallet: "0xnew2" },
    ]);
    await db.insert(hiddenTraders).values({ wallet: "0xhidden" });
    const ranked = ["0xnew1", "0xcool", "0xhidden", "0xback", "0xexpired", "0xnew2", "0xunknown"];
    const r = await pickDailyWallets(db, ranked, { ...opts, slots: 5 }, NOW);
    expect(r.wallets).toEqual(["0xnew1", "0xback", "0xexpired", "0xnew2", "0xunknown"]);
    expect(r.fresh).toBe(5);
  });
});

describe("scoring with rotation", () => {
  it("scores only the wallets checked today and stamps when they were checked (J1)", async () => {
    // Regression (J1): every wallet ever backfilled was re-scored daily on frozen history.
    await db.insert(traders).values([
      { wallet: "0xtoday", lastBackfillAt: NOW, marketsTraded: 77 },
      { wallet: "0xstale", lastBackfillAt: daysAgo(5) },
    ]);
    await scoreAll(db, { ...cfg, simulations: 100 }, DEFAULT_SCORE, () => {}, ["0xtoday"]);
    const rows = await db.select().from(traderScores);
    expect(rows.map((r) => r.wallet)).toEqual(["0xtoday"]);
    const [t] = await db.select().from(traders).where(eq(traders.wallet, "0xtoday"));
    expect(t.firstCheckedAt).not.toBeNull();
    expect(t.lastCheckedAt).not.toBeNull();
    expect(t.marketsAtCheck).toBe(77);
    // A second check keeps the first-check date: that's where the holdout starts.
    const first = t.firstCheckedAt!.getTime();
    await scoreAll(db, { ...cfg, simulations: 100 }, DEFAULT_SCORE, () => {}, ["0xtoday"]);
    const [again] = await db.select().from(traders).where(eq(traders.wallet, "0xtoday"));
    expect(again.firstCheckedAt!.getTime()).toBe(first);
  });

  it("pools the skill test over everyone tested in the last 30 days", async () => {
    const row = (wallet: string, days: number, e: number | undefined, nHoldout: number) => ({
      wallet,
      tier: "rejected" as const,
      score: 0,
      passed: false,
      nResolved: 0,
      nEvents: 0,
      computedAt: daysAgo(days),
      metrics: e === undefined ? { mcPValue: 0.01, nHoldout } : { eSkill: e, nHoldout },
    });
    await db.insert(traderScores).values([
      row("0xa", 3, 5, 60),
      row("0xb", 29, 0.4, 80),
      row("0xold", 31, 900, 90), // outside the 30-day window
      row("0xthin", 2, 3, 10), // too few post-pick bets: not tested
      row("0xtoday", 1, 0.5, 70), // re-checked today: today's value is used instead
      row("0xlegacy", 4, undefined, 70), // scored before the sequential test: counts as 1
    ]);
    const es = await recentTestedEValues(db, daysAgo(30), new Set(["0xtoday"]), cfg.minResolved);
    expect(es.sort((x, y) => x - y)).toEqual([0.4, 1, 5]);
  });
});
