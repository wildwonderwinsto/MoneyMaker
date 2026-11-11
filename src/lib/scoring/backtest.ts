/**
 * Walk-forward backtest of the selection method (pure, no I/O).
 *
 * For each month: score every trader using ONLY information available before the month
 * starts (positions whose market ended earlier, PnL series up to then), pick the top-K,
 * then "copy" the bets those traders opened during the month with extra slippage and
 * Polymarket's taker fee (copies always take liquidity).
 * Baseline: the naive approach — copy last month's top-K by realized profit.
 *
 * Known bias (disclosed in the UI): for months nobody recorded, the candidate pool is
 * today's leaderboard, which favors traders who survived — not necessarily equally for the
 * strategy and the baseline, so even the gap between them is only a rough guide (B10).
 * Months whose picks were recorded at the time (monthlySelections) avoid that selection
 * bias but remain estimates: partial pick-months are left out, held shares are valued at
 * rebuild time, bets are booked in the month they were opened, delay is modelled as slippage.
 */
import { DEFAULT_RISK_CONFIG } from "@/lib/copy/config";
import { DEFAULT_TAKER_FEE_RATE, isComboCondition } from "@/lib/polymarket/gamma";

import type { ScoringConfig } from "./config";
import { computeMetrics, type MetricsInput, type PositionRecord } from "./metrics";
import { scoreTrader } from "./score";
import { eBenjaminiHochbergThreshold, mean, simulationsFor } from "./stats";

const DAY = 86_400;

export interface BacktestParams {
  months: number;
  topK: number;
  /** Extra price paid per copied entry (price points). */
  copySlippage: number;
  /** Taker fee rate paid on each copied entry (fee = rate × p × (1 − p) per share). */
  takerFeeRate: number;
  startingEquity: number;
  /** Simulations per trader per month (lower than live scoring for speed). */
  simulations: number;
  /** The copy engine's own filters (B4): smaller leader bets and prices outside are skipped. */
  minLeaderUsd: number;
  /** The engine's "Skip games already in play": bets opened after kickoff aren't copied. */
  skipInPlay: boolean;
  minEntryPrice: number;
  maxEntryPrice: number;
}

export const DEFAULT_BACKTEST: BacktestParams = {
  months: 6,
  topK: 10,
  copySlippage: 0.01,
  // Positions carry no fee schedule; Polymarket's general rate (sports, culture, …).
  takerFeeRate: DEFAULT_TAKER_FEE_RATE,
  startingEquity: 1000,
  simulations: 300,
  minLeaderUsd: DEFAULT_RISK_CONFIG.minLeaderUsd,
  skipInPlay: DEFAULT_RISK_CONFIG.skipInPlay,
  minEntryPrice: DEFAULT_RISK_CONFIG.minEntryPrice,
  maxEntryPrice: DEFAULT_RISK_CONFIG.maxEntryPrice,
};

/** Picks recorded at the time (see db monthlySelections): point-in-time, no survivors-only pool. */
export interface RecordedPicks {
  strategy: string[];
  baseline: string[];
  /** Epoch seconds the picks were recorded; bets opened earlier in the month don't count. */
  from: number;
  /** Per method when they were recorded at different times (B1); falls back to `from`. */
  fromByMethod?: { strategy?: number; baseline?: number };
  /**
   * Rebuilt from each pick's own activity once the month was over (#9), keyed
   * "method:wallet". When every pick of a method has one, the month uses them instead of
   * /positions rows; partial ones (row cap cut the window) are left out.
   */
  results?: Record<string, PickMonthResult>;
}

export interface PickMonthResult {
  bets: number;
  staked: number;
  pnl: number;
  partial: boolean;
}

export interface BacktestMonth {
  month: string;
  strategyPicks: string[];
  baselinePicks: string[];
  strategyReturn: number;
  baselineReturn: number;
  strategyBets: number;
  baselineBets: number;
  /** Picks were recorded that month, not re-derived from today's pool. */
  recorded?: boolean;
  /** Recorded picks whose rebuilt month was partial (left out of the return). */
  partialPicks?: number;
  /** Recorded picks evaluated from their rebuilt activity. */
  rebuiltPicks?: number;
}

