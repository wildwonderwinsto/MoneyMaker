/**
 * Database schema (Drizzle ORM, PostgreSQL).
 *
 * Conventions:
 * - Column names are written in camelCase here and mapped to snake_case in SQL
 *   via `casing: "snake_case"` (see drizzle.config.ts and db/client.ts).
 * - Wallet addresses are stored lowercase.
 * - Money / prices use `numeric` with `mode: "number"`; pure statistics use doublePrecision.
 * - Timestamps are timestamptz.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const money = (precision = 18, scale = 6) => numeric({ precision, scale, mode: "number" });
const tsz = () => timestamp({ withTimezone: true, mode: "date" });
const createdAt = () => tsz().notNull().defaultNow();

// ---------------------------------------------------------------------------
// Traders & discovery
// ---------------------------------------------------------------------------

export const traders = pgTable("traders", {
  wallet: text().primaryKey(),
  name: text(),
  pseudonym: text(),
  profileImage: text(),
  xUsername: text(),
  verifiedBadge: boolean().notNull().default(false),
  /** Lifetime fills (from /v2/user-stats); used to detect bots. */
  tradeCount: bigint({ mode: "number" }),
  joinedAt: tsz(),
  /** Best (lowest) leaderboard rank seen and the non-"overall" category it came from. */
  bestRank: integer(),
  leaderboardCategory: text(),
  firstSeenAt: createdAt(),
  lastBackfillAt: tsz(),
  updatedAt: createdAt(),
});

export const leaderboardSnapshots = pgTable(
  "leaderboard_snapshots",
  {
    id: serial().primaryKey(),
    capturedAt: createdAt(),
    timePeriod: text().notNull(),
    category: text().notNull(),
    sortBy: text().notNull(),
    rank: integer().notNull(),
    wallet: text().notNull(),
    pnl: money(),
    volume: doublePrecision(),
  },
  (t) => [index().on(t.capturedAt), index().on(t.wallet)],
);

// ---------------------------------------------------------------------------
// Markets (Polymarket conditions)
// ---------------------------------------------------------------------------

export const markets = pgTable(
  "markets",
  {
    conditionId: text().primaryKey(),
    question: text().notNull(),
    slug: text(),
    eventId: text(),
    eventSlug: text(),
    image: text(),
    category: text(),
    endDate: tsz(),
    closed: boolean().notNull().default(false),
    /** Outcome labels, e.g. ["Yes","No"]. */
    outcomes: jsonb().$type<string[]>().notNull().default([]),
    /** CLOB token ids, index-aligned with `outcomes`. */
    tokenIds: jsonb().$type<string[]>().notNull().default([]),
    /** Index into `outcomes` of the winner once resolved; null while unresolved. */
    winnerIndex: integer(),
    resolvedAt: tsz(),
    updatedAt: createdAt(),
  },
  (t) => [index().on(t.closed), index().on(t.eventId)],
);

// ---------------------------------------------------------------------------
// Trader history (inputs to scoring)
// ---------------------------------------------------------------------------

/** One row per (wallet, outcome token): Polymarket's aggregated position. */
export const traderPositions = pgTable(
  "trader_positions",
  {
    id: serial().primaryKey(),
    wallet: text().notNull(),
    conditionId: text().notNull(),
    tokenId: text().notNull(),
    outcome: text(),
    outcomeIndex: integer(),
    status: text().notNull(),
    avgPrice: money(),
    /** Shares currently held. */
    size: doublePrecision(),
    /** Total shares ever bought (Polymarket `total_size`). */
    sharesBought: doublePrecision(),
    totalCost: money(),
    realizedPnl: money(),
    unrealizedPnl: money(),
    currentValue: money(),
    title: text(),
    slug: text(),
    eventId: text(),
    category: text(),
    endDate: tsz(),
    /** True/false once the market resolved; null if unresolved or unknown. */
    won: boolean(),
    firstEntryAt: tsz(),
    lastActivityAt: tsz(),
    updatedAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.wallet, t.tokenId), index().on(t.conditionId)],
);

/** Individual trades; only kept for shortlisted/followed traders. */
export const traderTrades = pgTable(
  "trader_trades",
  {
    /** `${transactionHash}:${tokenId}:${side}` — stable across re-fetches. */
    id: text().primaryKey(),
    wallet: text().notNull(),
    ts: tsz().notNull(),
    conditionId: text().notNull(),
    tokenId: text().notNull(),
    side: text().notNull(),
    price: money(10, 6).notNull(),
    size: doublePrecision().notNull(),
    usdcSize: money().notNull(),
    outcome: text(),
    outcomeIndex: integer(),
    title: text(),
    slug: text(),
    transactionHash: text(),
  },
  (t) => [index().on(t.wallet, t.ts), index().on(t.conditionId)],
);

