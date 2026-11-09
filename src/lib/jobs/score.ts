/**
 * Scoring job.
 * Stage 1: metrics for every backfilled candidate, Benjamini–Hochberg threshold across all
 *          of them, preliminary tiers.
 * Stage 2: for the shortlist only (expensive), replay recent BUYs as if copied
 *          `copyDelaySeconds` late using minute price history → copy-adjusted ROI.
 */
import { and, gte, inArray, isNotNull, sql } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import {
  markets,
  traderPnlDaily,
  traderPositions,
  traders,
  traderScores,
  traderTrades,
} from "@/lib/db/schema";
import { getMidpoints, getPriceHistory, type PricePoint } from "@/lib/polymarket/clob";
import { collect, getActivity, paginate, tradeIds, type Activity } from "@/lib/polymarket/data";
import {
  DEFAULT_TAKER_FEE_RATE,
  getMarketsByConditionIds,
  resolvedPayouts,
  takerFeeRate,
} from "@/lib/polymarket/gamma";
import type { ScoringConfig } from "@/lib/scoring/config";
import {
  computeMetrics,
  type CopyReplay,
  type MetricsInput,
  type PositionRecord,
  type TraderMetrics,
} from "@/lib/scoring/metrics";
import { scoreTrader, type ScoreResult } from "@/lib/scoring/score";
import { eBenjaminiHochbergThreshold } from "@/lib/scoring/stats";

import { chunk, mapPool, toDate, toEpoch } from "./util";

export interface ScoreOptions {
  shortlistSize: number;
  replaysPerTrader: number;
  /** Days of trade history fetched for copy replays. */
  replayLookbackDays: number;
  /**
   * Most trades fetched per trader for replays. The API returns newest first, so a low cap
   * silently shrinks the window: 2000 covered only the last 10–30 days for active traders.
   * 20k covers 90 days even at the bot limit (200 trades/day); a full 90 days for the most
   * active verified traders was ~6k trades, fetched in ~3 s (Nov 2026).
   */
  maxReplayTrades: number;
}

/** Raw trades kept per shortlisted trader (profile page); bounds Supabase storage. */
const STORED_TRADES = 2000;

export const DEFAULT_SCORE: ScoreOptions = {
  shortlistSize: 60,
  // 40 was too few to tell a copyable edge from noise; 150 keeps the daily job well
  // within its time budget (minute price history, rate-limited).
  replaysPerTrader: 150,
  replayLookbackDays: 90,
  maxReplayTrades: 20_000,
};

type PositionRow = typeof traderPositions.$inferSelect;

/**
 * DB row → scoring record. A position is finished once resolved or fully exited. The API's
 * CLOSED status counts as exited: it often leaves dust (a few hundredths of a share) that
 * would otherwise keep a large realized loss out of the score until the market ends.
 */
export function toPositionRecord(r: PositionRow): PositionRecord {
  const finished = r.won !== null || r.status === "CLOSED" || (r.size ?? 0) < 1e-6;
  return {
    conditionId: r.conditionId,
    tokenId: r.tokenId,
    eventId: r.eventId,
    category: r.category,
    avgPrice: r.avgPrice ?? 0,
    sharesBought: r.sharesBought ?? r.size ?? 0,
    // total PnL: realized + unrealized (an unredeemed loser is marked at 0).
    realizedPnl: (r.realizedPnl ?? 0) + (finished ? (r.unrealizedPnl ?? 0) : 0),
    unrealizedPnl: finished ? 0 : (r.unrealizedPnl ?? 0),
    closed: finished,
    won: r.won,
    firstEntryAt: toEpoch(r.firstEntryAt),
    lastActivityAt: toEpoch(r.lastActivityAt),
    endAt: toEpoch(r.endDate),
  };
}

/**
 * `k` items spread evenly over the whole list. Regression: a whole-number step (every
 * 1st/2nd/… item, then the first k) took only the newest k when there were fewer than 2k
 * items, e.g. 150 of 280 buys = just the last 10 days of a 90-day window. Pure (tested).
 */
