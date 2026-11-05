/**
 * Polymarket Gamma API client (market & event metadata, resolution, public profiles).
 * Notes verified against the live API (Nov 2026):
 * - `/markets/keyset` returns only OPEN markets unless `closed=true` is passed.
 * - `condition_ids` must be repeated per id (comma-joined returns nothing).
 * - `outcomes`, `outcomePrices`, `clobTokenIds` are JSON-encoded string arrays.
 * - `category` is usually null; categories come from the parent event's tags.
 */
import { z } from "zod";

import { buildUrl, fetchJson, RateLimiter } from "@/lib/http";

export const GAMMA_API = "https://gamma-api.polymarket.com";
export const gammaLimiter = new RateLimiter(4, 100);

const jsonStringArray = z
  .string()
  .nullish()
  .transform((s): string[] => {
    if (!s) return [];
    try {
      const v: unknown = JSON.parse(s);
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  });

export const GammaMarket = z.object({
  id: z.string(),
  question: z.string(),
  conditionId: z.string(),
  slug: z.string().nullish(),
  image: z.string().nullish(),
  icon: z.string().nullish(),
  endDate: z.string().nullish(),
  closed: z.boolean().nullish(),
  active: z.boolean().nullish(),
  umaResolutionStatus: z.string().nullish(),
  closedTime: z.string().nullish(),
  outcomes: jsonStringArray,
  outcomePrices: jsonStringArray,
  clobTokenIds: jsonStringArray,
  negRisk: z.boolean().nullish(),
  bestBid: z.number().nullish(),
  bestAsk: z.number().nullish(),
  lastTradePrice: z.number().nullish(),
  /** Taker fees (docs.polymarket.com/trading/fees). Absent or false = fee-free market. */
  feesEnabled: z.boolean().nullish(),
  feeSchedule: z.object({ rate: z.number().nullish(), exponent: z.number().nullish() }).nullish(),
  events: z
    .array(z.object({ id: z.string(), slug: z.string().nullish(), title: z.string().nullish() }))
    .nullish(),
});
export type GammaMarket = z.infer<typeof GammaMarket>;

const KeysetResponse = z.object({
  markets: z.array(GammaMarket),
  next_cursor: z.string().nullish(),
});

const CHUNK = 50;

/** Fetch markets (open and closed) for a list of condition ids. */
export async function getMarketsByConditionIds(conditionIds: string[]): Promise<GammaMarket[]> {
  // An empty id makes Gamma reject the whole request (HTTP 422).
  const unique = [...new Set(conditionIds.filter(Boolean))];
  const out: GammaMarket[] = [];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const ids = unique.slice(i, i + CHUNK);
    // Open and closed markets need separate requests; run them together (copy speed).
    const pages = await Promise.all(
      [false, true].map((closed) =>
        fetchJson(
          buildUrl(GAMMA_API, "/markets/keyset", { condition_ids: ids, closed, limit: 100 }),
          {
            schema: KeysetResponse,
            limiter: gammaLimiter,
          },
        ),
      ),
    );
    for (const res of pages) out.push(...res.markets);
  }
  return out;
}

/**
 * Winner index once a market is closed and settled ("1" in outcomePrices), else null.
 * Unresolved or disputed markets (no outcome priced at 1) return null.
 */
export function winnerIndex(m: Pick<GammaMarket, "closed" | "outcomePrices">): number | null {
  if (!m.closed) return null;
  const idx = m.outcomePrices.findIndex((p) => Number(p) === 1);
  return idx >= 0 ? idx : null;
}

/** Polymarket's default taker rate ("Other / General"), used if a fee market omits its rate. */
export const DEFAULT_TAKER_FEE_RATE = 0.05;

/**
 * Taker fee rate for a market: fee = shares × rate × p × (1 − p), in USDC, paid by takers
 * only (copies always take). Rates by category: crypto 0.07, sports/economics/culture/
 * weather 0.05, politics/finance/tech/mentions 0.04, geopolitics 0. Verified live (Nov
 * 2026): every schedule has exponent 1, and markets without one have feesEnabled false.
 */
export function takerFeeRate(m: Pick<GammaMarket, "feesEnabled" | "feeSchedule">): number {
  if (!m.feesEnabled) return 0;
  return m.feeSchedule?.rate ?? DEFAULT_TAKER_FEE_RATE;
}

// ---------------------------------------------------------------------------
// Events & categories
// ---------------------------------------------------------------------------

const GammaEvent = z.object({
  id: z.string(),
  slug: z.string().nullish(),
  title: z.string().nullish(),
  image: z.string().nullish(),
  tags: z.array(z.object({ slug: z.string().nullish(), label: z.string().nullish() })).nullish(),
});
export type GammaEvent = z.infer<typeof GammaEvent>;

export async function getEvent(id: string): Promise<GammaEvent> {
  return fetchJson(buildUrl(GAMMA_API, `/events/${encodeURIComponent(id)}`), {
    schema: GammaEvent,
    limiter: gammaLimiter,
  });
}

/** Top-level categories in priority order (first tag match wins). */
const CATEGORY_TAGS: Array<[category: string, tags: string[]]> = [
  ["sports", ["sports", "nfl", "nba", "mlb", "nhl", "soccer", "tennis", "golf", "mma", "ufc"]],
  ["esports", ["esports"]],
  ["crypto", ["crypto", "bitcoin", "ethereum", "solana", "crypto-prices"]],
  ["politics", ["politics", "elections", "us-politics", "midterms"]],
  ["geopolitics", ["geopolitics", "world", "middle-east", "ukraine"]],
  ["economics", ["economy", "economics", "fed", "inflation"]],
  ["finance", ["finance", "stocks", "business", "earnings"]],
  ["tech", ["tech", "ai", "science"]],
  ["weather", ["weather", "climate"]],
  ["culture", ["culture", "pop-culture", "movies", "music", "awards", "celebrities"]],
  ["mentions", ["mentions"]],
];

export function categoryFromTags(tags: GammaEvent["tags"]): string | null {
  const slugs = new Set((tags ?? []).map((t) => t.slug?.toLowerCase()).filter(Boolean));
  for (const [category, candidates] of CATEGORY_TAGS) {
    if (candidates.some((c) => slugs.has(c))) return category;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public profile
// ---------------------------------------------------------------------------

const PublicProfile = z.object({
  proxyWallet: z.string().nullish(),
  name: z.string().nullish(),
  pseudonym: z.string().nullish(),
  bio: z.string().nullish(),
  profileImage: z.string().nullish(),
  xUsername: z.string().nullish(),
  verifiedBadge: z.boolean().nullish(),
  createdAt: z.string().nullish(),
});
export type PublicProfile = z.infer<typeof PublicProfile>;

export async function getPublicProfile(address: string): Promise<PublicProfile> {
  return fetchJson(buildUrl(GAMMA_API, "/public-profile", { address }), {
    schema: PublicProfile,
    limiter: gammaLimiter,
  });
}

/** Open markets with the most trading volume in the last 24 hours. */
export async function getTopMarkets(limit = 40): Promise<GammaMarket[]> {
  const url = buildUrl(GAMMA_API, "/markets/keyset", {
    closed: false,
    order: "volume24hr",
    ascending: false,
    limit: Math.min(100, limit),
  });
  const res = await fetchJson(url, { schema: KeysetResponse, limiter: gammaLimiter });
  return res.markets;
}
