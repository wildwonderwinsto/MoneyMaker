/**
 * The copy engine.
 *
 * Trades reach it two ways, and both run the same decision code:
 *   - runStreamBatch: Polymarket's real-time feed (~seconds after the leader traded)
 *   - runTick:        polling every followed leader (the safety net; every 15–60 s), which
 *                     also re-checks skipped trades, settles resolved markets, marks open
 *                     positions to market, auto-hedges, and snapshots equity.
 *
 * Copying comes first: network calls are made in parallel up front, then decisions are
 * applied one at a time (they share the account's cash). A database lease guarantees only
 * one engine run touches the account at a time; trade ids make everything idempotent.
 */
import { and, asc, eq, gt, gte, inArray, sql } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import { cursors, follows, paperFills, paperPositions, signals, traders } from "@/lib/db/schema";
import { holdLease, type HeldLease } from "@/lib/lease";
import { getBook, getMidpoints, type OrderBook } from "@/lib/polymarket/clob";
import {
  getActivity,
  getPositions,
  legacyTradeId,
  tradeId,
  tradeIds,
  type Activity,
} from "@/lib/polymarket/data";
import { sleep } from "@/lib/http";
import { getRiskConfig } from "@/lib/settings";

import {
  applyBuy,
  applySell,
  ensureDefaultAccount,
  exposure,
  loadAccountState,
  lossFraction,
  maybeSnapshot,
  settlePosition,
  startOfDayEquity,
  type AccountState,
  type PaperPosition,
} from "./account";
import type { RiskConfig } from "./config";
import {
  decideBuy,
  decideSell,
  mergeFills,
  RETRYABLE_CODES,
  SELL_RETRYABLE_CODES,
  skip,
  type Decision,
  type LeaderTrade,
  type MarketInfo,
} from "./engine";
import { simulateSell, type Fill } from "./fillSim";
import { oppositeToken, planHedge, type HedgeMode, type HedgeQuote } from "./hedge";
import { getMarketInfo, payoutPerShare } from "./markets";

export interface TickStats {
  skipped?: string;
  source: "poll" | "stream";
  leaders: number;
  newTrades: number;
  copied: number;
  closed: number;
  ignored: number;
  /** Previously skipped trades copied after a re-check. */
  retried: number;
  settled: number;
  hedged: number;
  errors: string[];
  durationMs: number;
}

// A run renews its lease while it works (see holdLease), so this only bounds how long a run
// killed mid-way (crash, deploy) blocks the engine before the next run may start.
export const LEASE = "tick";
export const LEASE_TTL_MS = 60_000;

const newStats = (source: TickStats["source"]): TickStats => ({
  source,
  leaders: 0,
  newTrades: 0,
  copied: 0,
  closed: 0,
  ignored: 0,
  retried: 0,
  settled: 0,
  hedged: 0,
  errors: [],
  durationMs: 0,
});

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function toLeaderTrade(a: Activity, id = tradeId(a)): LeaderTrade | null {
  if (!a.token_id || (a.side !== "BUY" && a.side !== "SELL") || a.price == null) return null;
  return {
    id,
    wallet: a.proxy_wallet.toLowerCase(),
    ts: a.timestamp,
    conditionId: a.condition_id,
    tokenId: a.token_id,
    side: a.side,
    price: a.price,
    size: a.size,
    // Not usdc_size: that includes the leader's taker fee, which the real-time feed can't
    // see. Both paths must size the same trade the same (minLeaderUsd, conviction).
    usdc: a.price * a.size,
    outcome: a.outcome ?? null,
    title: a.title ?? null,
    slug: a.slug ?? null,
    icon: a.icon || null,
  };
}

interface EngineCtx {
  accountId: number;
  cfg: RiskConfig;
  /** Epoch seconds. */
  now: number;
  /** Enabled leaders → sizing weight. */
  weights: Map<string, number>;
  /** Leaders → usual stake per market (conviction sizing); missing = not known yet. */
  typicalStakes: Map<string, number>;
  /**
   * `wallet|tokenId` of copies still open from leaders we no longer follow. Only those
   * leaders' sells of these tokens are acted on (see loadWindDown).
   */
  exitOnly: Set<string>;
  stats: TickStats;
}

const heldKey = (wallet: string, tokenId: string) => `${wallet}|${tokenId}`;

/**
 * Leaders we stopped copying but still hold copies from. Their buys are ignored, but their
 * sells are still mirrored, so those positions close when the leader gets out instead of
 * being stranded until the market resolves. A leader drops off once nothing is left open.
 */
async function loadWindDown(
  db: Db,
  accountId: number,
  followed: Set<string>,
  onlyWallets?: string[],
): Promise<{ wallets: string[]; held: Set<string> }> {
  const rows = await db
    .selectDistinct({ wallet: paperPositions.sourceWallet, tokenId: paperPositions.tokenId })
    .from(paperPositions)
    .where(
      and(
        eq(paperPositions.accountId, accountId),
        eq(paperPositions.status, "open"),
        eq(paperPositions.kind, "copy"),
        onlyWallets ? inArray(paperPositions.sourceWallet, onlyWallets) : undefined,
      ),
    );
  const wallets = new Set<string>();
  const held = new Set<string>();
  for (const r of rows) {
    if (followed.has(r.wallet)) continue;
    wallets.add(r.wallet);
    held.add(heldKey(r.wallet, r.tokenId));
  }
  return { wallets: [...wallets], held };
}

/** Everything a followed leader does; only exits of copies we still hold otherwise. */
const isRelevant = (ctx: EngineCtx, t: LeaderTrade) =>
  ctx.weights.has(t.wallet) ||
  (t.side === "SELL" && ctx.exitOnly.has(heldKey(t.wallet, t.tokenId)));

/** Wallets the engine watches: followed leaders plus those still being wound down. */
export async function engineWallets(db: Db): Promise<string[]> {
  const account = await ensureDefaultAccount(db);
  const leaders = await db
    .select({ wallet: follows.wallet })
    .from(follows)
    .where(eq(follows.enabled, true));
  const followed = new Set(leaders.map((l) => l.wallet));
  const { wallets } = await loadWindDown(db, account.id, followed);
  return [...followed, ...wallets];
}

/** Wait for the engine lease (another run usually finishes within a few seconds). */
async function waitForLease(db: Db, attempts: number): Promise<HeldLease | null> {
  for (let i = 0; i < attempts; i++) {
    const lease = await holdLease(db, LEASE, LEASE_TTL_MS);
    if (lease) return lease;
    if (i < attempts - 1) await sleep(500);
  }
  return null;
}

/**
 * Run admin work that changes the paper account (manual hedge, reset) under the engine
 * lease, so it never interleaves with a run deciding from the state it would change.
 */
export async function withEngineLease<T>(db: Db, fn: (db: Db) => Promise<T>): Promise<T> {
  const lease = await waitForLease(db, 30);
  if (!lease) throw new Error("The copy engine is busy; try again in a moment.");
  try {
    return await fn(lease.guard(db));
  } finally {
    await lease.release();
  }
}