export function evenSample<T>(items: T[], k: number): T[] {
  const n = Math.min(k, items.length);
  return Array.from({ length: n }, (_, i) => items[Math.floor((i * items.length) / n)]);
}

/** Our entry `delay` seconds after the leader, plus slippage; null if no nearby price. */
export function delayedEntryPrice(
  history: PricePoint[],
  ts: number,
  delay: number,
  slippage: number,
  toleranceSeconds = 900,
): number | null {
  const target = ts + delay;
  const pt = history.find((h) => h.t >= target && h.t <= target + toleranceSeconds);
  return pt ? Math.min(0.999, pt.p + slippage) : null;
}

export async function loadInputs(db: Db, wallets: string[], now: number) {
  const inputs = new Map<string, MetricsInput>();
  const meta = new Map<string, { category: string | null }>();
  for (const part of chunk(wallets, 50)) {
    const [positions, pnl, profiles] = await Promise.all([
      db.select().from(traderPositions).where(inArray(traderPositions.wallet, part)),
      db.select().from(traderPnlDaily).where(inArray(traderPnlDaily.wallet, part)),
      db.select().from(traders).where(inArray(traders.wallet, part)),
    ]);
    for (const p of profiles) {
      meta.set(p.wallet, { category: p.leaderboardCategory });
      inputs.set(p.wallet, {
        wallet: p.wallet,
        positions: [],
        pnlSeries: [],
        activity: {
          tradeCount: p.tradeCount,
          joinDate: toEpoch(p.joinedAt),
          lastTradeAt: toEpoch(p.lastTradeAt),
        },
        copyReplays: null,
        now,
        // Forward holdout: skill counts only bets opened since the first check (today, for a
        // wallet checked for the first time, so it starts as a Candidate).
        holdoutFrom: toEpoch(p.firstCheckedAt) ?? now,
      });
    }
    // When each market actually settled (the backtest must not know outcomes early).
    const settled = new Map<string, number | null>();
    for (const ids of chunk([...new Set(positions.map((r) => r.conditionId))], 1000)) {
      const rows = await db
        .select({ id: markets.conditionId, at: markets.resolvedAt })
        .from(markets)
        .where(inArray(markets.conditionId, ids));
      for (const m of rows) settled.set(m.id, toEpoch(m.at));
    }
    for (const r of positions) {
      // Unknown cost (shares from splits/conversions, see backfill): the API's realized P&L on
      // these doesn't reconcile with the wallet's own activity (live: $33.4k claimed on an
      // event that paid the wallet $17.6k in all), so they aren't scored at all.
      if (r.sharesBought === null) continue;
      inputs.get(r.wallet)?.positions.push({
        ...toPositionRecord(r),
        resolvedAt: settled.get(r.conditionId) ?? null,
      });
    }
    for (const r of pnl) {
      inputs
        .get(r.wallet)
        ?.pnlSeries.push({ ts: Date.parse(`${r.day}T00:00:00Z`) / 1000, pnl: r.pnl });
    }
  }
  return { inputs, meta };
}

