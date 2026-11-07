import { eq } from "drizzle-orm";
import { expect } from "vitest";

import type { Db } from "@/lib/db/client";
import { paperAccounts, paperFills, paperPositions } from "@/lib/db/schema";

/**
 * The paper account must balance: startingBalance + Σ realized P&L (all fills) =
 * cash + Σ cost basis of open positions. Fees are already inside realized P&L (buys add
 * them to cost, sells net them from proceeds), so they are not subtracted again.
 * Every cash change also needs a fill: Σ buy notional out, Σ sell/settlement notional in.
 */
export async function expectBalanced(db: Db, accountId?: number, tolerance = 1e-4) {
  const accounts = await db.select().from(paperAccounts);
  for (const a of accountId ? accounts.filter((x) => x.id === accountId) : accounts) {
    const fills = await db.select().from(paperFills).where(eq(paperFills.accountId, a.id));
    const open = (
      await db.select().from(paperPositions).where(eq(paperPositions.accountId, a.id))
    ).filter((p) => p.status === "open");
    const realized = fills.reduce((s, f) => s + (f.realizedPnl ?? 0), 0);
    const openCost = open.reduce((s, p) => s + p.costBasis, 0);
    expect(a.startingBalance + realized - (a.cash + openCost)).toBeCloseTo(
      0,
      -Math.log10(tolerance),
    );
    const flows = fills.reduce((s, f) => s + (f.side === "BUY" ? -f.notional : f.notional), 0);
    expect(a.startingBalance + flows - a.cash).toBeCloseTo(0, -Math.log10(tolerance));
  }
}
