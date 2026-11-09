/**
 * Discovery: build a candidate pool from (1) Polymarket leaderboards and (2) the largest
 * holders of the most active markets (traders who never top a leaderboard), then drop
 * wallets that can't qualify using one cheap /v2/user-stats call each.
 *
 * Leaderboards rank by total dollars won, which favours whales and one big win. So the
 * kept candidates are ordered by a quality score instead: profit per dollar traded, and
 * appearing across several time windows (consistency), not by raw leaderboard rank.
 */
import { sql } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import { hiddenTraders, leaderboardSnapshots, traders } from "@/lib/db/schema";
import {
  getHolders,
  getLeaderboard,
  getUserStats,
  type LeaderboardCategory,
  type TimePeriod,
} from "@/lib/polymarket/data";
import { getTopMarkets } from "@/lib/polymarket/gamma";
import type { ScoringConfig } from "@/lib/scoring/config";

import { chunk, mapPool, toDate } from "./util";

export interface DiscoverOptions {
  /** Top-N wallets taken from each leaderboard. */
  perBoard: number;
  /** Cap on candidates kept after pre-filtering (highest discovery score first). */
  maxCandidates: number;
  timePeriods: TimePeriod[];
  categories: LeaderboardCategory[];
  /** Most-active open markets whose biggest holders are added to the pool. */
  holderMarkets: number;
  holdersPerMarket: number;
}

export const DEFAULT_DISCOVER: DiscoverOptions = {
  perBoard: 300,
  // Daily full checks (re-checks + new wallets). 210 = 120 re-checks + 90 new is approved
  // (owner, 2026-11-09) but held at 150 until production storage is freed and confirmed.
  maxCandidates: 150,
  timePeriods: ["week", "month", "all"],
  categories: ["overall", "politics", "sports", "crypto", "economics", "tech", "culture"],
  holderMarkets: 40,
  holdersPerMarket: 25,
};

interface Candidate {
  wallet: string;
  name: string | null;
  profileImage: string | null;
  xUsername: string | null;
  verified: boolean;
  /** Best leaderboard rank seen; null if found only through market holders. */
  bestRank: number | null;
  category: string | null;
  categoryRank: number;
  /** Distinct leaderboard time windows (week/month/all) the wallet appeared in. */
  periods: Set<string>;
  /** Distinct non-"overall" categories the wallet appeared in. */
  categories: Set<string>;
}

/**
 * Order candidates by quality rather than size (higher = backfill first):
 * up to 3 points for appearing in every time window, up to 1 for breadth across
 * categories, and up to 3 for profit per dollar traded (30%+ earns the maximum).
 */
export function discoveryScore(c: {
  periods: number;
  categories: number;
  efficiency: number;
}): number {
  return (
    Math.min(c.periods, 3) +
    0.25 * Math.min(c.categories, 4) +
    Math.min(3, Math.max(0, c.efficiency / 0.1))
  );
}

const newCandidate = (wallet: string): Candidate => ({
  wallet,
  name: null,
  profileImage: null,
  xUsername: null,
  verified: false,
  bestRank: null,
  category: null,
  categoryRank: Infinity,
  periods: new Set(),
  categories: new Set(),
});