async function buildCopyReplays(
  db: Db,
  wallet: string,
  cfg: ScoringConfig,
  opts: ScoreOptions,
  now: number,
): Promise<CopyReplay[]> {
  const start = Math.floor(now - opts.replayLookbackDays * 86_400);
  const trades: Activity[] = await collect(
    paginate((cursor) => getActivity({ user: wallet, type: "TRADE", start, cursor }), {
      maxItems: opts.maxReplayTrades,
    }),
  );

  // Keep the shortlisted trader's raw trades (used by the profile page and backtests).
  const valid = trades.filter(
    (t) => t.token_id && t.side && t.price !== null && t.price !== undefined,
  );
  const ids = tradeIds(valid);
  const rows = valid.map((t, i) => ({
    id: ids[i],
    wallet,
    ts: toDate(t.timestamp)!,
    conditionId: t.condition_id,
    tokenId: t.token_id!,
    side: t.side!,
    price: t.price!,
    size: t.size,
    usdcSize: t.usdc_size,
    outcome: t.outcome ?? null,
    outcomeIndex: t.outcome_index ?? null,
    title: t.title ?? null,
    slug: t.slug ?? null,
    transactionHash: t.transaction_hash ?? null,
  }));
  // Newest first, so this keeps the most recent trades.
  for (const part of chunk(rows.slice(0, STORED_TRADES), 500))
    await db.insert(traderTrades).values(part).onConflictDoNothing();

  // Only trades the copy engine would actually copy: big enough, sensible price, old
  // enough that the delayed entry price exists.
  const buys = rows.filter(
    (t) =>
      t.side === "BUY" &&
      t.usdcSize >= cfg.minReplayLeaderUsd &&
      t.price > cfg.minEntryPrice &&
      t.price < 0.97 &&
      toEpoch(t.ts)! < now - cfg.copyDelaySeconds - 900,
  );
  if (buys.length === 0) return [];
  const sample = evenSample(buys, opts.replaysPerTrader);
  const exits = leaderExits(rows);

  const marketsById = new Map(
    (await getMarketsByConditionIds(sample.map((s) => s.conditionId))).map((m) => [
      m.conditionId,
      m,
    ]),
  );
  const mids = await getMidpoints(sample.map((s) => s.tokenId));

  const replays = await mapPool(sample, 3, async (t): Promise<CopyReplay | null> => {
    const ts = toEpoch(t.ts)!;
    const history = await getPriceHistory(t.tokenId, {
      startTs: ts,
      endTs: ts + cfg.copyDelaySeconds + 900,
      fidelity: 1,
    }).catch(() => []);
    const delayedPrice = delayedEntryPrice(history, ts, cfg.copyDelaySeconds, cfg.copySlippage);
    if (delayedPrice === null) return null;

    const market = marketsById.get(t.conditionId);
    // Settled: $1 / $0, or $0.50 for a 50/50 resolution. Otherwise mark at the midpoint.
    const payouts = market ? resolvedPayouts(market) : null;
    let holdValue: number | undefined;
    if (payouts && t.outcomeIndex !== null) holdValue = payouts[t.outcomeIndex];
    else holdValue = mids.get(t.tokenId);
    if (holdValue === undefined) return null;
    // Copies take liquidity, so they pay the market's taker fee on entry and on any
    // mirrored sell. Redeeming a resolved market is free.
    const rate = market ? takerFeeRate(market) : DEFAULT_TAKER_FEE_RATE;
    const afterFee = (p: number, sign: 1 | -1) => p + sign * rate * p * (1 - p);
    // The engine mirrors sells: the part the leader sold exits near their sell price
    // (minus the same slippage); only the rest rides to resolution.
    const exit = exits.get(t.id);
    const exitValue = exit
      ? exit.soldFraction * afterFee(Math.max(0, exit.avgPrice - cfg.copySlippage), -1) +
        (1 - exit.soldFraction) * holdValue
      : holdValue;
    return {
      delayedPrice: afterFee(delayedPrice, 1),
      exitValue,
      weight: t.usdcSize,
      ts,
      // Neither settled nor sold by the leader: valued at today's price, not a final result.
      open: !payouts && (exit?.soldFraction ?? 0) < 0.98,
    };
  });
  return replays.filter((r): r is CopyReplay => r !== null);
}

interface TradeRow {
  id: string;
  ts: Date;
  tokenId: string;
  side: string;
  price: number;
  size: number;
}

/**
 * For each BUY: what share of the shares held at that point the leader later sold, and
 * at what average price. Shares are tracked first-in-first-out per token. Pure (tested).
 */
