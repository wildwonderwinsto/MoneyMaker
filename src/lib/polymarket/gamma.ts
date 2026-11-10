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
  /** Sports: when the game starts ("2026-11-10 17:25:00+00"); = the event's startTime. */
  gameStartTime: z.string().nullish(),
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

/** Gamma's timestamps come as "2026-11-10 17:25:00+00" or ISO; null if absent/unreadable. */
export function gammaTime(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(
    s
      .trim()
      .replace(" ", "T")
      .replace(/([+-]\d\d)$/, "$1:00"),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A combo (parlay) bet: one token for several markets at once. Verified live 2026-11-10: such
 * trades carry a synthetic condition id padded with zeros, unknown to Gamma, with no order
 * book or price history, so they can't be copied or replayed.
 */
export function isComboCondition(conditionId: string): boolean {
  return /0{20,}$/.test(conditionId);
}

const KeysetResponse = z.object({
  markets: z.array(GammaMarket),
  next_cursor: z.string().nullish(),
});

const CHUNK = 50;

/** Fetch markets (open and closed) for a list of condition ids. */
export async function getMarketsByConditionIds(conditionIds: string[]): Promise<GammaMarket[]> {
  // An empty id makes Gamma reject the whole request (HTTP 422).
  const unique = [...new Set(conditionIds.filter(Boolean))];
  // Keyed by id: a market that closes between the two requests comes back in both (one
  // upsert can't touch a row twice). The closed answer is pushed last, so it wins.
  const out = new Map<string, GammaMarket>();
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
    for (const res of pages) for (const m of res.markets) out.set(m.conditionId, m);
  }
  return [...out.values()];
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

/**
 * Payout per share for each outcome once a market is settled, else null: [1, 0] or [0, 1]
 * for a winner, [0.5, 0.5] when the oracle resolves it 50/50 (ambiguous or cancelled;
 * docs.polymarket.com/concepts/resolution). A 50/50 needs a resolved oracle status: an
 * untraded market also shows 0.5/0.5 before it resolves.
 */
export function resolvedPayouts(
  m: Pick<GammaMarket, "closed" | "outcomePrices" | "umaResolutionStatus">,
): number[] | null {
  const winner = winnerIndex(m);
  if (winner !== null) return m.outcomePrices.map((_, i) => (i === winner ? 1 : 0));
  const split =
    !!m.closed &&
    m.outcomePrices.length === 2 &&
    m.outcomePrices.every((p) => Number(p) === 0.5) &&
    (m.umaResolutionStatus === "resolved" || m.umaResolutionStatus === "settled");
  return split ? [0.5, 0.5] : null;
}

// ---------------------------------------------------------------------------
// Events & categories
// ---------------------------------------------------------------------------

export interface GammaEvent {
  id: string;
  slug?: string | null;
  title?: string | null;
  image?: string | null;
  tags?: Array<{ slug?: string | null; label?: string | null }> | null;
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
