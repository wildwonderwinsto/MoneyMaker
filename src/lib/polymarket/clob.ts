/**
 * Polymarket CLOB public endpoints: order books, midpoints, price history.
 * The raw book lists bids ascending and asks descending (best price LAST);
 * `getBook` normalizes to best-first so callers never depend on API ordering.
 */
import { z } from "zod";

import { buildUrl, fetchJson, RateLimiter } from "@/lib/http";

export const CLOB_API = "https://clob.polymarket.com";
export const clobLimiter = new RateLimiter(6, 60);

const decimal = z.union([z.string(), z.number()]).transform((v) => Number(v));

const Level = z.object({ price: decimal, size: decimal });
export type BookLevel = { price: number; size: number };

const RawBook = z.object({
  market: z.string().nullish(),
  asset_id: z.string(),
  timestamp: z.string().nullish(),
  bids: z.array(Level),
  asks: z.array(Level),
  min_order_size: decimal.nullish(),
  tick_size: decimal.nullish(),
  neg_risk: z.boolean().nullish(),
  last_trade_price: decimal.nullish(),
});

export interface OrderBook {
  tokenId: string;
  /** Highest price first. */
  bids: BookLevel[];
  /** Lowest price first. */
  asks: BookLevel[];
  tickSize: number;
  minOrderSize: number;
  timestamp: number;
}

export function normalizeBook(raw: z.infer<typeof RawBook>): OrderBook {
  const clean = (levels: BookLevel[]) =>
    levels.filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0);
  return {
    tokenId: raw.asset_id,
    bids: clean(raw.bids).sort((a, b) => b.price - a.price),
    asks: clean(raw.asks).sort((a, b) => a.price - b.price),
    tickSize: raw.tick_size ?? 0.01,
    minOrderSize: raw.min_order_size ?? 0,
    timestamp: raw.timestamp ? Number(raw.timestamp) : Date.now(),
  };
}

export async function getBook(tokenId: string): Promise<OrderBook> {
  const raw = await fetchJson(buildUrl(CLOB_API, "/book", { token_id: tokenId }), {
    schema: RawBook,
    limiter: clobLimiter,
  });
  const book = normalizeBook(raw);
  rememberBook(book);
  return book;
}

/**
 * The last book fetched per token (by the engine or an admin), so pages a visitor opens can
 * show prices without making Polymarket requests themselves (UI-17). In-process: the engine
 * runs in the same server. Bounded: the oldest entries go first.
 */
const bookCache = new Map<string, { book: OrderBook; at: number }>();
const BOOK_CACHE_MAX = 2000;

export function rememberBook(book: OrderBook, at = Date.now()): void {
  bookCache.delete(book.tokenId);
  bookCache.set(book.tokenId, { book, at });
  if (bookCache.size > BOOK_CACHE_MAX) bookCache.delete(bookCache.keys().next().value!);
}

/** A book fetched within `maxAgeMs`, or null. Never makes a request. */
export function getCachedBook(tokenId: string, maxAgeMs: number, now = Date.now()) {
  const hit = bookCache.get(tokenId);
  return hit && now - hit.at <= maxAgeMs ? hit : null;
}

/** Midpoint prices for many tokens in one request (POST body: [{token_id}]). */
export async function getMidpoints(tokenIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(tokenIds)];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const res = await fetchJson(`${CLOB_API}/midpoints`, {
      schema: z.record(z.string(), decimal),
      limiter: clobLimiter,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(chunk.map((token_id) => ({ token_id }))),
      },
    });
    for (const [token, mid] of Object.entries(res)) {
      if (Number.isFinite(mid)) out.set(token, mid);
    }
  }
  return out;
}

export interface PricePoint {
  /** Epoch seconds. */
  t: number;
  p: number;
}

/** Price history for a token. `fidelity` is the bucket size in minutes. */
export async function getPriceHistory(
  tokenId: string,
  opts: { startTs?: number; endTs?: number; interval?: string; fidelity?: number },
): Promise<PricePoint[]> {
  const res = await fetchJson(
    buildUrl(CLOB_API, "/prices-history", {
      market: tokenId,
      startTs: opts.startTs,
      endTs: opts.endTs,
      interval: opts.startTs === undefined ? (opts.interval ?? "max") : undefined,
      fidelity: opts.fidelity ?? 1,
    }),
    {
      schema: z.object({ history: z.array(z.object({ t: z.number(), p: z.number() })) }),
      limiter: clobLimiter,
    },
  );
  return res.history;
}

/** First observed price at or after `ts` (seconds), or null if none. */
export function priceAtOrAfter(history: PricePoint[], ts: number): number | null {
  let lo = 0;
  let hi = history.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (history[mid].t < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo < history.length ? history[lo].p : null;
}