export function leaderExits(
  rows: TradeRow[],
): Map<string, { soldFraction: number; avgPrice: number }> {
  const out = new Map<string, { soldFraction: number; avgPrice: number }>();
  const byToken = new Map<string, TradeRow[]>();
  for (const r of rows) byToken.set(r.tokenId, [...(byToken.get(r.tokenId) ?? []), r]);
  for (const list of byToken.values()) {
    list.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    const lots: Array<{ id: string; size: number; left: number; proceeds: number }> = [];
    for (const r of list) {
      if (r.side === "BUY") {
        lots.push({ id: r.id, size: r.size, left: r.size, proceeds: 0 });
        continue;
      }
      let toSell = r.size;
      for (const lot of lots) {
        if (toSell <= 1e-9) break;
        const take = Math.min(lot.left, toSell);
        lot.left -= take;
        lot.proceeds += take * r.price;
        toSell -= take;
      }
    }
    for (const lot of lots) {
      const sold = lot.size - lot.left;
      if (sold > 1e-9 && lot.size > 0) {
        out.set(lot.id, { soldFraction: sold / lot.size, avgPrice: lot.proceeds / sold });
      }
    }
  }
  return out;
}

function scoreRow(wallet: string, m: TraderMetrics, r: ScoreResult, category: string | null) {
  return {
    wallet,
    computedAt: new Date(),
    tier: r.tier,
    score: r.score,
    passed: r.passed,
    nResolved: m.nResolved,
    nEvents: m.nEvents,
    winRate: m.winRate,
    expectedWinRate: m.expectedWinRate,
    zSkill: m.zSkill,
    roi: m.roi,
    roiShrunk: m.roiShrunk,
    totalPnl: m.totalPnl,
    topMarketShare: m.topMarketShare,
    top3Share: m.top3Share,
    profitableMonthsPct: m.profitableMonthsPct,
    maxDrawdown: m.maxDrawdown,
    sharpe: m.sharpe,
    copyAdjRoi: m.copyAdjRoi,
    oosRoi: m.oosRoi,
    lastTradeAt: toDate(m.lastTradeAt),
    primaryCategory: m.primaryCategory ?? category,
    checks: r.checks,
    metrics: m as unknown as Record<string, unknown>,
  };
}

/** Days of earlier checks the luck test is pooled over (owner decision 2026-11-08). */
const POOLED_BH_DAYS = 30;

/**
 * Sequential skill evidence of wallets tested in the window (enough post-pick bets), except
 * those re-checked now. Testing more wallets means more lucky passes, so e-BH is applied
 * over everyone tested recently, not just today's batch. Rows scored before the sequential
 * test have no evidence stored; they count as 1 (no evidence), so they still count as tests.
 */
export async function recentTestedEValues(
  db: Db,
  since: Date,
  exclude: ReadonlySet<string>,
  minResolved: number,
): Promise<number[]> {
  const rows = await db
    .select({ wallet: traderScores.wallet, metrics: traderScores.metrics })
    .from(traderScores)
    .where(gte(traderScores.computedAt, since));
  return rows
    .filter((r) => !exclude.has(r.wallet))
    .map((r) => r.metrics as { eSkill?: number | null; nHoldout?: number | null })
    .filter((m) => (m.nHoldout ?? 0) >= minResolved)
    .map((m) => (typeof m.eSkill === "number" ? m.eSkill : 1));
}