/** Daily cumulative PnL series (from /v2/user-pnl). */
export const traderPnlDaily = pgTable(
  "trader_pnl_daily",
  {
    wallet: text().notNull(),
    day: date({ mode: "string" }).notNull(),
    pnl: money().notNull(),
  },
  (t) => [primaryKey({ columns: [t.wallet, t.day] })],
);

export type ScoreTier = "elite" | "verified" | "watchlist" | "rejected";

export interface ScoreCheck {
  code: string;
  label: string;
  ok: boolean;
  value: number | null;
  threshold: number | null;
}

/** Latest score per trader (overwritten each scoring run). */
export const traderScores = pgTable(
  "trader_scores",
  {
    wallet: text().primaryKey(),
    computedAt: createdAt(),
    tier: text().$type<ScoreTier>().notNull(),
    score: doublePrecision().notNull(),
    passed: boolean().notNull(),
    nResolved: integer().notNull(),
    nEvents: integer().notNull(),
    winRate: doublePrecision(),
    expectedWinRate: doublePrecision(),
    zSkill: doublePrecision(),
    roi: doublePrecision(),
    roiShrunk: doublePrecision(),
    totalPnl: money(),
    topMarketShare: doublePrecision(),
    top3Share: doublePrecision(),
    profitableMonthsPct: doublePrecision(),
    maxDrawdown: doublePrecision(),
    sharpe: doublePrecision(),
    copyAdjRoi: doublePrecision(),
    oosRoi: doublePrecision(),
    lastTradeAt: tsz(),
    primaryCategory: text(),
    checks: jsonb().$type<ScoreCheck[]>().notNull().default([]),
    metrics: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index().on(t.tier, t.score)],
);

// ---------------------------------------------------------------------------
// Copy engine
// ---------------------------------------------------------------------------

export const follows = pgTable("follows", {
  wallet: text().primaryKey(),
  enabled: boolean().notNull().default(true),
  /** Multiplier applied to position sizing for this leader. */
  weight: doublePrecision().notNull().default(1),
  note: text(),
  createdAt: createdAt(),
});

/** Last processed leader activity, so ticks are idempotent. */
export const cursors = pgTable("cursors", {
  wallet: text().primaryKey(),
  /** Epoch seconds of the newest processed trade. */
  lastTs: bigint({ mode: "number" }).notNull(),
  updatedAt: createdAt(),
});

/** Traders the admin said "no" to: hidden from the Top traders list until restored. */
export const hiddenTraders = pgTable("hidden_traders", {
  wallet: text().primaryKey(),
  note: text(),
  createdAt: createdAt(),
});

export type SignalDecision = "copied" | "skipped" | "closed";

/**
 * Machine-readable reason behind a decision, so the UI can explain it precisely.
 * `details` carries the numbers (prices, limits, sizes) used to make the call.
 */
export type ReasonCode =
  | "bought"
  | "sold"
  | "stale"
  | "no_market"
  | "market_closed"
  | "ending_soon"
  | "price_too_high"
  | "price_too_low"
  | "daily_loss"
  | "no_sellers"
  | "no_buyers"
  | "price_moved"
  | "no_liquidity"
  | "below_exchange_min"
  | "no_cash"
  | "leader_too_small"
  | "market_cap"
  | "trader_cap"
  | "below_min_order"
  | "no_position"
  | "sells_off"
  | "sell_size_unknown"
  | "other";

/** Every leader trade we observed, with our decision and the reason. */
export const signals = pgTable(
  "signals",
  {
    /** Same id scheme as trader_trades.id (see polymarket/data.ts tradeId). */
    id: text().primaryKey(),
    wallet: text().notNull(),
    detectedAt: createdAt(),
    leaderTs: tsz().notNull(),
    conditionId: text().notNull(),
    tokenId: text().notNull(),
    outcome: text(),
    side: text().notNull(),
    leaderPrice: money(10, 6).notNull(),
    leaderSize: doublePrecision().notNull(),
    leaderUsdc: money().notNull(),
    title: text(),
    slug: text(),
    image: text(),
    decision: text().$type<SignalDecision>().notNull(),
    reason: text().notNull(),
    reasonCode: text().$type<ReasonCode>(),
    details: jsonb().$type<Record<string, number | string | boolean | null>>(),
    /**
     * A leader order that filled in several pieces is decided once; every piece shares
     * the id of the first one here.
     */
    groupId: text(),
    /** How the engine first saw it: "stream" (real-time feed) or "poll" (Data API). */
    source: text(),
    /** Times a skipped signal was re-checked (e.g. after the price moved away). */
    retries: integer().notNull().default(0),
    accountId: integer(),
  },
  (t) => [index().on(t.detectedAt), index().on(t.wallet), index().on(t.decision, t.reasonCode)],
);

