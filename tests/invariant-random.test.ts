/**
 * Accounting invariant under random operation sequences (was an audit probe; now part of
 * `npm run check`, so a setup failure fails the check instead of hiding in a side run).
 * Property-style check of the paper account's money invariant:
 *   startingBalance + Σ paper_fills.realized_pnl  ==  cash + Σ open cost_basis
 * and the cash-flow identity:
 *   startingBalance − Σ BUY notional + Σ SELL notional + Σ settlement notional == cash
 * after every step of a random sequence of buys / partial sells / full sells / mirrored
 * copy+hedge sells / hedges (executeHedge) / settlements (1, 0, 0.5) / exitTrader / reset.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  applyBuy,
  applySell,
  ensureDefaultAccount,
  resetAccount,
  settlePosition,
} from "@/lib/copy/account";
import { DEFAULT_RISK_CONFIG } from "@/lib/copy/config";
import type { LeaderTrade, MarketInfo } from "@/lib/copy/engine";
import { simulateBuy, simulateSell } from "@/lib/copy/fillSim";
import { executeHedge, exitTrader } from "@/lib/copy/tick";
import type { Db } from "@/lib/db/client";
import { markets, paperAccounts, paperFills, paperPositions } from "@/lib/db/schema";
import * as clob from "@/lib/polymarket/clob";
import { writeSetting } from "@/lib/settings";

import { createTestDb } from "./helpers/db";

vi.mock("@/lib/polymarket/clob", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/clob")>()),
  getBook: vi.fn(),
  getMidpoints: vi.fn(),
}));
vi.mock("@/lib/polymarket/gamma", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/gamma")>()),
  getMarketsByConditionIds: vi.fn(async () => []),
}));

let db: Db;
let close: () => Promise<void>;

// Deterministic PRNG (mulberry32).
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WALLETS = ["0xw1", "0xw2"];
const N_MARKETS = 4;
const FEE = 0.05;
const mkt = (i: number): MarketInfo => ({
  conditionId: `0xc${i}`,
  question: `M${i}`,
  slug: null,
  image: null,
  endDate: new Date(Date.now() + 7 * 86_400_000),
  closed: false,
  tokenIds: [`y${i}`, `n${i}`],
  outcomes: ["Yes", "No"],
  winnerIndex: null,
  payouts: null,
  takerFeeRate: FEE,
});

const randomLevels = (r: () => number, side: "ask" | "bid") => {
  const base = 0.05 + r() * 0.85;
  const n = 1 + Math.floor(r() * 4);
  return Array.from({ length: n }, (_, k) => ({
    price: Math.round((side === "ask" ? base + k * 0.01 : base - k * 0.01) * 100) / 100,
    size: Math.round((1 + r() * 300) * 1e6) / 1e6,
  })).filter((l) => l.price > 0.005 && l.price < 0.995);
};

async function invariant() {
  const [acct] = await db.select().from(paperAccounts);
  const fills = await db.select().from(paperFills);
  const open = await db.select().from(paperPositions).where(eq(paperPositions.status, "open"));
  const realized = fills.reduce((a, f) => a + (f.realizedPnl ?? 0), 0);
  const openCost = open.reduce((a, p) => a + p.costBasis, 0);
  const flows = fills.reduce(
    (a, f) => a + (f.side === "BUY" ? -f.notional : f.notional),
    acct.startingBalance,
  );
  // Per-position: stored realized == Σ its fills' realized
  const all = await db.select().from(paperPositions);
  let posDiff = 0;
  for (const p of all) {
    const fr = fills
      .filter((f) => f.positionId === p.id)
      .reduce((a, f) => a + (f.realizedPnl ?? 0), 0);
    posDiff = Math.max(posDiff, Math.abs(fr - p.realizedPnl));
  }
  return {
    pnlIdentity: acct.startingBalance + realized - (acct.cash + openCost),
    cashFlow: flows - acct.cash,
    posDiff,
    cash: acct.cash,
    nFills: fills.length,
  };
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await ensureDefaultAccount(db);
  await writeSetting(db, "risk", {
    ...DEFAULT_RISK_CONFIG,
    hedgeMaxCostPct: 1,
    hedgeMaxPrice: 0.99,
  });
  for (let i = 0; i < N_MARKETS; i++) {
    const m = mkt(i);
    await db.insert(markets).values({
      conditionId: m.conditionId,
      question: m.question,
      closed: false,
      endDate: m.endDate,
      outcomes: m.outcomes,
      tokenIds: m.tokenIds,
      takerFeeRate: FEE,
      updatedAt: new Date(Date.now() + 3_600_000), // stays "fresh" for the whole run
    });
  }
});
afterAll(async () => close());

describe("AUDIT: money invariant under random operation sequences", () => {
  it("holds to the cent after every step (and reports rounding drift)", async () => {
    const r = rng(12345);
    vi.mocked(clob.getBook).mockImplementation(async (id: string) => ({
      tokenId: id,
      asks: randomLevels(r, "ask"),
      bids: randomLevels(r, "bid"),
      tickSize: 0.01,
      minOrderSize: 0,
      timestamp: Date.now(),
    }));
    const account = await ensureDefaultAccount(db);
    let maxPnl = 0;
    let maxFlow = 0;
    let maxPos = 0;
    let totalFees = 0;
    const counts: Record<string, number> = {};
    const STEPS = Number(process.env.AUDIT_STEPS ?? 600);
    let seq = 0;
    for (let step = 0; step < STEPS; step++) {
      const open = await db
        .select()
        .from(paperPositions)
        .where(and(eq(paperPositions.accountId, account.id), eq(paperPositions.status, "open")));
      const [acct] = await db.select().from(paperAccounts);
      const x = r();
      let op = "";
      if (x < 0.4 || open.length === 0) {
        op = "buy";
        const i = Math.floor(r() * N_MARKETS);
        const m = mkt(i);
        const tok = m.tokenIds[Math.floor(r() * 2)];
        const wallet = WALLETS[Math.floor(r() * 2)];
        const usd = Math.min(acct.cash, 1 + r() * 40);
        if (usd < 1) continue;
        const fill = simulateBuy(randomLevels(r, "ask"), usd, 0.99, 0, FEE);
        if (fill.shares <= 0) continue;
        totalFees += fill.fee;
        const t: LeaderTrade = {
          id: `b${seq++}`,
          wallet,
          ts: 0,
          conditionId: m.conditionId,
          tokenId: tok,
          side: "BUY",
          price: fill.avgPrice,
          size: fill.shares,
          usdc: fill.notional,
          outcome: "Yes",
          title: null,
          slug: null,
        };
        await db.transaction((tx) => applyBuy(tx, account.id, t, m, fill));
      } else if (x < 0.62) {
        const p = open[Math.floor(r() * open.length)];
        const frac = r() < 0.3 ? 1 : r();
        op = frac === 1 ? "sellFull" : "sellPartial";
        const fill = simulateSell(randomLevels(r, "bid"), p.shares * frac, 0, 0, FEE);
        if (fill.shares <= 0) continue;
        totalFees += fill.fee;
        // Mirrored sell: if this copy has a hedge, sell the same fraction of it in one tx
        // (what recordDecision does).
        const hedge = open.find((h) => h.kind === "hedge" && h.hedgeOf === p.id);
        const hfill = hedge
          ? simulateSell(randomLevels(r, "bid"), hedge.shares * frac, 0, 0, FEE)
          : null;
        if (hfill) totalFees += hfill.fee;
        if (hedge && hfill && hfill.shares > 0) op = "mirroredSellWithHedge";
        const t = { id: `s${seq++}`, price: fill.avgPrice } as LeaderTrade;
        await db.transaction(async (tx) => {
          await applySell(tx, p, t, fill);
          if (hedge && hfill && hfill.shares > 0) await applySell(tx, hedge, t, hfill);
        });
      } else if (x < 0.75) {
        op = "hedge";
        const copies = open.filter((p) => p.kind === "copy");
        if (copies.length === 0) continue;
        const p = copies[Math.floor(r() * copies.length)];
        const mode = r() < 0.5 ? "lock" : "breakeven";
        const res = await executeHedge(db, account.id, p.id, mode, {
          ...DEFAULT_RISK_CONFIG,
          hedgeMaxCostPct: 1,
          hedgeMaxPrice: 0.99,
        });
        if (res.ok && res.quote?.fill) totalFees += res.quote.fill.fee;
        if (!res.ok) op = "hedge-refused";
      } else if (x < 0.88) {
        const i = Math.floor(r() * N_MARKETS);
        const m = mkt(i);
        const y = r();
        const payouts = y < 0.4 ? [1, 0] : y < 0.8 ? [0, 1] : [0.5, 0.5];
        op = `settle${payouts.join("/")}`;
        const inMarket = open.filter((p) => p.conditionId === m.conditionId);
        for (const p of inMarket) {
          await db.transaction((tx) =>
            settlePosition(tx, p, payouts[m.tokenIds.indexOf(p.tokenId)]),
          );
        }
      } else if (x < 0.97) {
        op = "exitTrader";
        const res = await exitTrader(db, WALLETS[Math.floor(r() * 2)]);
        expect(res.skipped).toBeUndefined();
      } else {
        if (process.env.AUDIT_NORESET) continue;
        op = "reset";
        await resetAccount(db, account.id, Math.round(500 + r() * 2000));
      }
      counts[op] = (counts[op] ?? 0) + 1;
      const inv = await invariant();
      maxPnl = Math.max(maxPnl, Math.abs(inv.pnlIdentity));
      maxFlow = Math.max(maxFlow, Math.abs(inv.cashFlow));
      maxPos = Math.max(maxPos, inv.posDiff);
      expect(Math.abs(inv.pnlIdentity), `step ${step} ${op}`).toBeLessThan(0.005);
      expect(Math.abs(inv.cashFlow), `step ${step} ${op}`).toBeLessThan(0.005);
    }
    const fin = await invariant();
    console.log(
      JSON.stringify({
        counts,
        maxPnlDrift: maxPnl,
        maxCashFlowDrift: maxFlow,
        maxPositionDrift: maxPos,
        totalFeesSimulated: totalFees,
        finalCash: fin.cash,
        fills: fin.nFills,
      }),
    );
  }, 300_000);
});
