"use server";

/** Personal bets (see lib/custom/bets.ts). Admin only, like every action that changes data. */
import { refresh } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/app/actions";
import { requireAdmin } from "@/lib/admin";
import {
  BetError,
  createPortfolio,
  deletePortfolio,
  getBet,
  placeBet,
  resetPortfolio,
  sellBet,
  snapshot,
} from "@/lib/custom/bets";
import { lookupBetMarket, syncBets } from "@/lib/custom/polymarket";
import { getDb } from "@/lib/db/client";
import { usd } from "@/lib/format";
import { getBook } from "@/lib/polymarket/clob";

const Id = z.number().int().positive();
const Balance = z.coerce.number().min(10, "At least $10").max(10_000_000);

async function run(fn: () => Promise<string>): Promise<ActionResult> {
  try {
    await requireAdmin();
    const message = await fn();
    refresh();
    return { ok: true, message };
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, message: err.issues[0]?.message ?? "Invalid input" };
    }
    return {
      ok: false,
      message:
        err instanceof BetError || err instanceof Error ? err.message : "Something went wrong",
    };
  }
}

export async function createPortfolioAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return run(async () => {
    const name =
      z
        .string()
        .trim()
        .max(60)
        .parse(form.get("name") ?? "") || "My bets";
    const balance = Balance.parse(form.get("balance"));
    await createPortfolio(getDb(), name, balance);
    return `Created “${name}” with ${usd(balance)}`;
  });
}

export async function resetPortfolioAction(id: number, balance: number): Promise<ActionResult> {
  return run(async () => {
    await resetPortfolio(getDb(), Id.parse(id), Balance.parse(balance));
    return `Reset to ${usd(balance)}`;
  });
}

export async function deletePortfolioAction(id: number): Promise<ActionResult> {
  return run(async () => {
    if (!(await deletePortfolio(getDb(), Id.parse(id)))) throw new Error("Already deleted");
    return "Portfolio deleted";
  });
}

export async function placeBetAction(input: {
  portfolioId: number;
  conditionId: string;
  outcomeIndex: number;
  amount: number;
}): Promise<ActionResult> {
  return run(async () => {
    const { portfolioId, conditionId, outcomeIndex, amount } = z
      .object({
        portfolioId: Id,
        conditionId: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Unknown market"),
        outcomeIndex: z.number().int().min(0).max(50),
        amount: z.number().positive("Enter an amount").max(10_000_000),
      })
      .parse(input);
    const market = await lookupBetMarket(conditionId, outcomeIndex);
    const book = await getBook(market.tokenId);
    const db = getDb();
    const r = await placeBet(db, portfolioId, market, amount, book.asks);
    await snapshot(db, portfolioId, 0);
    const msg = `Bought ${r.shares.toFixed(1)} ${market.outcome} shares at ${(r.avgPrice * 100).toFixed(1)}¢ for ${usd(r.cost)}`;
    return r.partial
      ? `${msg} (the order book ran out under 99¢, so this is all that filled)`
      : msg;
  });
}

export async function sellBetAction(betId: number): Promise<ActionResult> {
  return run(async () => {
    const db = getDb();
    const bet = await getBet(db, Id.parse(betId));
    if (!bet || bet.status !== "open") throw new BetError("This bet is no longer open");
    const book = await getBook(bet.tokenId);
    const r = await sellBet(db, bet.id, book.bids);
    await snapshot(db, bet.portfolioId, 0);
    const msg = `Sold ${r.shares.toFixed(1)} shares for ${usd(r.proceeds)} (${usd(r.pnl, { sign: true })})`;
    return r.left > 0 ? `${msg}. ${r.left.toFixed(1)} shares had no buyer and stay open.` : msg;
  });
}

export async function refreshBetsAction(): Promise<ActionResult> {
  return run(async () => {
    await syncBets(getDb(), { force: true });
    return "Prices updated";
  });
}