// ---------------------------------------------------------------------------
// Paper trading
// ---------------------------------------------------------------------------

export const paperAccounts = pgTable("paper_accounts", {
  id: serial().primaryKey(),
  name: text().notNull(),
  startingBalance: money().notNull(),
  cash: money().notNull(),
  createdAt: createdAt(),
  resetAt: tsz(),
});

export type PaperPositionStatus = "open" | "closed" | "settled";
/** copy = mirrors a leader; hedge = opposite outcome bought to limit a copy's loss. */
export type PaperPositionKind = "copy" | "hedge";

export const paperPositions = pgTable(
  "paper_positions",
  {
    id: serial().primaryKey(),
    accountId: integer()
      .notNull()
      .references(() => paperAccounts.id, { onDelete: "cascade" }),
    /** Leader whose trade opened this position (positions are tracked per leader). */
    sourceWallet: text().notNull(),
    conditionId: text().notNull(),
    tokenId: text().notNull(),
    outcome: text(),
    title: text(),
    slug: text(),
    image: text(),
    shares: doublePrecision().notNull().default(0),
    avgPrice: money(10, 6).notNull().default(0),
    costBasis: money().notNull().default(0),
    realizedPnl: money().notNull().default(0),
    currentPrice: money(10, 6),
    status: text().$type<PaperPositionStatus>().notNull().default("open"),
    kind: text().$type<PaperPositionKind>().notNull().default("copy"),
    /** For hedges: the copy position this one protects. */
    hedgeOf: integer(),
    openedAt: createdAt(),
    closedAt: tsz(),
    updatedAt: createdAt(),
  },
  (t) => [
    uniqueIndex("paper_positions_open_unique")
      .on(t.accountId, t.tokenId, t.sourceWallet, t.kind)
      .where(sql`${t.status} = 'open'`),
    index().on(t.accountId, t.status),
    index().on(t.hedgeOf),
  ],
);

export type PaperFillKind = "trade" | "settlement";

export const paperFills = pgTable(
  "paper_fills",
  {
    id: serial().primaryKey(),
    accountId: integer()
      .notNull()
      .references(() => paperAccounts.id, { onDelete: "cascade" }),
    positionId: integer().references(() => paperPositions.id, { onDelete: "cascade" }),
    signalId: text(),
    kind: text().$type<PaperFillKind>().notNull(),
    side: text().notNull(),
    shares: doublePrecision().notNull(),
    avgPrice: money(10, 6).notNull(),
    notional: money().notNull(),
    /** Fill price vs. the leader's price, in basis points (positive = worse for us). */
    slippageBps: doublePrecision(),
    /** Profit or loss locked in by this fill (sells and settlements); null for buys. */
    realizedPnl: money(),
    ts: createdAt(),
  },
  (t) => [index().on(t.accountId, t.ts), index().on(t.signalId)],
);

export const equitySnapshots = pgTable(
  "equity_snapshots",
  {
    accountId: integer()
      .notNull()
      .references(() => paperAccounts.id, { onDelete: "cascade" }),
    ts: tsz().notNull(),
    equity: money().notNull(),
    cash: money().notNull(),
    positionsValue: money().notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.ts] })],
);

// ---------------------------------------------------------------------------
// Backtests, settings, observability
// ---------------------------------------------------------------------------

export interface EquityPoint {
  t: string;
  equity: number;
}

export const backtestRuns = pgTable("backtest_runs", {
  id: serial().primaryKey(),
  createdAt: createdAt(),
  params: jsonb().$type<Record<string, unknown>>().notNull(),
  summary: jsonb().$type<Record<string, unknown>>().notNull(),
  strategyCurve: jsonb().$type<EquityPoint[]>().notNull(),
  baselineCurve: jsonb().$type<EquityPoint[]>().notNull(),
});

/** Key/value settings (scoring thresholds, risk limits). Validated with Zod on read. */
export const appSettings = pgTable("app_settings", {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedAt: createdAt(),
});

export type JobStatus = "running" | "ok" | "error";

export const jobRuns = pgTable(
  "job_runs",
  {
    id: serial().primaryKey(),
    job: text().notNull(),
    status: text().$type<JobStatus>().notNull(),
    startedAt: createdAt(),
    finishedAt: tsz(),
    stats: jsonb().$type<Record<string, unknown>>(),
    error: text(),
  },
  (t) => [index().on(t.job, t.startedAt)],
);