export interface CurvePoint {
  t: string;
  equity: number;
}

export interface BacktestResult {
  months: BacktestMonth[];
  strategyCurve: CurvePoint[];
  baselineCurve: CurvePoint[];
  summary: {
    strategyTotalReturn: number;
    baselineTotalReturn: number;
    strategyPositiveMonths: number;
    baselinePositiveMonths: number;
    strategyMaxDrawdown: number;
    baselineMaxDrawdown: number;
    avgStrategyPicks: number;
    /** Months whose picks were recorded at the time (free of survivorship bias). */
    recordedMonths: number;
    /** Rebuilt recorded pick-months, and how many of them were partial (#9). */
    recordedPickMonths: number;
    partialPickMonths: number;
  };
}

/** Return of copying one bet at a slightly worse price plus the taker fee (equal $ stake). */
export function copiedBetReturn(p: PositionRecord, slippage: number, feeRate = 0): number | null {
  const cost = p.sharesBought * p.avgPrice;
  if (cost <= 0 || p.avgPrice <= 0) return null;
  const pnl = p.realizedPnl + (p.closed ? 0 : p.unrealizedPnl);
  const leaderReturn = pnl / cost;
  const entry = Math.min(0.999, p.avgPrice + slippage);
  const allIn = entry + feeRate * entry * (1 - entry);
  // Sold before the market resolved (closed, no outcome): the copy sells too, a bit worse
  // than the leader and paying the taker fee (B7). Redeeming at resolution is free.
  if (p.closed && p.won === null) {
    const leaderExit = p.avgPrice * (1 + leaderReturn);
    const x = Math.max(0, leaderExit - slippage);
    return Math.max(-1, (x - feeRate * x * (1 - x)) / allIn - 1);
  }
  const ours = (1 + leaderReturn) * (p.avgPrice / allIn) - 1;
  return Math.max(-1, ours);
}

const monthStart = (y: number, m: number) => Date.UTC(y, m, 1) / 1000;

/** Restrict a trader's data to what was knowable at `asOf`. */
export function asOf(input: MetricsInput, at: number): MetricsInput {
  return {
    ...input,
    now: at,
    copyReplays: null,
    // Re-derived picks are formed at `at` from earlier data only; the live forward holdout
    // (bets since a wallet's first check, which is after `at`) doesn't apply here.
    holdoutFrom: null,
    // Today's last-trade time would leak the future; fall back to positions. The lifetime
    // trade count would too (B6): scale it to the share of positions opened before `at`.
    activity: {
      ...input.activity,
      lastTradeAt: null,
      tradeCount:
        input.activity.tradeCount === null || input.positions.length === 0
          ? input.activity.tradeCount
          : Math.round(
              (input.activity.tradeCount *
                input.positions.filter((p) => (p.firstEntryAt ?? Infinity) < at).length) /
                input.positions.length,
            ),
    },
    // Known by `at` once the trader's last event on it (sell, claim, settlement) came
    // before `at`. Market end dates are unreliable (placeholders, or before entry).
    positions: input.positions
      .filter((p) => (p.lastActivityAt ?? p.endAt ?? Infinity) < at)
      // Market settled after `at`: at formation it was an open bet — outcome unknown, and
      // its P&L (the API's figure is the final one) left out (#10).
      .map((p) =>
        (p.resolvedAt ?? -Infinity) >= at
          ? { ...p, won: null, closed: false, realizedPnl: 0, unrealizedPnl: 0 }
          : p,
      ),
    pnlSeries: input.pnlSeries.filter((pt) => pt.ts < at),
  };
}

