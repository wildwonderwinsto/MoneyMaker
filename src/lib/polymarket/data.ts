/**
 * Polymarket Data API v2 client (public, no auth). https://docs.polymarket.com
 * v1 was retired on 2026-11-02; every route here is under /v2.
 * Shapes are validated with Zod; unknown fields are stripped.
 */
import { z } from "zod";

import { buildUrl, fetchJson, RateLimiter, type Query } from "@/lib/http";

export const DATA_API = "https://data-api.polymarket.com";

// Conservative: ~8 req/s with 4 in flight.
export const dataLimiter = new RateLimiter(4, 125);

const str = z.string().nullish();
const num = z.number().nullish();

const Pagination = z.object({
  has_more: z.boolean().optional().default(false),
  next_cursor: z.string().nullish(),
});

const page = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), pagination: Pagination });

export type Page<T> = { data: T[]; pagination: z.infer<typeof Pagination> };

async function get<S extends z.ZodType>(path: string, query: Query, schema: S) {
  return fetchJson(buildUrl(DATA_API, path, query), { schema, limiter: dataLimiter });
}

/** Iterate every item across cursor pages. `maxItems` bounds work for very active wallets. */
export async function* paginate<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  { maxItems = Infinity }: { maxItems?: number } = {},
): AsyncGenerator<T> {
  let cursor: string | undefined;
  let seen = 0;
  for (;;) {
    const res = await fetchPage(cursor);
    for (const item of res.data) {
      yield item;
      if (++seen >= maxItems) return;
    }
    if (!res.pagination.has_more || !res.pagination.next_cursor) return;
    cursor = res.pagination.next_cursor;
  }
}

export async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export const LEADERBOARD_CATEGORIES = [
  "overall",
  "politics",
  "sports",
  "crypto",
  "economics",
  "finance",
  "tech",
  "culture",
  "geopolitics",
  "weather",
  "mentions",
  "esports",
] as const;
export type LeaderboardCategory = (typeof LEADERBOARD_CATEGORIES)[number];
export type TimePeriod = "day" | "week" | "month" | "all";
export type LeaderboardSort = "PNL" | "VOLUME";

export const LeaderboardEntry = z.object({
  rank: z.number(),
  user_id: z.string(),
  pnl: z.number(),
  volume: z.number(),
  user_name: str,
  profile_image: str,
  x_username: str,
  verified: z.boolean().nullish(),
});
export type LeaderboardEntry = z.infer<typeof LeaderboardEntry>;

