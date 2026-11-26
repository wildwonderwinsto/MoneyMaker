/**
 * Polymarket lookups for personal bets: market search, the market behind a bet, and the
 * prices / resolutions that keep open bets up to date. Verified live (Nov 2026):
 * `/public-search?q=` returns events with their markets inlined (token ids, fees included);
 * `/events/slug/{slug}` returns one event the same way, 404 when the slug is unknown.
 */
import "server-only";

import { z } from "zod";

import {
  listPortfolios,
  openBets,
  refreshBets,
  snapshot,
  type MarketData,
} from "@/lib/custom/bets";
import type { Db } from "@/lib/db/client";
import { getMidpoints } from "@/lib/polymarket/clob";
import {
  GAMMA_API,
  GammaMarket,
  gammaLimiter,
  getMarketsByConditionIds,
  resolvedPayouts,
  takerFeeRate,
} from "@/lib/polymarket/gamma";
import { buildUrl, fetchJson, HttpError } from "@/lib/http";

const SearchMarket = GammaMarket.extend({
  /** Short label inside a multi-market event, e.g. "↑ 100,000". */
  groupItemTitle: z.string().nullish(),
  acceptingOrders: z.boolean().nullish(),
});

const SearchEvent = z.object({
  id: z.string(),
  slug: z.string().nullish(),
  title: z.string().nullish(),
  image: z.string().nullish(),
  endDate: z.string().nullish(),
  volume24hr: z.number().nullish(),
  markets: z.array(SearchMarket).nullish(),
});
type SearchEvent = z.infer<typeof SearchEvent>;

export interface SearchOutcome {
  index: number;
  label: string;
  tokenId: string;
  /** Last Gamma price (roughly the midpoint); the fill uses the live book. */
  price: number | null;
}

export interface SearchResultMarket {
  conditionId: string;
  question: string;
  label: string | null;
  slug: string | null;
  image: string | null;
  endDate: string | null;
  outcomes: SearchOutcome[];
}

export interface SearchResultEvent {
  id: string;
  title: string;
  slug: string | null;
  image: string | null;
  markets: SearchResultMarket[];
}

const tradable = (m: z.infer<typeof SearchMarket>) =>
  !m.closed &&
  m.active !== false &&
  m.acceptingOrders !== false &&
  m.clobTokenIds.length > 0 &&
  m.clobTokenIds.length === m.outcomes.length;

function toResult(e: SearchEvent, onlyMarketSlug?: string): SearchResultEvent | null {
  const markets = (e.markets ?? [])
    .filter(tradable)
    .filter((m) => !onlyMarketSlug || m.slug === onlyMarketSlug)
    .map((m) => ({
      conditionId: m.conditionId,
      question: m.question,
      label: m.groupItemTitle || null,
      slug: m.slug ?? null,
      image: m.image ?? m.icon ?? null,
      endDate: m.endDate ?? null,
      outcomes: m.outcomes.map((label, index) => {
        const p = Number(m.outcomePrices[index]);
        return {
          index,
          label,
          tokenId: m.clobTokenIds[index],
          price: Number.isFinite(p) ? p : null,
        };
      }),
    }))
    // Multi-market events (e.g. price ladders): likeliest first.
    .sort((a, b) => (b.outcomes[0]?.price ?? 0) - (a.outcomes[0]?.price ?? 0));
  if (markets.length === 0) return null;
  return {
    id: e.id,
    title: e.title ?? markets[0].question,
    slug: e.slug ?? null,
    image: e.image ?? markets[0].image,
    markets,
  };
}

/** `polymarket.com/event/<event>[/<market>]` or `/market/<market>` → slugs, else null. */
export function parsePolymarketUrl(q: string): { event?: string; market?: string } | null {
  const m = q
    .trim()
    .match(/polymarket\.com\/(?:[a-z]{2}\/)?(event|market)\/([\w-]+)(?:\/([\w-]+))?/i);
  if (!m) return null;
  return m[1].toLowerCase() === "event" ? { event: m[2], market: m[3] } : { market: m[2] };
}