function portfolioReturn(
  picks: string[],
  byWallet: Map<string, MetricsInput>,
  from: number,
  to: number,
  params: BacktestParams,
) {
  const { copySlippage: slippage, takerFeeRate: feeRate } = params;
  let bets = 0;
  // Proportional copying: each leader's bets are weighted by the dollars they risked,
  // so a tiny long-shot can't dominate the result.
  const perTrader = picks.map((w) => {
    let staked = 0;
    let pnl = 0;
    for (const p of byWallet.get(w)?.positions ?? []) {
      if (p.firstEntryAt === null || p.firstEntryAt < from || p.firstEntryAt >= to) continue;
      const stake = p.sharesBought * p.avgPrice;
      // Still open: today's price isn't a result, so it's left out (B8). Finished bets are
      // booked whole in the month they were opened.
      if (!p.closed) continue;
      // What the engine would skip (B4): too small a leader bet, or a price outside its band.
      if (stake < params.minLeaderUsd) continue;
      if (p.avgPrice < params.minEntryPrice || p.avgPrice > params.maxEntryPrice) continue;
      // Nor what it can't copy: combo bets, and sports bets opened once the game started.
      if (isComboCondition(p.conditionId)) continue;
      if (params.skipInPlay && p.gameStartAt != null && p.firstEntryAt >= p.gameStartAt) continue;
      const r = copiedBetReturn(p, slippage, feeRate);
      if (r === null) continue;
      staked += stake;
      pnl += stake * r;
      bets++;
    }
    return staked > 0 ? pnl / staked : 0; // idle capital earns 0
  });
  return { ret: perTrader.length ? mean(perTrader) : 0, bets };
}

export interface MethodResult {
  /** Equal-weight average of the counted picks' copy returns; null = nothing counted. */
  ret: number | null;
  picks: number;
  /** Picks counted (not partial). */
  counted: number;
  partial: number;
  bets: number;
}

/**
 * One method's month from its picks' rebuilt activity (#9): per pick, copy P&L over dollars
 * staked (0 if they opened nothing, like idle cash), averaged over picks. Partial pick-months
 * (the row cap cut the window) are left out. Shared by finished and in-progress months.
 */
export function methodResult(results: PickMonthResult[]): MethodResult {
  const full = results.filter((r) => !r.partial);
  return {
    ret: full.length ? mean(full.map((r) => (r.staked > 0 ? r.pnl / r.staked : 0))) : null,
    picks: results.length,
    counted: full.length,
    partial: results.length - full.length,
    bets: full.reduce((a, r) => a + r.bets, 0),
  };
}

/** A recorded month's return from its picks' rebuilt activity; null until all are rebuilt. */
function rebuiltReturn(
  rec: RecordedPicks | undefined,
  method: "strategy" | "baseline",
  picks: string[],
): { ret: number; bets: number; partial: number; rebuilt: number } | null {
  const results = picks.map((w) => rec?.results?.[`${method}:${w}`]);
  if (!picks.length || results.some((r) => r === undefined)) return null;
  const r = methodResult(results as PickMonthResult[]);
  return { ret: r.ret ?? 0, bets: r.bets, partial: r.partial, rebuilt: r.picks };
}

/** Recorded months needed before the record says anything (months swing a lot). */
export const MIN_RECORDED_MONTHS = 3;
/** Fewer strategy picks than this in a month = mostly one trader's luck. */
export const THIN_MONTH_PICKS = 3;

export interface Verdict {
  /** none: no recorded month yet; too_early: fewer than MIN_RECORDED_MONTHS. */
  kind: "none" | "too_early" | "ahead" | "behind" | "unclear";
  months: number;
  /** Average monthly gap, strategy minus baseline, over recorded months. */
  meanGap: number | null;
  /** 90% range for the average gap (t-distribution over months); null under 2 months. */
  low: number | null;
  high: number | null;
  /** Recorded months with fewer than THIN_MONTH_PICKS strategy picks. */
  thinMonths: number;
}

