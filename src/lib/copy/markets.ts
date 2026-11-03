import { inArray, sql } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import { markets } from "@/lib/db/schema";
import { getMarketsByConditionIds, winnerIndex } from "@/lib/polymarket/gamma";

import type { MarketInfo } from "./engine";

type MarketRow = typeof markets.$inferSelect;

const toInfo = (m: MarketRow): MarketInfo => ({
  conditionId: m.conditionId,
  question: m.question,
  slug: m.slug,
  image: m.image,
  endDate: m.endDate,
  closed: m.closed,
  tokenIds: m.tokenIds,
  outcomes: m.outcomes,
  winnerIndex: m.winnerIndex,
});

/**
 * Market info with a DB cache. Rows older than `maxAgeMs` (or unresolved markets past
 * their end date) are refreshed from Gamma; resolved markets never change.
 */
export async function getMarketInfo(
  db: Db,
  conditionIds: string[],
  maxAgeMs = 10 * 60_000,
): Promise<Map<string, MarketInfo>> {
  const ids = [...new Set(conditionIds)];
  const out = new Map<string, MarketInfo>();
  if (ids.length === 0) return out;

  const cached = await db.select().from(markets).where(inArray(markets.conditionId, ids));
  const now = Date.now();
  const stale: string[] = [];
  const cachedById = new Map(cached.map((m) => [m.conditionId, m]));
  for (const id of ids) {
    const row = cachedById.get(id);
    const fresh = row && (row.winnerIndex !== null || now - row.updatedAt.getTime() < maxAgeMs);
    if (row && fresh) out.set(id, toInfo(row));
    else stale.push(id);
  }
  if (stale.length === 0) return out;

  const fetched = await getMarketsByConditionIds(stale);
  if (fetched.length === 0) return out;
  const rows = fetched.map((m) => {
    const winner = winnerIndex(m);
    return {
      conditionId: m.conditionId,
      question: m.question,
      slug: m.slug ?? null,
      eventId: m.events?.[0]?.id ?? null,
      eventSlug: m.events?.[0]?.slug ?? null,
      image: m.image ?? m.icon ?? null,
      endDate: m.endDate ? new Date(m.endDate) : null,
      closed: m.closed ?? false,
      outcomes: m.outcomes,
      tokenIds: m.clobTokenIds,
      winnerIndex: winner,
      resolvedAt: winner === null ? null : new Date(),
      updatedAt: new Date(),
    };
  });
  const saved = await db
    .insert(markets)
    .values(rows)
    .onConflictDoUpdate({
      target: markets.conditionId,
      set: {
        question: sql`excluded.question`,
        image: sql`excluded.image`,
        endDate: sql`excluded.end_date`,
        closed: sql`excluded.closed`,
        outcomes: sql`excluded.outcomes`,
        tokenIds: sql`excluded.token_ids`,
        winnerIndex: sql`excluded.winner_index`,
        resolvedAt: sql`coalesce(${markets.resolvedAt}, excluded.resolved_at)`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .returning();
  for (const m of saved) out.set(m.conditionId, toInfo(m));
  return out;
}