/** Leaders' usual stake per market, from the daily backfill. */
async function loadTypicalStakes(db: Db, wallets: string[]): Promise<Map<string, number>> {
  if (wallets.length === 0) return new Map();
  const rows = await db
    .select({ wallet: traders.wallet, stake: traders.typicalStakeUsd })
    .from(traders)
    .where(inArray(traders.wallet, wallets));
  return new Map(
    rows.filter((r) => r.stake !== null && r.stake > 0).map((r) => [r.wallet, r.stake!]),
  );
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export interface TickPhases {
  /** Poll leaders and re-check skips (default true). */
  copy?: boolean;
  /** Settle, mark to market, auto-hedge, snapshot (default true). */
  housekeeping?: boolean;
}

/**
 * Full engine pass: poll every leader, re-check skips, settle, mark, hedge, snapshot.
 * The runner calls the two phases separately so real-time copies can slip in between.
 */
export async function runTick(
  rawDb: Db,
  nowMs = Date.now(),
  phases: TickPhases = {},
): Promise<TickStats> {
  const doCopy = phases.copy ?? true;
  const doHousekeeping = phases.housekeeping ?? true;
  const started = Date.now();
  const stats = newStats("poll");
  const lease = await holdLease(rawDb, LEASE, LEASE_TTL_MS);
  if (!lease) return { ...stats, skipped: "Another engine run is in progress" };
  const db = lease.guard(rawDb);
  try {
    const cfg = await getRiskConfig(db);
    const account = await ensureDefaultAccount(db);
    const now = Math.floor(nowMs / 1000);
    const leaders = await db.select().from(follows).where(eq(follows.enabled, true));
    stats.leaders = leaders.length;
    const followed = new Set(leaders.map((l) => l.wallet));
    const windDown = doCopy
      ? await loadWindDown(db, account.id, followed)
      : { wallets: [], held: new Set<string>() };
    const ctx: EngineCtx = {
      accountId: account.id,
      cfg,
      now,
      weights: new Map(leaders.map((l) => [l.wallet, l.weight])),
      typicalStakes: await loadTypicalStakes(db, [...followed]),
      exitOnly: windDown.held,
      stats,
    };

    if (doCopy) {
      await pollLeaders(db, ctx, [...followed, ...windDown.wallets]);
      if (cfg.retrySkipped) {
        try {
          await retrySkipped(db, ctx);
        } catch (err) {
          stats.errors.push(`retry: ${errMsg(err)}`);
        }
      }
      if (cfg.copySells) {
        try {
          await retrySkippedSells(db, ctx);
        } catch (err) {
          stats.errors.push(`retry sells: ${errMsg(err)}`);
        }
      }
    }
    if (doHousekeeping) {
      try {
        await settleAndMark(db, ctx);
      } catch (err) {
        stats.errors.push(`settle: ${errMsg(err)}`);
      }
    }
    const traded = stats.copied + stats.closed + stats.settled + stats.hedged > 0;
    if (traded || doHousekeeping) await maybeSnapshot(db, account.id, traded ? 0 : undefined);
  } finally {
    await lease.release();
  }
  stats.durationMs = Date.now() - started;
  return stats;
}

/**
 * Copy trades straight from the real-time feed. Only decides and fills; settlement and
 * housekeeping stay in runTick. Waits briefly if another run holds the lease, and gives
 * up after that: the next poll picks the trades up anyway (ids keep it idempotent).
 */
export async function runStreamBatch(
  rawDb: Db,
  trades: LeaderTrade[],
  nowMs = Date.now(),
): Promise<TickStats> {
  const started = Date.now();
  const stats = newStats("stream");
  const lease = await waitForLease(rawDb, 10);
  if (!lease) return { ...stats, skipped: "Engine busy; the next poll will pick these up" };
  const db = lease.guard(rawDb);
  try {
    const wallets = [...new Set(trades.map((t) => t.wallet))];
    const leaders = await db
      .select()
      .from(follows)
      .where(and(eq(follows.enabled, true), inArray(follows.wallet, wallets)));
    stats.leaders = leaders.length;
    const account = await ensureDefaultAccount(db);
    const followed = new Set(leaders.map((l) => l.wallet));
    const windDown = await loadWindDown(db, account.id, followed, wallets);
    if (leaders.length === 0 && windDown.wallets.length === 0) return stats;
    const cfg = await getRiskConfig(db);
    const ctx: EngineCtx = {
      accountId: account.id,
      cfg,
      now: Math.floor(nowMs / 1000),
      weights: new Map(leaders.map((l) => [l.wallet, l.weight])),
      typicalStakes: await loadTypicalStakes(db, [...followed]),
      exitOnly: windDown.held,
      stats,
    };
    const ours = trades.filter((t) => isRelevant(ctx, t));
    const fresh = await filterUnseen(db, ours, new Map());
    stats.newTrades = fresh.length;
    if (fresh.length) await processTrades(db, ctx, fresh, "stream");
    if (stats.copied + stats.closed > 0) await maybeSnapshot(db, account.id, 0);
  } finally {
    await lease.release();
  }
  stats.durationMs = Date.now() - started;
  return stats;
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

async function setCursor(db: Db, wallet: string, lastTs: number) {
  await db
    .insert(cursors)
    .values({ wallet, lastTs })
    .onConflictDoUpdate({ target: cursors.wallet, set: { lastTs, updatedAt: new Date() } });
}

async function pollLeaders(db: Db, ctx: EngineCtx, wallets: string[]) {
  if (wallets.length === 0) return;
  const cursorRows = await db.select().from(cursors).where(inArray(cursors.wallet, wallets));
  const cursorOf = new Map(cursorRows.map((c) => [c.wallet, c.lastTs]));

  // First sighting: start watching from now; never copy history.
  for (const w of wallets) if (!cursorOf.has(w)) await setCursor(db, w, ctx.now);
  const watched = wallets.filter((w) => cursorOf.has(w));

  // Fetch every leader at once (the rate limiter keeps us polite).
  const pages = await Promise.all(
    watched.map(async (wallet) => {
      const cursor = cursorOf.get(wallet)!;
      try {
        const page = await getActivity({
          user: wallet,
          // Merges and conversions are exits without a trade (owner, 2026-11-09).
          type: "TRADE,MERGE,CONVERSION",
          start: cursor,
          sortDirection: "ASC",
          limit: 200,
        });
        return { wallet, rows: page.data.filter((a) => a.timestamp >= cursor) };
      } catch (err) {
        ctx.stats.errors.push(`${wallet}: ${errMsg(err)}`);
        return null;
      }
    }),
  );

  const candidates: LeaderTrade[] = [];
  const legacy = new Map<string, string>();
  const maxTs = new Map<string, number>();
  for (const page of pages) {
    if (!page || page.rows.length === 0) continue;
    const ids = tradeIds(page.rows);
    page.rows.forEach((a, i) => {
      const t = toLeaderTrade(a, ids[i]);
      if (!t || !isRelevant(ctx, t)) return;
      candidates.push(t);
      legacy.set(t.id, legacyTradeId(a));
    });
    maxTs.set(page.wallet, Math.max(...page.rows.map((a) => a.timestamp)));
  }

  const flagged = await leaderExitsWithoutTrades(db, ctx, pages, watched, candidates);

  // `start` is inclusive and the stream may have copied some already: skip known ids.
  const fresh = await filterUnseen(db, candidates, legacy);
  ctx.stats.newTrades += fresh.length;
  const failedAt = fresh.length ? await processTrades(db, ctx, fresh, "poll") : new Map();
  // `start` is inclusive, so a trade that failed to record is fetched again next tick
  // (already-recorded ones are filtered out by id).
  for (const [wallet, ts] of maxTs) {
    await setCursor(
      db,
      wallet,
      Math.min(ts, failedAt.get(wallet) ?? Infinity, flagged.get(wallet) ?? Infinity),
    );
  }
}

/**
 * Leader exits without a trade (owner decision 2026-11-09), for markets we hold a copy in.
 * A MERGE turns YES+NO pairs back into $1 each, so the leader's holding on each side drops by
 * `size`: added to `candidates` as a sell of `size` on each of our copies there, sized by the
 * normal sell path (merged ÷ what they held). The leader got $1 a pair, so there is no
 * per-side price and no sell floor applies. A CONVERSION (negRisk) is not reliably tied to one
 * market's NO side (verified live: one row can stand for ~9 markets), so it is only recorded
 * as a skipped signal for the Live page. Returns, per wallet, the time of a conversion whose
 * signal failed to record (the cursor is held there).
 */
async function leaderExitsWithoutTrades(
  db: Db,
  ctx: EngineCtx,
  pages: Array<{ wallet: string; rows: Activity[] } | null>,
  watched: string[],
  candidates: LeaderTrade[],
): Promise<Map<string, number>> {
  const failed = new Map<string, number>();
  const rows = pages.flatMap(
    (p) => p?.rows.filter((a) => a.type === "MERGE" || a.type === "CONVERSION") ?? [],
  );
  if (rows.length === 0) return failed;
  const held = await db
    .select({
      wallet: paperPositions.sourceWallet,
      conditionId: paperPositions.conditionId,
      tokenId: paperPositions.tokenId,
      outcome: paperPositions.outcome,
    })
    .from(paperPositions)
    .where(
      and(
        eq(paperPositions.accountId, ctx.accountId),
        eq(paperPositions.status, "open"),
        eq(paperPositions.kind, "copy"),
        inArray(paperPositions.sourceWallet, watched),
      ),
    );
  for (const a of rows) {
    const wallet = a.proxy_wallet.toLowerCase();
    for (const h of held.filter((x) => x.wallet === wallet && x.conditionId === a.condition_id)) {
      const id = `${(a.transaction_hash ?? "nohash").toLowerCase()}:${h.tokenId}:${a.type}:${a.size}`;
      const base = {
        id,
        wallet,
        ts: a.timestamp,
        conditionId: a.condition_id,
        tokenId: h.tokenId,
        side: "SELL" as const,
        price: 0,
        size: a.size,
        usdc: 0,
        outcome: h.outcome ?? null,
        title: a.title ?? null,
        slug: a.slug ?? null,
        icon: a.icon || null,
      };
      if (a.type === "MERGE") {
        if (isRelevant(ctx, base)) candidates.push(base);
        continue;
      }
      try {
        await db
          .insert(signals)
          .values({
            id,
            wallet,
            leaderTs: new Date(a.timestamp * 1000),
            conditionId: a.condition_id,
            tokenId: h.tokenId,
            outcome: h.outcome ?? null,
            side: "SELL",
            leaderPrice: 0,
            leaderSize: a.size,
            leaderUsdc: a.usdc_size,
            title: a.title ?? null,
            slug: a.slug ?? null,
            decision: "skipped",
            reason:
              "Leader converted shares in this market (negRisk). Not mirrored automatically — check and close by hand if they exited.",
            reasonCode: "leader_converted",
            source: "poll",
            accountId: ctx.accountId,
          })
          .onConflictDoNothing();
      } catch (err) {
        ctx.stats.errors.push(`${wallet}: conversion signal: ${errMsg(err)}`);
        failed.set(wallet, Math.min(failed.get(wallet) ?? Infinity, a.timestamp));
      }
    }
  }
  return failed;
}

/** Drop trades already recorded (by current id, or by the pre-fill-aware legacy id). */
async function filterUnseen(
  db: Db,
  trades: LeaderTrade[],
  legacy: Map<string, string>,
): Promise<LeaderTrade[]> {
  if (trades.length === 0) return [];
  const ids = [...new Set([...trades.map((t) => t.id), ...legacy.values()])];
  const seen = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db
      .select({ id: signals.id })
      .from(signals)
      .where(inArray(signals.id, ids.slice(i, i + 500)));
    for (const r of rows) seen.add(r.id);
  }
  return trades.filter((t) => !seen.has(t.id) && !seen.has(legacy.get(t.id) ?? ""));
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

const openCopy = (state: AccountState, wallet: string, tokenId: string) =>
  state.open.find((p) => p.kind === "copy" && p.sourceWallet === wallet && p.tokenId === tokenId);
const openHedge = (state: AccountState, positionId: number) =>
  state.open.find((p) => p.kind === "hedge" && p.hedgeOf === positionId);

/** Copied buys in our open position for this trade's trader and outcome (only when capped). */
async function positionBuys(db: Db, state: AccountState, cfg: RiskConfig, t: LeaderTrade) {
  if (cfg.maxBuysPerPosition <= 0) return 0;
  const pos = openCopy(state, t.wallet, t.tokenId);
  if (!pos) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(paperFills)
    .where(and(eq(paperFills.positionId, pos.id), eq(paperFills.side, "BUY")));
  return row?.n ?? 0;
}

interface LeaderPosition {
  size: number;
  /** Epoch seconds of the last trade the Data API has applied to this position. */
  lastEventAt: number | null;
}

/**
 * What share of their position the leader sold in `trade`.
 *
 * The positions endpoint lags the trade feed by ~15 s, so it may not include this batch
 * yet. Trades newer than the position's `lastEventAt` are applied on top first; then
 * trades after `trade` are undone, giving the size right after it. `batch` should hold the
 * individual fills (not merged trades): each fill is judged by its own time, so an exit that
 * filled in pieces is measured correctly when the API has applied only some of them.
 * No listed position = it didn't exist before this batch, so every fill in it applies.
 * Pure (tested).
 */
export function leaderSoldFraction(
  trade: LeaderTrade,
  batch: LeaderTrade[],
  pos: LeaderPosition | undefined,
): number {
  const same = batch.filter((m) => m.wallet === trade.wallet && m.tokenId === trade.tokenId);
  let size = pos?.size ?? 0;
  if (!pos || pos.lastEventAt !== null) {
    const after = pos?.lastEventAt ?? -Infinity;
    for (const m of same) if (m.ts > after) size += m.side === "BUY" ? m.size : -m.size;
  }
  size = Math.max(0, size);
  // The last fill belonging to `trade` (a merged trade lists its fills in `ids`).
  const ids = new Set(trade.ids ?? [trade.id]);
  let idx = -1;
  same.forEach((m, i) => {
    if (m === trade || ids.has(m.id)) idx = i;
  });
  for (const m of same.slice(idx + 1)) size += m.side === "SELL" ? m.size : -m.size;
  size = Math.max(0, size);
  // A 0-share sell sold nothing (and 0 / 0 would be NaN).
  return size + trade.size > 0 ? trade.size / (size + trade.size) : 0;
}

async function mapSettled<K, V>(keys: K[], fn: (k: K) => Promise<V>): Promise<Map<K, V | null>> {
  const out = new Map<K, V | null>();
  await Promise.all(
    keys.map(async (k) => {
      out.set(k, await fn(k).catch(() => null));
    }),
  );
  return out;
}

async function processTrades(
  db: Db,
  ctx: EngineCtx,
  trades: LeaderTrade[],
  source: "poll" | "stream",
): Promise<Map<string, number>> {
  const { cfg } = ctx;
  /** Wallet → earliest epoch second of a trade that couldn't be recorded. */
  const failedAt = new Map<string, number>();
  const sorted = [...trades].sort((a, b) => a.ts - b.ts);
  const originals = new Map(sorted.map((t) => [t.id, t]));
  const merged = mergeFills(sorted, 30, Math.max(0.01, cfg.maxPriceDrift));

  // Everything that needs the network, fetched in parallel before any decision.
  const [state0, startEquity, info] = await Promise.all([
    loadAccountState(db, ctx.accountId),
    startOfDayEquity(db, ctx.accountId, ctx.now * 1000),
    getMarketInfo(
      db,
      merged.map((t) => t.conditionId),
    ),
  ]);
  const dayLoss0 = lossFraction(startEquity, state0.equity);
  const buyMayCopy = (t: LeaderTrade) => {
    const m = info.get(t.conditionId);
    return (
      ctx.now - t.ts <= cfg.maxSignalAgeSeconds &&
      t.price <= cfg.maxEntryPrice &&
      t.price >= cfg.minEntryPrice &&
      t.usdc >= cfg.minLeaderUsd &&
      dayLoss0 < cfg.maxDailyLossPct &&
      !!m &&
      !m.closed
    );
  };
  const bookTokens = new Set<string>();
  const sellConditions = new Map<string, Set<string>>();
  for (const t of merged) {
    if (t.side === "BUY" && buyMayCopy(t)) {
      bookTokens.add(t.tokenId);
    } else if (t.side === "SELL") {
      const pos = openCopy(state0, t.wallet, t.tokenId);
      if (!pos || !cfg.copySells) continue;
      bookTokens.add(t.tokenId);
      const hedge = openHedge(state0, pos.id);
      if (hedge) bookTokens.add(hedge.tokenId);
      const set = sellConditions.get(t.wallet) ?? new Set<string>();
      set.add(t.conditionId);
      sellConditions.set(t.wallet, set);
    }
  }
  const [books, fetched] = await Promise.all([
    mapSettled([...bookTokens], (id) => getBook(id)),
    fetchLeaderPositions(sellConditions),
  ]);
  const leaderPositions = fetched.positions;
  const unlisted = merged.filter(
    (t) =>
      t.side === "SELL" &&
      sellConditions.has(t.wallet) &&
      !fetched.failed.has(t.wallet) &&
      !leaderPositions.has(heldKey(t.wallet, t.tokenId)),
  );
  for (const [k, v] of await estimateUnlisted(db, ctx, state0, unlisted)) {
    leaderPositions.set(k, v);
  }
  const batchIds = new Set(sorted.map((t) => t.id));
  for (const t of merged) {
    const key = heldKey(t.wallet, t.tokenId);
    const pos = leaderPositions.get(key);
    if (t.side !== "SELL" || !pos || unlisted.includes(t) || !openCopy(state0, t.wallet, t.tokenId))
      continue;
    leaderPositions.set(key, await catchUpSnapshot(db, ctx, t.wallet, t.tokenId, pos, batchIds));
  }

  let state = state0;
  for (const t of merged) {
    const market = info.get(t.conditionId) ?? null;
    let decision: Decision;
    let hedgeExit: HedgeExit | null = null;
    if (t.side === "BUY") {
      const exp = exposure(state, t.conditionId, t.wallet);
      decision = decideBuy({
        now: ctx.now,
        trade: t,
        market,
        book: books.get(t.tokenId) ?? null,
        equity: state.equity,
        cash: state.cash,
        leaderTypicalUsd: ctx.typicalStakes.get(t.wallet) ?? null,
        weight: ctx.weights.get(t.wallet) ?? 1,
        marketExposure: exp.market,
        traderExposure: exp.trader,
        dailyLossPct: lossFraction(startEquity, state.equity),
        positionBuys: await positionBuys(db, state, cfg, t),
        cfg,
      });
    } else {
      const position = openCopy(state, t.wallet, t.tokenId);
      if (!position) {
        decision = skip("No copied position to close", "no_position");
      } else if (fetched.failed.has(t.wallet)) {
        decision = skip(
          "Couldn't load the trader's position to size this sell; will re-check",
          "sell_size_unknown",
        );
      } else {
        decision = decideSell({
          trade: t,
          ourShares: position.shares,
          leaderSoldFraction: leaderSoldFraction(
            t,
            sorted,
            leaderPositions.get(heldKey(t.wallet, t.tokenId)),
          ),
          book: books.get(t.tokenId) ?? null,
          feeRate: market?.takerFeeRate,
          cfg,
        });
        if (decision.action === "sell") {
          const feeRate = market?.takerFeeRate ?? 0;
          hedgeExit = planHedgeExit(state, position, decision.fraction, books, cfg, feeRate);
        }
      }
    }
    try {
      await recordDecision(db, ctx, t, originals, market, decision, source, hedgeExit);
    } catch (err) {
      ctx.stats.errors.push(`${t.wallet} ${t.id}: ${errMsg(err)}`);
      // Nothing was recorded: keep the poll cursor at or before it so it's tried again.
      failedAt.set(t.wallet, Math.min(failedAt.get(t.wallet) ?? Infinity, t.ts));
      continue;
    }
    if (decision.action === "buy") ctx.stats.copied++;
    else if (decision.action === "sell") ctx.stats.closed++;
    else ctx.stats.ignored++;
    if (decision.action !== "skip") state = await loadAccountState(db, ctx.accountId);
  }
  return failedAt;
}

/**
 * Leaders' current positions in the markets they're selling. Wallets whose fetch failed are
 * listed in `failed`: their sells can't be sized, so they are skipped and re-checked
 * (treating "unknown" as "fully exited" would dump the whole copy on a partial sell).
 */
async function fetchLeaderPositions(byWallet: Map<string, Set<string>>) {
  const out = new Map<string, LeaderPosition>();
  const failed = new Set<string>();
  await Promise.all(
    [...byWallet].map(async ([wallet, conditions]) => {
      const ids = [...conditions];
      for (let i = 0; i < ids.length; i += 20) {
        const res = await getPositions({ user: wallet, condition: ids.slice(i, i + 20) }).catch(
          () => null,
        );
        if (!res) failed.add(wallet);
        for (const p of res?.data ?? []) {
          out.set(`${wallet}|${p.token_id}`, {
            size: p.current_size,
            lastEventAt: p.last_event_at ?? null,
          });
        }
      }
    }),
  );
  return { positions: out, failed };
}

/**
 * The leader's size in our copy's outcome by our own records: every trade of theirs we
 * recorded there, copied or skipped (skipped buys before our copy opened count too), in
 * time order and never below zero, so a holding they had fully sold earlier drops out.
 * Used when the positions endpoint doesn't list a position we hold a copy of: it lags the
 * trade feed by an unbounded amount, but our copy proves the leader held these shares.
 * Blind to leader exits that aren't trades (merge, redeem, transfer) and to trades made
 * while we didn't record them (before following, or while unfollowed).
 */
async function recordedSize(db: Db, ctx: EngineCtx, copy: PaperPosition) {
  const rows = await db
    .select({ side: signals.side, size: signals.leaderSize })
    .from(signals)
    .where(
      and(
        eq(signals.accountId, ctx.accountId),
        eq(signals.wallet, copy.sourceWallet),
        eq(signals.tokenId, copy.tokenId),
      ),
    )
    .orderBy(asc(signals.leaderTs));
  return rows.reduce((s, r) => Math.max(0, s + (r.side === "BUY" ? r.size : -r.size)), 0);
}

/**
 * A listed position reflects the leader's trades up to its `lastEventAt`; the endpoint may
 * still lag behind trades we recorded after that in earlier runs. Those are added here
 * (`batch` = trades the caller applies itself, skipped).
 */
async function catchUpSnapshot(
  db: Db,
  ctx: EngineCtx,
  wallet: string,
  tokenId: string,
  pos: LeaderPosition,
  batch: Set<string>,
): Promise<LeaderPosition> {
  if (pos.lastEventAt === null) return pos;
  const rows = await db
    .select({ id: signals.id, side: signals.side, size: signals.leaderSize })
    .from(signals)
    .where(
      and(
        eq(signals.accountId, ctx.accountId),
        eq(signals.wallet, wallet),
        eq(signals.tokenId, tokenId),
        gt(signals.leaderTs, new Date(pos.lastEventAt * 1000)),
      ),
    );
  const net = rows
    .filter((r) => !batch.has(r.id))
    .reduce((s, r) => s + (r.side === "BUY" ? r.size : -r.size), 0);
  return net === 0 ? pos : { ...pos, size: Math.max(0, pos.size + net) };
}

/**
 * Sells of positions the endpoint doesn't list (yet): the leader's size before this batch
 * is rebuilt from the trades we recorded (this batch isn't recorded yet, and is applied on
 * top by leaderSoldFraction).
 */
async function estimateUnlisted(
  db: Db,
  ctx: EngineCtx,
  state: AccountState,
  keys: Array<{ wallet: string; tokenId: string }>,
): Promise<Map<string, LeaderPosition>> {
  const out = new Map<string, LeaderPosition>();
  for (const { wallet, tokenId } of keys) {
    const copy = openCopy(state, wallet, tokenId);
    if (!copy || out.has(heldKey(wallet, tokenId))) continue;
    const size = await recordedSize(db, ctx, copy);
    out.set(heldKey(wallet, tokenId), { size, lastEventAt: -Infinity });
  }
  return out;
}

interface HedgeExit {
  hedge: PaperPosition;
  fill: Fill;
}

/** When the leader exits, sell the same share of any hedge so it never stands alone. */
function planHedgeExit(
  state: AccountState,
  position: PaperPosition,
  fraction: number,
  books: Map<string, OrderBook | null>,
  cfg: RiskConfig,
  /** Same market as the copy, so the same taker fee rate. */
  feeRate = 0,
): HedgeExit | null {
  const hedge = openHedge(state, position.id);
  const book = hedge ? books.get(hedge.tokenId) : null;
  if (!hedge || !book || book.bids.length === 0) return null;
  const fill = simulateSell(book.bids, hedge.shares * fraction, 0, cfg.takerFeeBps, feeRate);
  return fill.shares > 0 ? { hedge, fill } : null;
}

function reasonText(decision: Decision, fills: number): string {
  const merged = fills > 1 ? ` · ${fills} fills combined` : "";
  if (decision.action === "buy") {
    const f = decision.fill;
    return `Bought ${f.shares.toFixed(1)} @ ${(f.avgPrice * 100).toFixed(1)}¢ ($${f.notional.toFixed(2)})${merged}`;
  }
  if (decision.action === "sell") {
    const f = decision.fill;
    return `Sold ${Math.round(decision.fraction * 100)}% (${f.shares.toFixed(1)} @ ${(f.avgPrice * 100).toFixed(1)}¢)${merged}`;
  }
  return decision.reason;
}

async function recordDecision(
  db: Db,
  ctx: EngineCtx,
  trade: LeaderTrade,
  originals: Map<string, LeaderTrade>,
  market: MarketInfo | null,
  decision: Decision,
  source: "poll" | "stream",
  hedgeExit: HedgeExit | null,
) {
  const ids = trade.ids ?? [trade.id];
  const reason = reasonText(decision, ids.length);
  const reasonCode =
    decision.action === "buy" ? "bought" : decision.action === "sell" ? "sold" : decision.code;
  const details = decision.action === "skip" ? (decision.details ?? null) : decision.details;
  const decisionLabel =
    decision.action === "buy" ? "copied" : decision.action === "sell" ? "closed" : "skipped";

  await db.transaction(async (tx) => {
    const rows = ids.map((id) => {
      const o = originals.get(id) ?? trade;
      return {
        id,
        wallet: trade.wallet,
        leaderTs: new Date(o.ts * 1000),
        conditionId: trade.conditionId,
        tokenId: trade.tokenId,
        outcome: trade.outcome,
        side: trade.side,
        leaderPrice: o.price,
        leaderSize: o.size,
        leaderUsdc: o.usdc,
        title: market?.question ?? trade.title,
        slug: market?.slug ?? trade.slug,
        image: market?.image ?? trade.icon ?? null,
        decision: decisionLabel,
        reason,
        reasonCode,
        details,
        groupId: ids.length > 1 ? trade.id : null,
        source,
        accountId: ctx.accountId,
      } as const;
    });
    const inserted = await tx
      .insert(signals)
      .values(rows)
      .onConflictDoNothing()
      .returning({ id: signals.id });
    // Lost the race for the first fill: whoever recorded it applied the fill.
    if (!inserted.some((r) => r.id === trade.id)) return;

    if (decision.action === "buy" && market) {
      await applyBuy(tx, ctx.accountId, trade, market, decision.fill);
    } else if (decision.action === "sell") {
      const [position] = await tx
        .select()
        .from(paperPositions)
        .where(
          and(
            eq(paperPositions.accountId, ctx.accountId),
            eq(paperPositions.tokenId, trade.tokenId),
            eq(paperPositions.sourceWallet, trade.wallet),
            eq(paperPositions.kind, "copy"),
            eq(paperPositions.status, "open"),
          ),
        );
      if (position) await applySell(tx, position, trade, decision.fill);
      if (hedgeExit) {
        await applySell(
          tx,
          hedgeExit.hedge,
          { ...trade, price: hedgeExit.fill.avgPrice },
          hedgeExit.fill,
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Re-checking skipped trades
// ---------------------------------------------------------------------------

type SignalRow = typeof signals.$inferSelect;

/** One leader trade per recorded order (pieces share a groupId), in time order. */
function signalGroups(rows: SignalRow[]): LeaderTrade[] {
  const groups = new Map<string, SignalRow[]>();
  for (const r of rows) {
    const key = r.groupId ?? r.id;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups].map(([key, g]) => {
    const size = g.reduce((a, r) => a + r.leaderSize, 0);
    const usdc = g.reduce((a, r) => a + r.leaderUsdc, 0);
    const first = g[0];
    return {
      // The group's first fill, unless it already aged out of the window.
      id: g.some((r) => r.id === key) ? key : first.id,
      ids: g.map((r) => r.id),
      wallet: first.wallet,
      ts: Math.floor(Math.min(...g.map((r) => r.leaderTs.getTime())) / 1000),
      conditionId: first.conditionId,
      tokenId: first.tokenId,
      side: first.side === "SELL" ? "SELL" : "BUY",
      price:
        size > 0
          ? g.reduce((a, r) => a + r.leaderPrice * r.leaderSize, 0) / size
          : first.leaderPrice,
      size,
      usdc,
      outcome: first.outcome,
      title: first.title,
      slug: first.slug,
      icon: first.image,
    };
  });
}

/**
 * A leader exit we couldn't follow (no buyers, below the sell floor, or their position
 * couldn't be loaded) is re-checked every tick while we still hold the copy. The share
 * they sold is recomputed from their position now, undoing trades they made since.
 */
async function retrySkippedSells(db: Db, ctx: EngineCtx) {
  const { cfg } = ctx;
  const rows = await db
    .select()
    .from(signals)
    .where(
      and(
        eq(signals.accountId, ctx.accountId),
        eq(signals.decision, "skipped"),
        eq(signals.side, "SELL"),
        inArray(signals.reasonCode, [...SELL_RETRYABLE_CODES]),
      ),
    )
    .orderBy(asc(signals.leaderTs))
    .limit(200);
  if (rows.length === 0) return;
  let state = await loadAccountState(db, ctx.accountId);
  // Only exits of a copy we still hold that was already open when the leader sold.
  const heldAtSell = (t: LeaderTrade) => {
    const p = openCopy(state, t.wallet, t.tokenId);
    return !!p && p.openedAt.getTime() <= t.ts * 1000;
  };
  const exits = signalGroups(rows).filter(heldAtSell);
  if (exits.length === 0) return;

  // Every trade they made in these outcomes since the earliest pending exit.
  const since = new Date(Math.min(...exits.map((t) => t.ts)) * 1000);
  const later = await db
    .select()
    .from(signals)
    .where(
      and(
        eq(signals.accountId, ctx.accountId),
        inArray(signals.wallet, [...new Set(exits.map((t) => t.wallet))]),
        inArray(signals.tokenId, [...new Set(exits.map((t) => t.tokenId))]),
        gte(signals.leaderTs, since),
      ),
    )
    .orderBy(asc(signals.leaderTs));
  const fills: LeaderTrade[] = later.map((r) => ({
    id: r.id,
    wallet: r.wallet,
    ts: Math.floor(r.leaderTs.getTime() / 1000),
    conditionId: r.conditionId,
    tokenId: r.tokenId,
    side: r.side === "SELL" ? "SELL" : "BUY",
    price: r.leaderPrice,
    size: r.leaderSize,
    usdc: r.leaderUsdc,
    outcome: r.outcome,
    title: r.title,
    slug: r.slug,
  }));

  const fillIds = new Set(fills.map((f) => f.id));
  const conditions = new Map<string, Set<string>>();
  for (const t of exits) {
    conditions.set(t.wallet, (conditions.get(t.wallet) ?? new Set()).add(t.conditionId));
  }
  const tokens = new Set(exits.map((t) => t.tokenId));
  for (const t of exits) {
    const hedge = openHedge(state, openCopy(state, t.wallet, t.tokenId)!.id);
    if (hedge) tokens.add(hedge.tokenId);
  }
  const [fetched, info, books] = await Promise.all([
    fetchLeaderPositions(conditions),
    getMarketInfo(
      db,
      exits.map((t) => t.conditionId),
    ),
    mapSettled([...tokens], (id) => getBook(id)),
  ]);

  for (const t of exits) {
    const position = openCopy(state, t.wallet, t.tokenId);
    if (!position || fetched.failed.has(t.wallet)) continue;
    const market = info.get(t.conditionId) ?? null;
    // Not listed (the endpoint may still lag): their size now by our records, which
    // already include every trade of theirs, so nothing is applied on top.
    const listed = fetched.positions.get(heldKey(t.wallet, t.tokenId));
    const pos = listed
      ? await catchUpSnapshot(db, ctx, t.wallet, t.tokenId, listed, fillIds)
      : { size: await recordedSize(db, ctx, position), lastEventAt: Number.MAX_SAFE_INTEGER };
    const decision = decideSell({
      trade: t,
      ourShares: position.shares,
      leaderSoldFraction: leaderSoldFraction(t, fills, pos),
      book: books.get(t.tokenId) ?? null,
      feeRate: market?.takerFeeRate,
      cfg,
    });
    const hedgeExit =
      decision.action === "sell"
        ? planHedgeExit(state, position, decision.fraction, books, cfg, market?.takerFeeRate ?? 0)
        : null;
    const ids = t.ids ?? [t.id];
    const sold = await db.transaction(async (tx) => {
      const base = {
        retries: sql`${signals.retries} + 1`,
        details: decision.action === "skip" ? (decision.details ?? null) : decision.details,
      };
      const set =
        decision.action === "sell"
          ? {
              ...base,
              decision: "closed" as const,
              reasonCode: "sold" as const,
              reason: `Sold on re-check: ${reasonText(decision, ids.length)}`,
            }
          : decision.action === "skip"
            ? { ...base, reasonCode: decision.code, reason: decision.reason }
            : base;
      const updated = await tx
        .update(signals)
        .set(set)
        .where(and(inArray(signals.id, ids), eq(signals.decision, "skipped")))
        .returning({ id: signals.id });
      if (decision.action !== "sell" || !updated.some((r) => r.id === t.id)) return false;
      const [current] = await tx
        .select()
        .from(paperPositions)
        .where(eq(paperPositions.id, position.id));
      if (current?.status !== "open") return false;
      await applySell(tx, current, t, decision.fill);
      if (hedgeExit) {
        await applySell(
          tx,
          hedgeExit.hedge,
          { ...t, price: hedgeExit.fill.avgPrice },
          hedgeExit.fill,
        );
      }
      return true;
    });
    if (sold) {
      ctx.stats.closed++;
      ctx.stats.retried++;
      state = await loadAccountState(db, ctx.accountId);
    }
  }
}

/**
 * A big leader order often empties a thin book ("price moved"), and sellers come back
 * within minutes. Re-check those skips until they're older than maxSignalAgeSeconds.
 */
async function retrySkipped(db: Db, ctx: EngineCtx) {
  const { cfg } = ctx;
  const since = new Date((ctx.now - cfg.maxSignalAgeSeconds) * 1000);
  const rows = await db
    .select()
    .from(signals)
    .where(
      and(
        eq(signals.accountId, ctx.accountId),
        eq(signals.decision, "skipped"),
        eq(signals.side, "BUY"),
        inArray(signals.reasonCode, [...RETRYABLE_CODES]),
        gte(signals.leaderTs, since),
      ),
    )
    .orderBy(asc(signals.leaderTs))
    .limit(200);
  if (rows.length === 0) return;

  // A leader who already sold what they bought: buying it now would leave us holding a
  // position they exited, and no later sell would ever close it.
  const sells = await db
    .select({ wallet: signals.wallet, tokenId: signals.tokenId, ts: signals.leaderTs })
    .from(signals)
    .where(
      and(
        eq(signals.accountId, ctx.accountId),
        eq(signals.side, "SELL"),
        gte(signals.leaderTs, since),
      ),
    );
  const soldAfter = (r: (typeof rows)[number]) =>
    sells.some(
      (s) =>
        s.wallet === r.wallet && s.tokenId === r.tokenId && s.ts.getTime() > r.leaderTs.getTime(),
    );

  const trades = signalGroups(rows.filter((r) => ctx.weights.has(r.wallet) && !soldAfter(r)));
  if (trades.length === 0) return;

  const [info, startEquity] = await Promise.all([
    getMarketInfo(
      db,
      trades.map((t) => t.conditionId),
    ),
    startOfDayEquity(db, ctx.accountId, ctx.now * 1000),
  ]);
  const books = await mapSettled([...new Set(trades.map((t) => t.tokenId))], (id) => getBook(id));

  let state = await loadAccountState(db, ctx.accountId);
  for (const t of trades) {
    const market = info.get(t.conditionId) ?? null;
    const exp = exposure(state, t.conditionId, t.wallet);
    const decision = decideBuy({
      now: ctx.now,
      trade: t,
      market,
      book: books.get(t.tokenId) ?? null,
      equity: state.equity,
      cash: state.cash,
      leaderTypicalUsd: ctx.typicalStakes.get(t.wallet) ?? null,
      weight: ctx.weights.get(t.wallet) ?? 1,
      marketExposure: exp.market,
      traderExposure: exp.trader,
      dailyLossPct: lossFraction(startEquity, state.equity),
      positionBuys: await positionBuys(db, state, cfg, t),
      cfg,
    });
    const ids = t.ids ?? [t.id];
    const copied = await db.transaction(async (tx) => {
      const base = {
        retries: sql`${signals.retries} + 1`,
        details: decision.action === "skip" ? (decision.details ?? null) : decision.details,
      };
      const set =
        decision.action === "buy"
          ? {
              ...base,
              decision: "copied" as const,
              reasonCode: "bought" as const,
              reason: `Copied on re-check: ${reasonText(decision, ids.length)}`,
            }
          : decision.action === "skip"
            ? { ...base, reasonCode: decision.code, reason: decision.reason }
            : base;
      const updated = await tx
        .update(signals)
        .set(set)
        .where(and(inArray(signals.id, ids), eq(signals.decision, "skipped")))
        .returning({ id: signals.id });
      if (decision.action !== "buy" || !market || !updated.some((r) => r.id === t.id)) {
        return false;
      }
      await applyBuy(tx, ctx.accountId, t, market, decision.fill);
      return true;
    });
    if (copied) {
      ctx.stats.copied++;
      ctx.stats.retried++;
      state = await loadAccountState(db, ctx.accountId);
    }
  }
}

// ---------------------------------------------------------------------------
// Settlement, marking, hedging
// ---------------------------------------------------------------------------

/** Settle resolved markets at $1/$0, refresh prices of the rest, then auto-hedge. */
async function settleAndMark(db: Db, ctx: EngineCtx) {
  const open = await db
    .select()
    .from(paperPositions)
    .where(and(eq(paperPositions.accountId, ctx.accountId), eq(paperPositions.status, "open")));
  if (open.length === 0) return;

  const info = await getMarketInfo(
    db,
    open.map((p) => p.conditionId),
  );
  const live: typeof open = [];
  for (const p of open) {
    const m = info.get(p.conditionId);
    const payout = m ? payoutPerShare(m, p.tokenId) : null;
    if (payout !== null) {
      await db.transaction((tx) => settlePosition(tx, p, payout));
      ctx.stats.settled++;
    } else {
      live.push(p);
    }
  }
  if (live.length === 0) return;

  const mids = await getMidpoints(live.map((p) => p.tokenId));
  for (const p of live) {
    const mid = mids.get(p.tokenId);
    if (mid === undefined) continue;
    p.currentPrice = mid;
    await db
      .update(paperPositions)
      .set({ currentPrice: mid, updatedAt: new Date() })
      .where(eq(paperPositions.id, p.id));
  }

  if (ctx.cfg.autoHedge === "off") return;
  const hedged = new Set(live.filter((p) => p.kind === "hedge").map((p) => p.hedgeOf));
  for (const p of live) {
    if (p.kind !== "copy" || hedged.has(p.id) || p.costBasis <= 0) continue;
    // Never spend more on a trader who is no longer followed (manual hedges still work).
    if (!ctx.weights.has(p.sourceWallet)) continue;
    const value = p.shares * (p.currentPrice ?? p.avgPrice);
    const loss = (p.costBasis - value) / p.costBasis;
    if (loss < ctx.cfg.hedgeTriggerLossPct) continue;
    try {
      const res = await executeHedge(db, ctx.accountId, p.id, ctx.cfg.autoHedge, ctx.cfg);
      if (res.ok) ctx.stats.hedged++;
    } catch (err) {
      ctx.stats.errors.push(`hedge ${p.id}: ${errMsg(err)}`);
    }
  }
}

export interface HedgeQuotes {
  ok: boolean;
  message?: string;
  position?: PaperPosition;
  opposite?: { tokenId: string; outcome: string | null };
  lock?: HedgeQuote;
  breakeven?: HedgeQuote;
  /** The most a hedge may cost right now. */
  maxCost?: number;
  minOrderSize?: number;
}

/** Live hedge quotes (both modes) for one copied position. Nothing is bought. */
export async function quoteHedge(
  db: Db,
  accountId: number,
  positionId: number,
  cfg: RiskConfig,
  opts: { maxCost?: number } = {},
): Promise<HedgeQuotes> {
  const [position] = await db
    .select()
    .from(paperPositions)
    .where(and(eq(paperPositions.id, positionId), eq(paperPositions.accountId, accountId)));
  if (!position || position.status !== "open")
    return { ok: false, message: "Position is not open" };
  if (position.kind !== "copy") return { ok: false, message: "Hedges can't be hedged" };
  const [existing] = await db
    .select({ id: paperPositions.id })
    .from(paperPositions)
    .where(and(eq(paperPositions.hedgeOf, position.id), eq(paperPositions.status, "open")));
  if (existing) return { ok: false, message: "Already hedged", position };

  const market = (await getMarketInfo(db, [position.conditionId])).get(position.conditionId);
  const opposite = market
    ? oppositeToken(market.tokenIds, market.outcomes, position.tokenId)
    : null;
  if (!market || !opposite) {
    return { ok: false, message: "Only two-outcome markets can be hedged", position };
  }
  if (market.closed) return { ok: false, message: "Market is closed", position };
  const [book, state] = await Promise.all([
    getBook(opposite.tokenId),
    loadAccountState(db, accountId),
  ]);
  const maxCost = Math.max(
    0,
    Math.min(opts.maxCost ?? state.equity * cfg.hedgeMaxCostPct, state.cash),
  );
  const common = {
    shares: position.shares,
    costBasis: position.costBasis,
    realizedPnl: position.realizedPnl,
    asks: book.asks,
    feeBps: cfg.takerFeeBps,
    feeRate: market.takerFeeRate ?? 0,
    maxCost,
    maxPrice: cfg.hedgeMaxPrice,
  };
  return {
    ok: true,
    position,
    opposite,
    lock: planHedge({ ...common, mode: "lock" }),
    breakeven: planHedge({ ...common, mode: "breakeven" }),
    maxCost,
    minOrderSize: book.minOrderSize,
  };
}

/** Buy the other side of a copied position (paper). Used by auto-hedge and the admin. */
export async function executeHedge(
  db: Db,
  accountId: number,
  positionId: number,
  mode: HedgeMode,
  cfg: RiskConfig,
  opts: { maxCost?: number } = {},
): Promise<{ ok: boolean; message: string; quote?: HedgeQuote }> {
  const q = await quoteHedge(db, accountId, positionId, cfg, opts);
  if (!q.ok || !q.position || !q.opposite)
    return { ok: false, message: q.message ?? "Can't hedge" };
  const quote = mode === "lock" ? q.lock! : q.breakeven!;
  if (!quote.ok || !quote.fill) return { ok: false, message: quote.reason ?? "Can't hedge", quote };
  if (quote.shares < (q.minOrderSize ?? 0)) {
    return { ok: false, message: "Hedge is below the exchange's minimum order", quote };
  }
  const p = q.position;
  const market = (await getMarketInfo(db, [p.conditionId])).get(p.conditionId)!;
  const fill = quote.fill;
  const bought = await db.transaction(async (tx) => {
    // Re-check under a row lock: the copy may have closed, or been hedged, since the quote.
    const [copy] = await tx
      .select()
      .from(paperPositions)
      .where(eq(paperPositions.id, p.id))
      .for("update");
    const [hedged] = await tx
      .select({ id: paperPositions.id })
      .from(paperPositions)
      .where(and(eq(paperPositions.hedgeOf, p.id), eq(paperPositions.status, "open")));
    if (copy?.status !== "open" || hedged) return false;
    await applyBuy(
      tx,
      accountId,
      {
        id: `hedge:${p.id}`,
        wallet: p.sourceWallet,
        ts: Math.floor(Date.now() / 1000),
        conditionId: p.conditionId,
        tokenId: q.opposite!.tokenId,
        side: "BUY",
        price: quote.avgPrice,
        size: quote.shares,
        usdc: quote.cost,
        outcome: q.opposite!.outcome,
        title: p.title,
        slug: p.slug,
        icon: p.image,
      },
      market,
      fill,
      { kind: "hedge", hedgeOf: p.id, outcome: q.opposite!.outcome },
    );
    return true;
  });
  if (!bought) return { ok: false, message: "The position changed; quote the hedge again" };
  return {
    ok: true,
    message: `Hedged: bought ${quote.shares.toFixed(1)} ${q.opposite.outcome ?? "opposite"} shares for $${quote.cost.toFixed(2)}`,
    quote,
  };
}

export interface ExitResult {
  /** Positions (copies and their hedges) that sold, fully or in part. */
  sold: number;
  /** Positions still open afterwards (no buyers, market closed, or only partly sold). */
  left: number;
  proceeds: number;
  pnl: number;
  /** Set when nothing could be tried (engine busy). */
  skipped?: string;
}

/**
 * Sell every open position copied from `wallet` (copies and their hedges) at the best bids
 * right now. Used when the admin hides a trader. Anything that can't be sold stays open:
 * the engine keeps mirroring the trader's sells for it, and settlement pays it out otherwise.
 */
export async function exitTrader(
  rawDb: Db,
  wallet: string,
  nowMs = Date.now(),
): Promise<ExitResult> {
  const out: ExitResult = { sold: 0, left: 0, proceeds: 0, pnl: 0 };
  const lease = await waitForLease(rawDb, 30);
  if (!lease) return { ...out, skipped: "Engine busy" };
  const db = lease.guard(rawDb);
  try {
    const [cfg, account] = await Promise.all([getRiskConfig(db), ensureDefaultAccount(db)]);
    const open = await db
      .select()
      .from(paperPositions)
      .where(
        and(
          eq(paperPositions.accountId, account.id),
          eq(paperPositions.sourceWallet, wallet),
          eq(paperPositions.status, "open"),
        ),
      );
    if (open.length === 0) return out;
    const [info, books] = await Promise.all([
      getMarketInfo(
        db,
        open.map((p) => p.conditionId),
      ),
      mapSettled([...new Set(open.map((p) => p.tokenId))], (id) => getBook(id)),
    ]);
    const ts = Math.floor(nowMs / 1000);
    for (const p of open) {
      const market = info.get(p.conditionId);
      const book = books.get(p.tokenId);
      // Closed markets are paid out by settlement, not sold.
      if (!market || market.closed || !book || book.bids.length === 0) {
        out.left++;
        continue;
      }
      const fill = simulateSell(book.bids, p.shares, 0, cfg.takerFeeBps, market.takerFeeRate ?? 0);
      if (fill.shares <= 0) {
        out.left++;
        continue;
      }
      const pnl = await db.transaction((tx) =>
        applySell(
          tx,
          p,
          {
            id: `exit:${p.id}:${ts}`,
            wallet,
            ts,
            conditionId: p.conditionId,
            tokenId: p.tokenId,
            side: "SELL",
            price: book.bids[0].price,
            size: fill.shares,
            usdc: fill.notional,
            outcome: p.outcome,
            title: p.title,
            slug: p.slug,
            icon: p.image,
          },
          fill,
        ),
      );
      out.sold++;
      out.proceeds += fill.notional;
      out.pnl += pnl;
      if (fill.shares < p.shares - 1e-6) out.left++;
    }
    if (out.sold > 0) await maybeSnapshot(db, account.id, 0);
    return out;
  } finally {
    await lease.release();
  }
}