export async function scoreAll(
  db: Db,
  baseCfg: ScoringConfig,
  opts: ScoreOptions,
  log: (m: string) => void,
  /** Wallets checked this run (the daily rotation). Omitted: every backfilled wallet. */
  only?: string[],
): Promise<{
  scored: number;
  shortlisted: number;
  verified: number;
  rejected: string[];
  candidates: string[];
}> {
  const now = Math.floor(Date.now() / 1000);
  const walletRows = await db
    .select({ wallet: traders.wallet })
    .from(traders)
    .where(
      only
        ? and(isNotNull(traders.lastBackfillAt), inArray(traders.wallet, only.length ? only : [""]))
        : isNotNull(traders.lastBackfillAt),
    );
  const wallets = walletRows.map((r) => r.wallet);
  const { inputs, meta } = await loadInputs(db, wallets, now);
  const earlier = await recentTestedEValues(
    db,
    new Date((now - POOLED_BH_DAYS * 86_400) * 1000),
    new Set(wallets),
    baseCfg.minResolved,
  );
  // The Monte Carlo luck p-value is kept for display only; it no longer decides a tier.
  const cfg = baseCfg;

  // Stage 1
  const metrics = new Map<string, TraderMetrics>();
  for (const [wallet, input] of inputs) metrics.set(wallet, computeMetrics(input, cfg));
  // Only wallets with enough post-pick bets are tested; the rest are Candidates.
  const eValues = [
    ...[...metrics.values()]
      .filter((m) => (m.nHoldout ?? Infinity) >= cfg.minResolved)
      .map((m) => m.eSkill),
    ...earlier,
  ];
  const ctx = {
    eThreshold: eBenjaminiHochbergThreshold(eValues, cfg.fdrQ),
    candidates: eValues.length,
  };
  log(
    `stage 1: ${metrics.size} traders, ${eValues.length} tested, e-BH bar ${ctx.eThreshold.toExponential(2)}`,
  );

  const prelim = new Map<string, ScoreResult>();
  for (const [wallet, m] of metrics) prelim.set(wallet, scoreTrader(m, cfg, ctx));

  // Stage 2: shortlist = everyone who would pass, be a Candidate or be watchlisted apart
  // from copy ROI.
  const shortlist = [...prelim.entries()]
    .filter(([, r]) => {
      const failed = r.checks.filter((c) => !c.ok && c.code !== "copy_roi");
      return failed.length === 0 || r.tier === "watchlist" || r.tier === "candidate";
    })
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, opts.shortlistSize)
    .map(([w]) => w);
  log(`stage 2: replaying copies for ${shortlist.length} shortlisted traders`);

  await mapPool(shortlist, 2, async (wallet) => {
    try {
      const replays = await buildCopyReplays(db, wallet, cfg, opts, now);
      const input = { ...inputs.get(wallet)!, copyReplays: replays };
      const m = computeMetrics(input, cfg);
      metrics.set(wallet, m);
      prelim.set(wallet, scoreTrader(m, cfg, ctx));
    } catch (err) {
      log(`copy replay failed for ${wallet}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  const rows = [...metrics.entries()].map(([wallet, m]) =>
    scoreRow(wallet, m, prelim.get(wallet)!, meta.get(wallet)?.category ?? null),
  );
  for (const part of chunk(rows, 200)) {
    await db
      .insert(traderScores)
      .values(part)
      .onConflictDoUpdate({
        target: traderScores.wallet,
        set: Object.fromEntries(
          Object.keys(part[0])
            .filter((k) => k !== "wallet")
            .map((k) => [
              k,
              sql.raw(`excluded.${k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`),
            ]),
        ),
      });
  }

  // When each wallet was checked: the first check starts its holdout (kept once set), the
  // last one drives the rotation's re-check cadence and cool-down.
  const checked = new Date(now * 1000);
  for (const part of chunk(wallets, 500)) {
    await db
      .update(traders)
      .set({
        firstCheckedAt: sql`coalesce(${traders.firstCheckedAt}, ${checked.toISOString()}::timestamptz)`,
        lastCheckedAt: checked,
        marketsAtCheck: sql`${traders.marketsTraded}`,
      })
      .where(inArray(traders.wallet, part));
  }

  const tiers = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.tier] = (acc[r.tier] ?? 0) + 1;
    return acc;
  }, {});
  log(`tiers: ${JSON.stringify(tiers)}`);
  return {
    scored: rows.length,
    shortlisted: shortlist.length,
    verified: (tiers.verified ?? 0) + (tiers.elite ?? 0),
    rejected: rows.filter((r) => r.tier === "rejected").map((r) => r.wallet),
    candidates: rows.filter((r) => r.tier === "candidate").map((r) => r.wallet),
  };
}
