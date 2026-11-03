/**
 * Discovery: merge Polymarket leaderboards into a candidate pool, then drop wallets that
 * can't possibly qualify (too few markets, obvious high-frequency bots) using one cheap
 * /v2/user-stats call each.
 */
import { sql } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import { leaderboardSnapshots, traders } from "@/lib/db/schema";
import {
  getLeaderboard,
  getUserStats,
  type LeaderboardCategory,
  type LeaderboardEntry,
  type TimePeriod,
} from "@/lib/polymarket/data";
import type { ScoringConfig } from "@/lib/scoring/config";

import { chunk, mapPool, toDate } from "./util";

export interface DiscoverOptions {
  /** Top-N wallets taken from each leaderboard. */
  perBoard: number;
  /** Cap on candidates kept after pre-filtering (best ranks first). */
  maxCandidates: number;
  timePeriods: TimePeriod[];
  categories: LeaderboardCategory[];
}

export const DEFAULT_DISCOVER: DiscoverOptions = {
  perBoard: 100,
  // ~150 keeps a full run comfortably inside Supabase's free 500 MB.
  maxCandidates: 150,
  timePeriods: ["week", "month", "all"],
  categories: ["overall", "politics", "sports", "crypto", "economics", "tech", "culture"],
};

interface Candidate {
  wallet: string;
  entry: LeaderboardEntry;
  bestRank: number;
  category: string | null;
  categoryRank: number;
}

export async function discoverCandidates(
  db: Db,
  cfg: ScoringConfig,
  opts: DiscoverOptions,
  log: (m: string) => void,
): Promise<{ wallets: string[]; boards: number; seen: number; kept: number }> {
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
        const prev = pool.get(wallet);
        const c: Candidate = prev ?? {
          wallet,
          entry,
          bestRank: entry.rank,
          category: null,
          categoryRank: Infinity,
        };
        c.bestRank = Math.min(c.bestRank, entry.rank);
        if (category !== "overall" && entry.rank < c.categoryRank) {
          c.category = category;
          c.categoryRank = entry.rank;
        }
        pool.set(wallet, c);
      }
    }
  }
  log(`${boards} leaderboards → ${pool.size} unique wallets`);

  for (const part of chunk(snapshots, 1000)) await db.insert(leaderboardSnapshots).values(part);

  // Pre-filter with lifetime stats.
  const candidates = [...pool.values()].sort((a, b) => a.bestRank - b.bestRank);
  const stats = await mapPool(candidates, 6, (c) => getUserStats(c.wallet).catch(() => null));
  const now = Date.now() / 1000;

  const kept: Candidate[] = [];
  const rows: (typeof traders.$inferInsert)[] = [];
  candidates.forEach((c, i) => {
    const s = stats[i];
    const tradeCount = s?.all_time_pnl?.trade_count ?? null;
    const joinDate = s?.join_date ?? null;
    rows.push({
      wallet: c.wallet,
      name: c.entry.user_name || null,
      profileImage: c.entry.profile_image || null,
      xUsername: c.entry.x_username || null,
      verifiedBadge: c.entry.verified ?? false,
      tradeCount,
      joinedAt: toDate(joinDate),
      bestRank: c.bestRank,
      leaderboardCategory: c.category,
    });
    if (!s) return;
    const days = joinDate ? Math.max(1, (now - joinDate) / 86_400) : null;
    const tooFewMarkets = s.trades < cfg.minResolved;
    const isBot = tradeCount !== null && days !== null && tradeCount / days > cfg.maxTradesPerDay;
    if (!tooFewMarkets && !isBot) kept.push(c);
  });

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
          joinedAt: sql`excluded.joined_at`,
          bestRank: sql`excluded.best_rank`,
          leaderboardCategory: sql`coalesce(excluded.leaderboard_category, ${traders.leaderboardCategory})`,
          updatedAt: new Date(),
        },
      });
  }

  const wallets = kept.slice(0, opts.maxCandidates).map((c) => c.wallet);
  log(`pre-filter kept ${kept.length}/${candidates.length}; using top ${wallets.length}`);
  return { wallets, boards, seen: pool.size, kept: wallets.length };
}
