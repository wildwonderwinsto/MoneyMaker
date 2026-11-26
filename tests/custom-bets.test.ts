import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BetError,
  createPortfolio,
  deletePortfolio,
  getPortfolioDetail,
  openBets,
  placeBet,
  portfolioSummaries,
  refreshBets,
  resetPortfolio,
  sellBet,
  type BetMarket,
} from "@/lib/custom/bets";
import type { Db } from "@/lib/db/client";
import { customFills, paperAccounts } from "@/lib/db/schema";

import { createTestDb } from "./helpers/db";

const market: BetMarket = {
  conditionId: "0x" + "ab".repeat(32),
  tokenId: "yes-token",
  outcomeIndex: 0,
  outcome: "Yes",
  title: "Will it rain?",
  slug: "will-it-rain",
  eventSlug: "rain",
  image: null,
  feeRate: 0,
};
const asks = [
  { price: 0.4, size: 100 },
  { price: 0.5, size: 1000 },
];

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await createTestDb()));
afterAll(() => close());

describe("personal bets", () => {
  it("keeps several portfolios, each with its own cash", async () => {
    const a = await createPortfolio(db, "A", 1000);
    const b = await createPortfolio(db, "B", 50);
    await placeBet(db, a.id, market, 100, asks);
    const s = await portfolioSummaries(db);
    const sa = s.find((x) => x.portfolio.id === a.id)!;
    const sb = s.find((x) => x.portfolio.id === b.id)!;
    expect(sa.portfolio.cash).toBeCloseTo(900, 6);
    expect(sa.openCount).toBe(1);
    expect(sb.portfolio.cash).toBe(50);
    expect(sb.openCount).toBe(0);
    // The copy engine's account is untouched (none was even created).
    expect(await db.select().from(paperAccounts)).toHaveLength(0);
  });

  it("buys at the live asks: walks the book, pays fees, records a fill", async () => {
    const p = await createPortfolio(db, "Fees", 1000);
    // 100 @ 0.40 = $40, then $60 / 0.50 = 120 shares → 220 shares for $100.
    const r = await placeBet(db, p.id, market, 100, asks);
    expect(r.shares).toBeCloseTo(220, 6);
    expect(r.cost).toBeCloseTo(100, 6);
    expect(r.partial).toBe(false);
    const withFee = await placeBet(db, p.id, { ...market, feeRate: 0.05 }, 10, [
      { price: 0.5, size: 1000 },
    ]);
    // 0.5 + 0.05 × 0.25 = 0.5125 per share.
    expect(withFee.shares).toBeCloseTo(10 / 0.5125, 6);
    const fills = await db.select().from(customFills).where(eq(customFills.portfolioId, p.id));
    expect(fills).toHaveLength(2);
    expect(fills.find((f) => f.betId === withFee.bet.id)!.fee).toBeCloseTo(
      withFee.shares * 0.0125,
      5,
    );
  });

  it("refuses bets over the cash, under $1, or with no sellers", async () => {
    const p = await createPortfolio(db, "Small", 20);
    await expect(placeBet(db, p.id, market, 25, asks)).rejects.toThrow(BetError);
    await expect(placeBet(db, p.id, market, 0.5, asks)).rejects.toThrow(/start at/);
    await expect(placeBet(db, p.id, market, 10, [{ price: 0.995, size: 100 }])).rejects.toThrow(
      /Nobody is selling/,
    );
    const [s] = (await portfolioSummaries(db)).filter((x) => x.portfolio.id === p.id);
    expect(s.portfolio.cash).toBe(20);
  });

  it("sells into the bids and books the profit", async () => {
    const p = await createPortfolio(db, "Sell", 1000);
    const { bet } = await placeBet(db, p.id, market, 50, [{ price: 0.5, size: 1000 }]);
    const r = await sellBet(db, bet.id, [{ price: 0.6, size: 1000 }]);
    expect(r.shares).toBeCloseTo(100, 6);
    expect(r.proceeds).toBeCloseTo(60, 6);
    expect(r.pnl).toBeCloseTo(10, 6);
    expect(r.left).toBe(0);
    const d = (await getPortfolioDetail(db, p.id))!;
    expect(d.portfolio.cash).toBeCloseTo(1010, 6);
    expect(d.open).toHaveLength(0);
    expect(d.finished[0].status).toBe("closed");
    expect(d.winRate).toBe(1);
    await expect(sellBet(db, bet.id, [{ price: 0.6, size: 1000 }])).rejects.toThrow(/no longer/);
  });

  it("a thin book sells part and keeps the rest open", async () => {
    const p = await createPortfolio(db, "Thin", 1000);
    const { bet } = await placeBet(db, p.id, market, 50, [{ price: 0.5, size: 1000 }]);
    const r = await sellBet(db, bet.id, [{ price: 0.4, size: 30 }]);
    expect(r.shares).toBeCloseTo(30, 6);
    expect(r.left).toBeCloseTo(70, 6);
    const [open] = await openBets(db, [p.id]);
    expect(open.shares).toBeCloseTo(70, 6);
    expect(open.costBasis).toBeCloseTo(35, 6);
    expect(open.realizedPnl).toBeCloseTo(12 - 15, 6);
  });

  it("marks open bets at the midpoint and settles resolved ones", async () => {
    const p = await createPortfolio(db, "Settle", 1000);
    const win = await placeBet(db, p.id, market, 40, [{ price: 0.4, size: 1000 }]);
    const other = { ...market, conditionId: "0x" + "cd".repeat(32), tokenId: "no-token" };
    const lose = await placeBet(db, p.id, { ...other, outcomeIndex: 1, outcome: "No" }, 30, [
      { price: 0.3, size: 1000 },
    ]);
    const third = { ...market, conditionId: "0x" + "ef".repeat(32), tokenId: "mid-token" };
    await placeBet(db, p.id, third, 20, [{ price: 0.5, size: 1000 }]);

    const settled = await refreshBets(db, await openBets(db, [p.id]), {
      mids: new Map([["mid-token", 0.7]]),
      payouts: new Map([
        [market.conditionId, [1, 0]],
        [other.conditionId, [1, 0]],
      ]),
    });
    expect(settled).toBe(2);
    const d = (await getPortfolioDetail(db, p.id))!;
    // 1000 − 90 bet + 100 from the winner (100 shares × $1) + 0 from the loser.
    expect(d.portfolio.cash).toBeCloseTo(1010, 6);
    expect(d.open).toHaveLength(1);
    expect(d.open[0].currentPrice).toBeCloseTo(0.7, 6);
    expect(d.equity).toBeCloseTo(1010 + 40 * 0.7, 6);
    const byId = new Map(d.finished.map((b) => [b.id, b]));
    expect(byId.get(win.bet.id)!.realizedPnl).toBeCloseTo(60, 6);
    expect(byId.get(lose.bet.id)!.realizedPnl).toBeCloseTo(-30, 6);
    expect(
      d.fills
        .filter((f) => f.kind === "settlement")
        .map((f) => f.side)
        .sort(),
    ).toEqual(["LOSS", "WIN"]);
  });

  it("reset erases the bets; delete removes the portfolio", async () => {
    const p = await createPortfolio(db, "Gone", 1000);
    await placeBet(db, p.id, market, 100, asks);
    await resetPortfolio(db, p.id, 500);
    const d = (await getPortfolioDetail(db, p.id))!;
    expect(d.portfolio.cash).toBe(500);
    expect(d.portfolio.startingBalance).toBe(500);
    expect(d.open).toHaveLength(0);
    expect(d.fills).toHaveLength(0);
    expect(await deletePortfolio(db, p.id)).toBe(true);
    expect(await getPortfolioDetail(db, p.id)).toBeNull();
    expect(await deletePortfolio(db, p.id)).toBe(false);
  });
});
