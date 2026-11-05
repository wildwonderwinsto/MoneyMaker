/**
 * Scoring job.
 * Stage 1: metrics for every backfilled candidate, Benjamini–Hochberg threshold across all
 *          of them, preliminary tiers.
 * Stage 2: for the shortlist only (expensive), replay recent BUYs as if copied
 *          `copyDelaySeconds` late using minute price history → copy-adjusted ROI.
 */
import { inArray, isNotNull, sql } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import {
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
  takerFeeRate,
  winnerIndex,
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
import { benjaminiHochbergThreshold } from "@/lib/scoring/stats";

import { chunk, mapPool, toDate, toEpoch } from "./util";

export interface ScoreOptions {
  shortlistSize: number;
  replaysPerTrader: number;
  /** Days of trade history fetched for copy replays. */
  replayLookbackDays: number;
}

export const DEFAULT_SCORE: ScoreOptions = {
  shortlistSize: 60,
  // 40 was too few to tell a copyable edge from noise; 150 keeps the daily job well
  // within its time budget (minute price history, rate-limited).
  replaysPerTrader: 150,
  replayLookbackDays: 90,
};

type PositionRow = typeof traderPositions.$inferSelect;

/** DB row → scoring record. A position is finished once resolved or fully exited. */
export function toPositionRecord(r: PositionRow): PositionRecord {
  const finished = r.won !== null || (r.size ?? 0) < 1e-6;
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
        activity: { tradeCount: p.tradeCount, joinDate: toEpoch(p.joinedAt) },
        copyReplays: null,
        now,
      });
    }
    for (const r of positions) inputs.get(r.wallet)?.positions.push(toPositionRecord(r));
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
      maxItems: 2000,
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
  for (const part of chunk(rows, 500))
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
  // Evenly spaced sample across the window.
  const step = Math.max(1, Math.floor(buys.length / opts.replaysPerTrader));
  const sample = buys.filter((_, i) => i % step === 0).slice(0, opts.replaysPerTrader);
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
    const winner = market ? winnerIndex(market) : null;
    let holdValue: number | undefined;
    if (winner !== null && t.outcomeIndex !== null) holdValue = winner === t.outcomeIndex ? 1 : 0;
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
    return { delayedPrice: afterFee(delayedPrice, 1), exitValue, weight: t.usdcSize };
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

export async function scoreAll(
  db: Db,
  cfg: ScoringConfig,
  opts: ScoreOptions,
  log: (m: string) => void,
): Promise<{ scored: number; shortlisted: number; verified: number; rejected: string[] }> {
  const now = Math.floor(Date.now() / 1000);
  const walletRows = await db
    .select({ wallet: traders.wallet })
    .from(traders)
    .where(isNotNull(traders.lastBackfillAt));
  const wallets = walletRows.map((r) => r.wallet);
  const { inputs, meta } = await loadInputs(db, wallets, now);

  // Stage 1
  const metrics = new Map<string, TraderMetrics>();
  for (const [wallet, input] of inputs) metrics.set(wallet, computeMetrics(input, cfg));
  const pValues = [...metrics.values()]
    .map((m) => m.mcPValue)
    .filter((p): p is number => p !== null);
  const ctx = {
    mcPThreshold: benjaminiHochbergThreshold(pValues, cfg.fdrQ),
    candidates: pValues.length,
  };
  log(`stage 1: ${metrics.size} traders, BH p-threshold ${ctx.mcPThreshold.toExponential(2)}`);

  const prelim = new Map<string, ScoreResult>();
  for (const [wallet, m] of metrics) prelim.set(wallet, scoreTrader(m, cfg, ctx));

  // Stage 2: shortlist = everyone who would pass or be watchlisted apart from copy ROI.
  const shortlist = [...prelim.entries()]
    .filter(([, r]) => {
      const failed = r.checks.filter((c) => !c.ok && c.code !== "copy_roi");
      return failed.length === 0 || r.tier === "watchlist";
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
  };
}