/** Two-sided 90% t critical values by degrees of freedom (1–30); 1.645 beyond. */
const T90 = [
  6.314, 2.92, 2.353, 2.132, 2.015, 1.943, 1.895, 1.86, 1.833, 1.812, 1.796, 1.782, 1.771, 1.761,
  1.753, 1.746, 1.74, 1.734, 1.729, 1.725, 1.721, 1.717, 1.714, 1.711, 1.708, 1.706, 1.703, 1.701,
  1.699, 1.697,
];

/**
 * What the track record can say. Only months whose picks were recorded at the time count:
 * re-derived months pick from today's stored traders (survivors), and the pool alone swung
 * the result by hundreds of points in a local check. The gap is paired by month.
 */
export function recordedVerdict(months: BacktestMonth[]): Verdict {
  const rec = months.filter((m) => m.recorded);
  const gaps = rec.map((m) => m.strategyReturn - m.baselineReturn);
  const n = gaps.length;
  const thinMonths = rec.filter((m) => m.strategyPicks.length < THIN_MONTH_PICKS).length;
  if (n === 0) {
    return { kind: "none", months: 0, meanGap: null, low: null, high: null, thinMonths };
  }
  const meanGap = mean(gaps);
  let low: number | null = null;
  let high: number | null = null;
  if (n >= 2) {
    const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - meanGap) ** 2, 0) / (n - 1));
    const half = (T90[n - 2] ?? 1.645) * (sd / Math.sqrt(n));
    low = meanGap - half;
    high = meanGap + half;
  }
  const kind =
    n < MIN_RECORDED_MONTHS ? "too_early" : low! > 0 ? "ahead" : high! < 0 ? "behind" : "unclear";
  return { kind, months: n, meanGap, low, high, thinMonths };
}

function maxDrawdown(curve: CurvePoint[]): number {
  let peak = -Infinity;
  let dd = 0;
  for (const pt of curve) {
    peak = Math.max(peak, pt.equity);
    dd = Math.max(dd, (peak - pt.equity) / peak);
  }
  return dd;
}

/**
 * Picks re-derived from today's pool as of `start` (used for months nobody recorded).
 * Only data from before `start` is used, but the pool itself is today's survivors.
 */
function simulatedPicks(
  traders: MetricsInput[],
  cfg: ScoringConfig,
  topK: number,
  start: number,
): { strategy: string[]; baseline: string[] } {
  const formation = traders.map((t) => asOf(t, start));
  const metrics = formation.map((f) => computeMetrics(f, cfg));
  const eValues = metrics.map((m) => m.eSkill);
  const ctx = {
    eThreshold: eBenjaminiHochbergThreshold(eValues, cfg.fdrQ),
    candidates: eValues.length,
  };

  // Copy-ROI can't be measured historically; its effect is modelled via slippage.
  const strategy = formation
    .map((f, i) => ({ wallet: f.wallet, result: scoreTrader(metrics[i], cfg, ctx) }))
    .filter((x) => x.result.checks.every((c) => c.ok || c.code === "copy_roi"))
    .sort((a, b) => b.result.score - a.result.score)
    .slice(0, topK)
    .map((x) => x.wallet);

  // Bot-free like the recorded baseline (B9): skip wallets over the trades-a-day limit at the
  // formation date (B6-scaled). Their recent redeem share isn't knowable historically.
  const bots = new Set(
    formation
      .filter((_, i) => (metrics[i].tradesPerDay ?? 0) > cfg.maxTradesPerDay)
      .map((f) => f.wallet),
  );
  const baseline = traders
    .filter((t) => !bots.has(t.wallet))
    .map((t) => ({
      wallet: t.wallet,
      pnl: t.positions
        .filter((p) => {
          const at = p.lastActivityAt ?? p.endAt ?? Infinity;
          return p.closed && at >= start - 30 * DAY && at < start;
        })
        .reduce((a, p) => a + p.realizedPnl, 0),
    }))
    .filter((x) => x.pnl > 0)
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, topK)
    .map((x) => x.wallet);
  return { strategy, baseline };
}

