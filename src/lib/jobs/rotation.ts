/**
 * Discovery rotation (owner decision 2026-11-08, design #3): which wallets get one of the
 * daily full checks.
 *
 * 1. Re-checks, in priority order, up to `recheckCap`: followed traders (never dropped, even
 *    past the cap) → Verified/Elite → Candidates not checked for a week (oldest check
 *    first) → Watchlist.
 * 2. The rest of the `slots` go to the best-ranked wallets from today's discovery that
 *    haven't been checked, or whose 30-day cool-down ended, or who traded at least
 *    `earlyReturnMarkets` new markets since their last check (a fresh sample that could
 *    change the verdict). A wallet picked here that was checked before is re-selected: its
 *    holdout restarts today (audit R3), so the bets that got it re-picked aren't its test.
 */
import { desc, eq, inArray } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import { follows, hiddenTraders, traders, traderScores } from "@/lib/db/schema";

export interface RotationOptions {
  slots: number;
  recheckCap: number;
  cooldownDays: number;
  /** Candidates are re-checked this often (they need time to place post-pick bets). */
  candidateEveryDays: number;
  /** New markets traded since the last check that end a cool-down early. */
  earlyReturnMarkets: number;
}

/**
 * Owner-approved values; `earlyReturnMarkets` is the scoring config's `minResolved`. 120
 * re-checks in 210 slots (owner, 2026-11-09): under the sequential skill test ~2,000
 * Candidates wait at steady state (sim), so even 120 re-checks a day means one about every
 * 2.5 weeks; 60 would be every ~5 weeks.
 */
export const DEFAULT_ROTATION: Omit<RotationOptions, "earlyReturnMarkets"> = {
  slots: 210,
  recheckCap: 120,
  cooldownDays: 30,
  candidateEveryDays: 7,
};

const DAY_MS = 86_400_000;

export async function pickDailyWallets(
  db: Db,
  ranked: string[],
  opts: RotationOptions,
  now = new Date(),
): Promise<{
  wallets: string[];
  followed: number;
  recheck: number;
  fresh: number;
  returning: number;
}> {
  const hidden = new Set(
    (await db.select({ w: hiddenTraders.wallet }).from(hiddenTraders)).map((r) => r.w),
  );
  // Copying only; paused follows don't need a daily check.
  const followed = (
    await db.select({ w: follows.wallet }).from(follows).where(eq(follows.enabled, true))
  )
    .map((r) => r.w)
    .filter((w) => !hidden.has(w));

  const scored = await db
    .select({ w: traderScores.wallet, tier: traderScores.tier, checked: traders.lastCheckedAt })
    .from(traderScores)
    .leftJoin(traders, eq(traders.wallet, traderScores.wallet))
    .where(inArray(traderScores.tier, ["elite", "verified", "watchlist", "candidate"]))
    .orderBy(desc(traderScores.score));
  const candidateDue = now.getTime() - opts.candidateEveryDays * DAY_MS;
  const byTier = (tiers: string[]) =>
    scored.filter((r) => tiers.includes(r.tier) && !hidden.has(r.w)).map((r) => r.w);
  const dueCandidates = scored
    .filter(
      (r) =>
        r.tier === "candidate" &&
        !hidden.has(r.w) &&
        (r.checked === null || r.checked.getTime() <= candidateDue),
    )
    // Oldest check first: in score order low-scored Candidates would wait out their whole
    // candidacy without a re-check.
    .sort((a, b) => (a.checked?.getTime() ?? 0) - (b.checked?.getTime() ?? 0))
    .map((r) => r.w);

  const picked: string[] = [];
  const take = (w: string) => {
    if (!picked.includes(w)) picked.push(w);
  };
  followed.forEach(take);
  // Candidates before Watchlist (owner, 2026-11-08): a large Watchlist would otherwise take
  // every slot and Candidates would never collect their post-pick bets' verdict.
  for (const w of [...byTier(["elite", "verified"]), ...dueCandidates, ...byTier(["watchlist"])]) {
    if (picked.length >= opts.recheckCap) break;
    take(w);
  }
  const recheck = picked.length;

  // New wallets, best-ranked first.
  const known = new Map(
    (ranked.length
      ? await db
          .select({
            w: traders.wallet,
            checked: traders.lastCheckedAt,
            markets: traders.marketsTraded,
            atCheck: traders.marketsAtCheck,
          })
          .from(traders)
          .where(inArray(traders.wallet, ranked))
      : []
    ).map((r) => [r.w, r]),
  );
  const cooled = now.getTime() - opts.cooldownDays * DAY_MS;
  const returning: string[] = [];
  for (const w of ranked) {
    if (picked.length >= opts.slots) break;
    if (hidden.has(w) || picked.includes(w)) continue;
    const t = known.get(w);
    const eligible =
      !t?.checked ||
      t.checked.getTime() < cooled ||
      (t.markets ?? 0) - (t.atCheck ?? t.markets ?? 0) >= opts.earlyReturnMarkets;
    if (eligible) {
      take(w);
      if (t?.checked) returning.push(w);
    }
  }
  for (let i = 0; i < returning.length; i += 500) {
    await db
      .update(traders)
      .set({ holdoutFrom: now })
      .where(inArray(traders.wallet, returning.slice(i, i + 500)));
  }
  return {
    wallets: picked,
    followed: followed.length,
    recheck,
    fresh: picked.length - recheck,
    returning: returning.length,
  };
}