export function getLeaderboard(params: {
  timePeriod?: TimePeriod;
  category?: LeaderboardCategory;
  sortBy?: LeaderboardSort;
  limit?: number;
  cursor?: string;
}): Promise<Page<LeaderboardEntry>> {
  return get(
    "/v2/leaderboard",
    {
      time_period: params.timePeriod,
      category: params.category,
      sort_by: params.sortBy,
      limit: params.limit,
      cursor: params.cursor,
    },
    page(LeaderboardEntry),
  );
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export type PositionStatus = "OPEN" | "CLOSED" | "REDEEMABLE" | "REDEEMABLE_LOST" | "MERGEABLE";

export const Position = z.object({
  proxy_wallet: z.string(),
  token_id: z.string(),
  condition_id: z.string(),
  current_size: z.number(),
  avg_price: z.number(),
  /** Total shares ever acquired in this position. */
  total_size: num,
  total_cost_usdc: num,
  current_price: num,
  current_value: num,
  realized_pnl: z.number(),
  unrealized_pnl: num,
  total_pnl: num,
  status: z.string(),
  redeemable: z.boolean().nullish(),
  negative_risk: z.boolean().nullish(),
  title: str,
  slug: str,
  icon: str,
  event_id: str,
  event_slug: str,
  outcome: str,
  outcome_index: num,
  end_date: str,
  /** Epoch seconds. */
  first_entry_at: num,
  last_event_at: num,
});
export type Position = z.infer<typeof Position>;

export function getPositions(params: {
  user: string;
  status?: PositionStatus;
  limit?: number;
  cursor?: string;
  sortBy?: string;
}): Promise<Page<Position>> {
  return get(
    "/v2/positions",
    {
      user: params.user,
      status: params.status,
      limit: params.limit ?? 1000,
      cursor: params.cursor,
      sort_by: params.sortBy,
    },
    page(Position),
  );
}

// ---------------------------------------------------------------------------
// Activity (trades, redeems, ...)
// ---------------------------------------------------------------------------

export const Activity = z.object({
  proxy_wallet: z.string(),
  /** Epoch seconds. */
  timestamp: z.number(),
  condition_id: z.string(),
  type: z.string(),
  size: z.number(),
  usdc_size: z.number(),
  transaction_hash: str,
  price: num,
  token_id: str,
  side: str,
  outcome_index: num,
  title: str,
  slug: str,
  icon: str,
  event_slug: str,
  outcome: str,
  name: str,
  pseudonym: str,
});
export type Activity = z.infer<typeof Activity>;

export function getActivity(params: {
  user: string;
  type?: string;
  /** Epoch seconds, inclusive. */
  start?: number;
  end?: number;
  sortDirection?: "ASC" | "DESC";
  limit?: number;
  cursor?: string;
}): Promise<Page<Activity>> {
  return get(
    "/v2/activity",
    {
      user: params.user,
      type: params.type,
      start: params.start,
      end: params.end,
      sort_by: "TIMESTAMP",
      sort_direction: params.sortDirection,
      limit: params.limit ?? 1000,
      cursor: params.cursor,
    },
    page(Activity),
  );
}

/** Stable id for a trade row, shared by trader_trades and signals. */
export function tradeId(a: Pick<Activity, "transaction_hash" | "token_id" | "side">): string {
  return `${a.transaction_hash ?? "nohash"}:${a.token_id ?? "notoken"}:${a.side ?? "?"}`;
}

// ---------------------------------------------------------------------------
// PnL series, profile stats, portfolio value
// ---------------------------------------------------------------------------

export const PnlPoint = z.object({
  /** Epoch seconds. */
  timestamp: z.number(),
  realized_pnl: num,
  unrealized_pnl: num,
  /** Realized + unrealized + income − fees: the closest thing to an equity curve. */
  economic_pnl: num,
});
export type PnlPoint = z.infer<typeof PnlPoint>;

export async function getUserPnl(params: {
  user: string;
  interval?: "max" | "all" | "1m" | "1w" | "1d" | "12h" | "6h";
  fidelity?: "1d" | "18h" | "12h" | "3h" | "1h";
}): Promise<PnlPoint[]> {
  const res = await get(
    "/v2/user-pnl",
    { user: params.user, interval: params.interval ?? "all", fidelity: params.fidelity ?? "1d" },
    z.object({ data: z.object({ points: z.array(PnlPoint) }).nullable() }),
  );
  return res.data?.points ?? [];
}

export const UserStats = z.object({
  proxy_wallet: z.string(),
  /** Distinct markets traded. */
  trades: z.number(),
  biggest_win: num,
  join_date: num,
  all_time_pnl: z
    .object({
      realized_pnl: num,
      economic_pnl: num,
      volume_usdc: num,
      trade_count: num,
    })
    .nullish(),
});
export type UserStats = z.infer<typeof UserStats>;

export async function getUserStats(user: string): Promise<UserStats | null> {
  const res = await get("/v2/user-stats", { user }, z.object({ data: UserStats.nullable() }));
  return res.data;
}

/** Current mark-to-market value of a wallet's open positions, in USDC. */
export async function getPortfolioValue(user: string): Promise<number> {
  const res = await get(
    "/v2/value",
    { user },
    z.object({ data: z.object({ value: z.number() }).nullable() }),
  );
  return res.data?.value ?? 0;
}