export function runBacktest(
  traders: MetricsInput[],
  baseCfg: ScoringConfig,
  params: BacktestParams,
  now: number,
  recorded: ReadonlyMap<string, RecordedPicks> = new Map(),
): BacktestResult {
  // Fewer simulations for speed, but never so few that the luck test can't be passed.
  const simulations = simulationsFor(traders.length, baseCfg.fdrQ, params.simulations);
  const cfg = { ...baseCfg, simulations };
  const byWallet = new Map(traders.map((t) => [t.wallet, t]));
  const today = new Date(now * 1000);
  const months: BacktestMonth[] = [];

  // Last `months` complete calendar months.
  for (let k = params.months; k >= 1; k--) {
    const start = monthStart(today.getUTCFullYear(), today.getUTCMonth() - k);
    const end = monthStart(today.getUTCFullYear(), today.getUTCMonth() - k + 1);
    const label = new Date(start * 1000).toISOString().slice(0, 7);

    const rec = recorded.get(label);
    const picks = rec
      ? {
          strategy: rec.strategy.slice(0, params.topK),
          baseline: rec.baseline.slice(0, params.topK),
        }
      : simulatedPicks(traders, cfg, params.topK, start);
    // Picks recorded mid-month only get credit for bets opened after they were known — each
    // method from its own recording time (B1).
    const fromOf = (m: "strategy" | "baseline") =>
      rec ? Math.max(start, rec.fromByMethod?.[m] ?? rec.from) : start;

    type MethodResult = { ret: number; bets: number; partial?: number; rebuilt?: number };
    const s: MethodResult =
      rebuiltReturn(rec, "strategy", picks.strategy) ??
      portfolioReturn(picks.strategy, byWallet, fromOf("strategy"), end, params);
    const b: MethodResult =
      rebuiltReturn(rec, "baseline", picks.baseline) ??
      portfolioReturn(picks.baseline, byWallet, fromOf("baseline"), end, params);
    months.push({
      month: label,
      strategyPicks: picks.strategy,
      baselinePicks: picks.baseline,
      strategyReturn: s.ret,
      baselineReturn: b.ret,
      strategyBets: s.bets,
      baselineBets: b.bets,
      recorded: !!rec,
      partialPicks: (s.partial ?? 0) + (b.partial ?? 0),
      rebuiltPicks: (s.rebuilt ?? 0) + (b.rebuilt ?? 0),
    });
  }

  const curve = (key: "strategyReturn" | "baselineReturn"): CurvePoint[] => {
    let equity = params.startingEquity;
    const pts: CurvePoint[] = [{ t: months[0]?.month ?? "", equity }];
    for (const m of months) {
      equity *= 1 + m[key];
      pts.push({ t: `${m.month}-end`, equity: Math.round(equity * 100) / 100 });
    }
    return pts;
  };
  const strategyCurve = curve("strategyReturn");
  const baselineCurve = curve("baselineReturn");
  const total = (c: CurvePoint[]) => c.at(-1)!.equity / params.startingEquity - 1;

  return {
    months,
    strategyCurve,
    baselineCurve,
    summary: {
      strategyTotalReturn: total(strategyCurve),
      baselineTotalReturn: total(baselineCurve),
      strategyPositiveMonths: months.filter((m) => m.strategyReturn > 0).length,
      baselinePositiveMonths: months.filter((m) => m.baselineReturn > 0).length,
      strategyMaxDrawdown: maxDrawdown(strategyCurve),
      baselineMaxDrawdown: maxDrawdown(baselineCurve),
      avgStrategyPicks: mean(months.map((m) => m.strategyPicks.length)),
      recordedMonths: months.filter((m) => m.recorded).length,
      recordedPickMonths: months.reduce((a, m) => a + (m.rebuiltPicks ?? 0), 0),
      partialPickMonths: months.reduce((a, m) => a + (m.partialPicks ?? 0), 0),
    },
  };
}