export async function discoverCandidates(
  db: Db,
  cfg: ScoringConfig,
  opts: DiscoverOptions,
  log: (m: string) => void,
): Promise<{
  /** Top `maxCandidates` by quality (the standalone `discover` command). */
  wallets: string[];
  /** Every qualified wallet, best first: the daily rotation picks from this. */
  ranked: string[];
  boards: number;
  seen: number;
  kept: number;
  fromHolders: number;
}> {
  const pool = new Map<string, Candidate>();
  const snapshots: (typeof leaderboardSnapshots.$inferInsert)[] = [];
  let boards = 0;

  for (const timePeriod of opts.timePeriods) {
    for (const category of opts.categories) {
      const res = await getLeaderboard({
        timePeriod,
        category,
        sortBy: "PNL",
        limit: Math.min(1000, opts.perBoard),
      });
      boards++;
      for (const entry of res.data.slice(0, opts.perBoard)) {
        if (entry.pnl <= 0) continue;
        const wallet = entry.user_id.toLowerCase();
        snapshots.push({
          timePeriod,
          category,
          sortBy: "PNL",
          rank: entry.rank,
          wallet,
          pnl: entry.pnl,
          volume: entry.volume,
        });
        const c = pool.get(wallet) ?? newCandidate(wallet);
        c.name ??= entry.user_name || null;
        c.profileImage ??= entry.profile_image || null;
        c.xUsername ??= entry.x_username || null;
        c.verified ||= entry.verified ?? false;
        c.bestRank = Math.min(c.bestRank ?? Infinity, entry.rank);
        c.periods.add(timePeriod);
        if (category !== "overall") {
          c.categories.add(category);
          if (entry.rank < c.categoryRank) {
            c.category = category;
            c.categoryRank = entry.rank;
          }
        }
        pool.set(wallet, c);
      }
    }
  }
  log(`${boards} leaderboards → ${pool.size} unique wallets`);

  // Biggest holders of today's most active markets: finds steady traders who never
  // reach a leaderboard. Failures here are non-fatal (leaderboards are enough to run).
  let fromHolders = 0;
  try {
    const top = await getTopMarkets(opts.holderMarkets);
    for (const part of chunk(
      top.map((m) => m.conditionId),
      20,
    )) {
      for (const h of await getHolders(part, opts.holdersPerMarket)) {
        const wallet = h.proxy_wallet.toLowerCase();
        if (!pool.has(wallet)) {
          fromHolders++;
          pool.set(wallet, {
            ...newCandidate(wallet),
            name: h.name || null,
            profileImage: h.profile_image || null,
            verified: h.verified ?? false,
          });
        }
      }
    }
    log(`market holders added ${fromHolders} wallets not on any leaderboard`);
  } catch (err) {
    log(`holder discovery skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const part of chunk(snapshots, 1000)) await db.insert(leaderboardSnapshots).values(part);

  // Traders the admin hid can't be copied: don't spend a candidate slot on them. (They stay
  // in the leaderboard snapshots above, which record the board as it was.)
  const hidden = new Set(
    (await db.select({ w: hiddenTraders.wallet }).from(hiddenTraders)).map((r) => r.w),
  );

  // Pre-filter with lifetime stats.
  const candidates = [...pool.values()].filter((c) => !hidden.has(c.wallet));
  let statsFailed = 0;
  const stats = await mapPool(candidates, 6, (c) =>
    getUserStats(c.wallet).catch(() => {
      statsFailed++;
      return null;
    }),
  );
  // An outage, not a pool of unqualified wallets: fail rather than report 0 candidates.
  if (candidates.length > 0 && statsFailed === candidates.length) {
    throw new Error(`user-stats failed for all ${candidates.length} candidates`);
  }
  const now = Date.now() / 1000;

  const kept: Array<{ c: Candidate; score: number }> = [];
  const rows: (typeof traders.$inferInsert)[] = [];
  let losers = 0;
  candidates.forEach((c, i) => {
    const s = stats[i];
    const tradeCount = s?.all_time_pnl?.trade_count ?? null;
    const joinDate = s?.join_date ?? null;
    if (!s) return;
    const days = joinDate ? Math.max(1, (now - joinDate) / 86_400) : null;
    const tooFewMarkets = s.trades < cfg.minResolved;
    const isBot = tradeCount !== null && days !== null && tradeCount / days > cfg.maxTradesPerDay;
    const realized = s.all_time_pnl?.realized_pnl ?? 0;
    const volume = s.all_time_pnl?.volume_usdc ?? 0;
    // Lifetime losers can't pass the profit checks; don't let them take a slot.
    if (realized <= 0) losers++;
    if (tooFewMarkets || isBot || realized <= 0) return;

    rows.push({
      wallet: c.wallet,
      name: c.name,
      profileImage: c.profileImage,
      xUsername: c.xUsername,
      verifiedBadge: c.verified,
      tradeCount,
      marketsTraded: s.trades,
      joinedAt: toDate(joinDate),
      bestRank: c.bestRank,
      leaderboardCategory: c.category,
    });
    kept.push({
      c,
      score: discoveryScore({
        periods: c.periods.size,
        categories: c.categories.size,
        efficiency: volume > 0 ? realized / volume : 0,
      }),
    });
  });
  kept.sort((a, b) => b.score - a.score);
  log(`dropped ${losers} lifetime-losing wallets`);

  for (const part of chunk(rows, 500)) {
    await db
      .insert(traders)
      .values(part)
      .onConflictDoUpdate({
        target: traders.wallet,
        set: {
          name: sql`excluded.name`,
          profileImage: sql`excluded.profile_image`,
          xUsername: sql`excluded.x_username`,
          verifiedBadge: sql`excluded.verified_badge`,
          tradeCount: sql`excluded.trade_count`,
          marketsTraded: sql`excluded.markets_traded`,
          joinedAt: sql`excluded.joined_at`,
          bestRank: sql`excluded.best_rank`,
          leaderboardCategory: sql`coalesce(excluded.leaderboard_category, ${traders.leaderboardCategory})`,
          updatedAt: new Date(),
        },
      });
  }

  const wallets = kept.slice(0, opts.maxCandidates).map((k) => k.c.wallet);
  log(
    `pre-filter kept ${kept.length}/${candidates.length}; using top ${wallets.length} by quality`,
  );
  const ranked = kept.map((k) => k.c.wallet);
  return { wallets, ranked, boards, seen: pool.size, kept: wallets.length, fromHolders };
}
