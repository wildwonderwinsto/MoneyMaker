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
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import { cursors, follows, paperPositions, signals } from "@/lib/db/schema";
import { acquireLease, PROCESS_ID, releaseLease } from "@/lib/lease";
import { getBook, getMidpoints, type OrderBook } from "@/lib/polymarket/clob";
import {
  getActivity,
  getPortfolioValue,
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
  skip,
  type Decision,
  type LeaderTrade,
  type MarketInfo,
} from "./engine";
import { simulateSell, type Fill } from "./fillSim";
import { oppositeToken, planHedge, type HedgeMode, type HedgeQuote } from "./hedge";
import { getMarketInfo } from "./markets";

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

// Ticks take seconds now. A run killed mid-way (deploy, crash) blocks the engine for at most
// this long; graceful shutdowns release the lease right away (see runner.ts).
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
    usdc: a.usdc_size,
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
  stats: TickStats;
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
  db: Db,
  nowMs = Date.now(),
  phases: TickPhases = {},
): Promise<TickStats> {
  const doCopy = phases.copy ?? true;
  const doHousekeeping = phases.housekeeping ?? true;
  const started = Date.now();
  const stats = newStats("poll");
  if (!(await acquireLease(db, LEASE, LEASE_TTL_MS))) {
    return { ...stats, skipped: "Another engine run is in progress" };
  }
  try {
    const cfg = await getRiskConfig(db);
    const account = await ensureDefaultAccount(db);
    const now = Math.floor(nowMs / 1000);
    const leaders = await db.select().from(follows).where(eq(follows.enabled, true));
    stats.leaders = leaders.length;
    const ctx: EngineCtx = {
      accountId: account.id,
      cfg,
      now,
      weights: new Map(leaders.map((l) => [l.wallet, l.weight])),
      stats,
    };

    if (doCopy) {
      await pollLeaders(
        db,
        ctx,
        leaders.map((l) => l.wallet),
      );
      if (cfg.retrySkipped) {
        try {
          await retrySkipped(db, ctx);
        } catch (err) {
          stats.errors.push(`retry: ${errMsg(err)}`);
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
    await releaseLease(db, LEASE, PROCESS_ID);
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
  db: Db,
  trades: LeaderTrade[],
  nowMs = Date.now(),
): Promise<TickStats> {
  const started = Date.now();
  const stats = newStats("stream");
  let leased = false;
  for (let i = 0; i < 10 && !leased; i++) {
    leased = await acquireLease(db, LEASE, LEASE_TTL_MS);
    if (!leased) await sleep(500);
  }
  if (!leased) return { ...stats, skipped: "Engine busy; the next poll will pick these up" };
  try {
    const wallets = [...new Set(trades.map((t) => t.wallet))];
    const leaders = await db
      .select()
      .from(follows)
      .where(and(eq(follows.enabled, true), inArray(follows.wallet, wallets)));
    stats.leaders = leaders.length;
    if (leaders.length === 0) return stats;
    const cfg = await getRiskConfig(db);
    const account = await ensureDefaultAccount(db);
    const ctx: EngineCtx = {
      accountId: account.id,
      cfg,
      now: Math.floor(nowMs / 1000),
      weights: new Map(leaders.map((l) => [l.wallet, l.weight])),
      stats,
    };
    const ours = trades.filter((t) => ctx.weights.has(t.wallet));
    const fresh = await filterUnseen(db, ours, new Map());
    stats.newTrades = fresh.length;
    if (fresh.length) await processTrades(db, ctx, fresh, "stream");
    if (stats.copied + stats.closed > 0) await maybeSnapshot(db, account.id, 0);
  } finally {
    await releaseLease(db, LEASE, PROCESS_ID);
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
          type: "TRADE",
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
      if (!t) return;
      candidates.push(t);
      legacy.set(t.id, legacyTradeId(a));
    });
    maxTs.set(page.wallet, Math.max(...page.rows.map((a) => a.timestamp)));
  }

  // `start` is inclusive and the stream may have copied some already: skip known ids.
  const fresh = await filterUnseen(db, candidates, legacy);
  ctx.stats.newTrades += fresh.length;
  if (fresh.length) await processTrades(db, ctx, fresh, "poll");
  for (const [wallet, ts] of maxTs) await setCursor(db, wallet, ts);
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
 * trades after `trade` are undone, giving the size right after it. Pure (tested).
 */
export function leaderSoldFraction(
  trade: LeaderTrade,
  batch: LeaderTrade[],
  pos: LeaderPosition | undefined,
): number {
  const same = batch.filter((m) => m.wallet === trade.wallet && m.tokenId === trade.tokenId);
  let size = pos?.size ?? 0;
  if (pos && pos.lastEventAt !== null) {
    for (const m of same) if (m.ts > pos.lastEventAt) size += m.side === "BUY" ? m.size : -m.size;
  }
  size = Math.max(0, size);
  const idx = same.indexOf(trade);
  for (const m of same.slice(idx + 1)) size += m.side === "SELL" ? m.size : -m.size;
  size = Math.max(0, size);
  return trade.size / (size + trade.size);
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
) {
  const { cfg } = ctx;
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
  const portfolioWallets = new Set<string>();
  const sellConditions = new Map<string, Set<string>>();
  for (const t of merged) {
    if (t.side === "BUY" && buyMayCopy(t)) {
      bookTokens.add(t.tokenId);
      if (cfg.sizingMode === "proportional") portfolioWallets.add(t.wallet);
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
  const [books, portfolios, leaderPositions] = await Promise.all([
    mapSettled([...bookTokens], (id) => getBook(id)),
    mapSettled([...portfolioWallets], (w) => getPortfolioValue(w)),
    fetchLeaderPositions(sellConditions),
  ]);

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
        leaderPortfolioUsd: portfolios.get(t.wallet) ?? 0,
        weight: ctx.weights.get(t.wallet) ?? 1,
        marketExposure: exp.market,
        traderExposure: exp.trader,
        dailyLossPct: lossFraction(startEquity, state.equity),
        cfg,
      });
    } else {
      const position = openCopy(state, t.wallet, t.tokenId);
      if (!position) {
        decision = skip("No copied position to close", "no_position");
      } else {
        decision = decideSell({
          trade: t,
          ourShares: position.shares,
          leaderSoldFraction: leaderSoldFraction(
            t,
            merged,
            leaderPositions.get(`${t.wallet}|${t.tokenId}`),
          ),
          book: books.get(t.tokenId) ?? null,
          cfg,
        });
        if (decision.action === "sell") {
          hedgeExit = planHedgeExit(state, position, decision.fraction, books, cfg);
        }
      }
    }
    try {
      await recordDecision(db, ctx, t, originals, market, decision, source, hedgeExit);
    } catch (err) {
      ctx.stats.errors.push(`${t.wallet} ${t.id}: ${errMsg(err)}`);
      continue;
    }
    if (decision.action === "buy") ctx.stats.copied++;
    else if (decision.action === "sell") ctx.stats.closed++;
    else ctx.stats.ignored++;
    if (decision.action !== "skip") state = await loadAccountState(db, ctx.accountId);
  }
}

async function fetchLeaderPositions(byWallet: Map<string, Set<string>>) {
  const out = new Map<string, LeaderPosition>();
  await Promise.all(
    [...byWallet].map(async ([wallet, conditions]) => {
      const ids = [...conditions];
      for (let i = 0; i < ids.length; i += 20) {
        const res = await getPositions({ user: wallet, condition: ids.slice(i, i + 20) }).catch(
          () => null,
        );
        for (const p of res?.data ?? []) {
          out.set(`${wallet}|${p.token_id}`, {
            size: p.current_size,
            lastEventAt: p.last_event_at ?? null,
          });
        }
      }
    }),
  );
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
): HedgeExit | null {
  const hedge = openHedge(state, position.id);
  const book = hedge ? books.get(hedge.tokenId) : null;
  if (!hedge || !book || book.bids.length === 0) return null;
  const fill = simulateSell(book.bids, hedge.shares * fraction, 0, cfg.takerFeeBps);
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

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!ctx.weights.has(r.wallet)) continue;
    const key = r.groupId ?? r.id;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const trades: LeaderTrade[] = [...groups].map(([key, g]) => {
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
      side: "BUY",
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
  if (trades.length === 0) return;

  const [info, startEquity] = await Promise.all([
    getMarketInfo(
      db,
      trades.map((t) => t.conditionId),
    ),
    startOfDayEquity(db, ctx.accountId, ctx.now * 1000),
  ]);
  const [books, portfolios] = await Promise.all([
    mapSettled([...new Set(trades.map((t) => t.tokenId))], (id) => getBook(id)),
    cfg.sizingMode === "proportional"
      ? mapSettled([...new Set(trades.map((t) => t.wallet))], (w) => getPortfolioValue(w))
      : Promise.resolve(new Map<string, number | null>()),
  ]);

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
      leaderPortfolioUsd: portfolios.get(t.wallet) ?? 0,
      weight: ctx.weights.get(t.wallet) ?? 1,
      marketExposure: exp.market,
      traderExposure: exp.trader,
      dailyLossPct: lossFraction(startEquity, state.equity),
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
    if (m && m.winnerIndex !== null && m.tokenIds.length > 0) {
      const won = m.tokenIds[m.winnerIndex] === p.tokenId;
      await db.transaction((tx) => settlePosition(tx, p, won));
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
  await db.transaction(async (tx) => {
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
  });
  return {
    ok: true,
    message: `Hedged: bought ${quote.shares.toFixed(1)} ${q.opposite.outcome ?? "opposite"} shares for $${quote.cost.toFixed(2)}`,
    quote,
  };
}