async function eventBySlug(slug: string): Promise<SearchEvent | null> {
  try {
    return await fetchJson(buildUrl(GAMMA_API, `/events/slug/${encodeURIComponent(slug)}`), {
      schema: SearchEvent,
      limiter: gammaLimiter,
      retries: 1,
    });
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 422)) return null;
    throw err;
  }
}

/** Open markets matching a search, or the event behind a pasted Polymarket link. */
export async function searchMarkets(query: string): Promise<SearchResultEvent[]> {
  const q = query.trim().slice(0, 200);
  if (!q) return [];
  const link = parsePolymarketUrl(q);
  if (link?.event) {
    const e = await eventBySlug(link.event);
    const r = e && (toResult(e, link.market) ?? toResult(e));
    if (r) return [r];
  }
  const res = await fetchJson(
    buildUrl(GAMMA_API, "/public-search", {
      q: link?.market ? link.market.replace(/-/g, " ") : q,
      limit_per_type: 12,
      events_status: "active",
      search_profiles: false,
      search_tags: false,
    }),
    {
      schema: z.object({ events: z.array(SearchEvent).nullish() }),
      limiter: gammaLimiter,
      retries: 1,
    },
  );
  return (res.events ?? []).map((e) => toResult(e)).filter((e) => e !== null);
}

/** The market a bet is placed on, checked live (still open, outcome exists). */
export async function lookupBetMarket(conditionId: string, outcomeIndex: number) {
  const [m] = await getMarketsByConditionIds([conditionId]);
  if (!m) throw new Error("Market not found on Polymarket");
  if (m.closed) throw new Error("This market has closed");
  const tokenId = m.clobTokenIds[outcomeIndex];
  const outcome = m.outcomes[outcomeIndex];
  if (!tokenId || !outcome) throw new Error("Unknown outcome");
  const event = m.events?.[0];
  return {
    conditionId: m.conditionId,
    tokenId,
    outcomeIndex,
    outcome,
    title: m.question,
    slug: m.slug ?? null,
    eventSlug: event?.slug ?? null,
    image: m.image ?? m.icon ?? null,
    feeRate: takerFeeRate(m),
  };
}

/** Midpoints and resolutions for the open bets' markets. */
export async function fetchMarketData(
  bets: Array<{ conditionId: string; tokenId: string }>,
): Promise<MarketData> {
  if (bets.length === 0) return { mids: new Map(), payouts: new Map() };
  const [markets, mids] = await Promise.all([
    getMarketsByConditionIds(bets.map((b) => b.conditionId)),
    // A resolved market's book is gone (the request fails); settlement doesn't need it.
    getMidpoints(bets.map((b) => b.tokenId)).catch(() => new Map<string, number>()),
  ]);
  const payouts = new Map<string, number[]>();
  for (const m of markets) {
    const p = resolvedPayouts(m);
    if (p) payouts.set(m.conditionId, p);
  }
  return { mids, payouts };
}

const SYNC_EVERY_MS = 30_000;
let lastSync = 0;

/**
 * Settle resolved bets, mark open ones at the midpoint and snapshot equity, at most every
 * 30 seconds (pages auto-refresh). Failures leave the last prices in place.
 */
export async function syncBets(db: Db, { force = false } = {}): Promise<void> {
  if (!force && Date.now() - lastSync < SYNC_EVERY_MS) return;
  lastSync = Date.now();
  try {
    const open = await openBets(db);
    if (open.length > 0) await refreshBets(db, open, await fetchMarketData(open));
    for (const p of await listPortfolios(db)) await snapshot(db, p.id);
  } catch (err) {
    console.warn("[personal bets] sync failed:", err instanceof Error ? err.message : err);
  }
}
