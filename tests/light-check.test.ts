/**
 * Cheap Candidate re-checks (owner decision 2026-11-09, capacity option b): post-pick
 * positions only, never a promotion — proven evidence asks for a full check first.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@/lib/db/client";
import { follows, markets, traderPositions, traders, traderScores } from "@/lib/db/schema";
import { lightCheck } from "@/lib/jobs/lightCheck";
import { DEFAULT_ROTATION, pickDailyWallets } from "@/lib/jobs/rotation";
import * as data from "@/lib/polymarket/data";
import { DEFAULT_SCORING_CONFIG as cfg } from "@/lib/scoring/config";
import { computeMetrics } from "@/lib/scoring/metrics";

import { steadyGrinder } from "./fixtures/traders";
import { createTestDb } from "./helpers/db";

vi.mock("@/lib/polymarket/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/data")>()),
  getPositions: vi.fn(),
}));

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());
beforeEach(async () => {
  for (const t of [traderPositions, follows, traderScores, markets, traders]) await db.delete(t);
});

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const ago = (d: number) => new Date((NOW - d * DAY) * 1000);
const opts = { ...DEFAULT_ROTATION, slots: 10, recheckCap: 5, earlyReturnMarkets: 50 };

/** A Candidate fully checked 10 days ago, picked 60 days ago. */
async function candidate(wallet: string, lastFull: number, lastCheck = 8) {
  await db.insert(traders).values({
    wallet,
    firstCheckedAt: ago(60),
    lastCheckedAt: ago(lastCheck),
    lastFullCheckAt: ago(lastFull),
  });
  // Every non-skill check passed at the last full check (the grinder's history).
  const m = computeMetrics({ ...steadyGrinder(), holdoutFrom: steadyGrinder().now }, cfg);
  await db.insert(traderScores).values({
    wallet,
    tier: "candidate",
    score: 50,
    passed: false,
    nResolved: m.nResolved,
    nEvents: m.nEvents,
    computedAt: ago(lastCheck),
    metrics: m as unknown as Record<string, unknown>,
  });
}

/** 120 post-pick bets at 50¢ in separate events, 100 of them won: clearly skilled. */
async function strongPostPickBets(wallet: string) {
  const rows = Array.from({ length: 120 }, (_, i) => ({
    proxy_wallet: wallet,
    token_id: `t${i}`,
    condition_id: `c${i}`,
    current_size: 0,
    avg_price: 0.5,
    total_size: 100,
    total_cost_usdc: 50,
    current_price: null,
    current_value: null,
    realized_pnl: i < 100 ? 50 : -50,
    unrealized_pnl: null,
    total_pnl: null,
    status: "CLOSED",
    redeemable: false,
    negative_risk: false,
    title: null,
    slug: null,
    icon: null,
    event_id: `e${i}`,
    event_slug: null,
    outcome: "Yes",
    outcome_index: 0,
    end_date: null,
    first_entry_at: NOW - (55 - i * 0.4) * DAY,
    last_event_at: NOW - (54 - i * 0.4) * DAY,
  }));
  await db.insert(markets).values(
    rows.map((r, i) => ({
      conditionId: r.condition_id,
      question: `q${i}`,
      tokenIds: [r.token_id, `${r.token_id}-no`],
      winnerIndex: i < 100 ? 0 : 1,
      resolvedAt: new Date((r.last_event_at - 0.5 * DAY) * 1000),
    })),
  );
  vi.mocked(data.getPositions).mockImplementation(
    async ({ status, user }) =>
      ({
        data: status === "CLOSED" ? rows.map((r) => ({ ...r, proxy_wallet: user })) : [],
        pagination: { has_more: false, next_cursor: null },
      }) as never,
  );
}

describe("cheap Candidate re-checks", () => {
  it("never promote: proven evidence asks for a full check, which the rotation then gives", async () => {
    await candidate("0xc", 10);
    await strongPostPickBets("0xc");
    const r = await lightCheck(db, cfg, ["0xc"], () => {}, NOW);
    expect(r).toMatchObject({ checked: 1, fullCheckDue: 1, rejected: 0 });
    const [s] = await db.select().from(traderScores).where(eq(traderScores.wallet, "0xc"));
    expect(s.tier).toBe("candidate"); // not verified/elite without a fresh full check
    expect(s.passed).toBe(false);
    expect(s.checks.find((c) => c.code === "skill")?.ok).toBe(true);
    const [t] = await db.select().from(traders).where(eq(traders.wallet, "0xc"));
    expect(t.fullCheckDue).toBe(true);
    // Next run: a full re-check right away (not a cheap one, not waiting a week).
    const pick = await pickDailyWallets(db, [], opts, new Date(NOW * 1000));
    expect(pick.wallets).toContain("0xc");
    expect(pick.light).not.toContain("0xc");
  });

  // prunePositions keeps the history of followed traders (paused too) and of traders whose
  // copy we still hold, but the cheap re-check replaced ALL stored positions with the
  // post-pick ones before it got there (production: a followed Candidate's page said
  // "history isn't stored").
  it("keeps a paused follow's older history; an unfollowed Candidate's is still dropped", async () => {
    const older = (wallet: string) =>
      [1, 2, 3].map((i) => ({
        wallet,
        conditionId: `old${i}`,
        tokenId: `old-t${i}`,
        status: "CLOSED",
        avgPrice: 0.5,
        size: 0,
        sharesBought: 100,
        totalCost: 50,
        realizedPnl: 10,
        firstEntryAt: ago(200 + i),
        lastActivityAt: ago(190 + i),
      }));
    await candidate("0xpaused", 10);
    await candidate("0xplain", 10);
    await db.insert(follows).values({ wallet: "0xpaused", enabled: false });
    await db.insert(traderPositions).values([...older("0xpaused"), ...older("0xplain")]);
    await strongPostPickBets("0xpaused"); // the API mock answers for either wallet
    await lightCheck(db, cfg, ["0xpaused", "0xplain"], () => {}, NOW);
    const stored = async (w: string) =>
      (await db.select().from(traderPositions).where(eq(traderPositions.wallet, w))).map(
        (p) => p.tokenId,
      );
    const paused = await stored("0xpaused");
    expect(paused).toEqual(expect.arrayContaining(["old-t1", "old-t2", "old-t3", "t0", "t119"]));
    expect(paused).toHaveLength(123);
    expect(await stored("0xplain")).toHaveLength(0); // pruned as before
    // The older history doesn't leak into the skill test: both saw the same post-pick bets.
    const skill = async (w: string) => {
      const [s] = await db.select().from(traderScores).where(eq(traderScores.wallet, w));
      const m = s.metrics as { nHoldout?: number; eSkill?: number };
      return [m.nHoldout, m.eSkill];
    };
    expect((await skill("0xpaused"))[0]).toBeGreaterThan(0);
    expect(await skill("0xpaused")).toEqual(await skill("0xplain"));
  });

  it("rotation: cheap re-check within 4 weeks of a full one, full after", async () => {
    await candidate("0xrecent", 10);
    await candidate("0xstale", 29);
    await candidate("0xnotdue", 10, 2); // checked 2 days ago: not due either way
    const pick = await pickDailyWallets(db, [], opts, new Date(NOW * 1000));
    expect(pick.light).toEqual(["0xrecent"]);
    expect(pick.wallets).toEqual(["0xstale"]);
  });
});
