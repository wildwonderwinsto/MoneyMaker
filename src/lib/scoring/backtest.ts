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
 * today's leaderboard, which favors traders who survived. Strategy and baseline share that
 * bias, so the comparison between them is the meaningful number, not the absolute return.
 * Months whose picks were recorded at the time (monthlySelections) have no such bias.
 */
import { DEFAULT_TAKER_FEE_RATE } from "@/lib/polymarket/gamma";

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
}

export const DEFAULT_BACKTEST: BacktestParams = {
  months: 6,
  topK: 10,
  copySlippage: 0.01,
  // Positions carry no fee schedule; Polymarket's general rate (sports, culture, …).
  takerFeeRate: DEFAULT_TAKER_FEE_RATE,
  startingEquity: 1000,
  simulations: 300,
};

/** Picks recorded at the time (see db monthlySelections): point-in-time, no survivors-only pool. */
export interface RecordedPicks {
  strategy: string[];
  baseline: string[];
  /** Epoch seconds the picks were recorded; bets opened earlier in the month don't count. */
  from: number;
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
    // Today's last-trade time would leak the future; fall back to positions.
    activity: { ...input.activity, lastTradeAt: null },
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
  slippage: number,
  feeRate: number,
) {
  let bets = 0;
  // Proportional copying: each leader's bets are weighted by the dollars they risked,
  // so a tiny long-shot can't dominate the result.
  const perTrader = picks.map((w) => {
    let staked = 0;
    let pnl = 0;
    for (const p of byWallet.get(w)?.positions ?? []) {
      if (p.firstEntryAt === null || p.firstEntryAt < from || p.firstEntryAt >= to) continue;
      const r = copiedBetReturn(p, slippage, feeRate);
      if (r === null) continue;
      const stake = p.sharesBought * p.avgPrice;
      staked += stake;
      pnl += stake * r;
      bets++;
    }
    return staked > 0 ? pnl / staked : 0; // idle capital earns 0
  });
  return { ret: perTrader.length ? mean(perTrader) : 0, bets };
}

/**
 * A recorded month's return from its picks' rebuilt activity (#9): per pick, copy P&L over
 * dollars staked (0 if they opened nothing, like idle cash), averaged over picks; partial
 * pick-months are left out. Null when not every pick has been rebuilt yet.
 */
function rebuiltReturn(
  rec: RecordedPicks | undefined,
  method: "strategy" | "baseline",
  picks: string[],
): { ret: number; bets: number; partial: number; rebuilt: number } | null {
  const results = picks.map((w) => rec?.results?.[`${method}:${w}`]);
  if (!picks.length || results.some((r) => r === undefined)) return null;
  const full = (results as PickMonthResult[]).filter((r) => !r.partial);
  return {
    ret: full.length ? mean(full.map((r) => (r.staked > 0 ? r.pnl / r.staked : 0))) : 0,
    bets: full.reduce((a, r) => a + r.bets, 0),
    partial: results.length - full.length,
    rebuilt: results.length,
  };
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

  const baseline = traders
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
    // Picks recorded mid-month only get credit for bets opened after they were known.
    const from = rec ? Math.max(start, rec.from) : start;

    const cost = [params.copySlippage, params.takerFeeRate] as const;
    type MethodResult = { ret: number; bets: number; partial?: number; rebuilt?: number };
    const s: MethodResult =
      rebuiltReturn(rec, "strategy", picks.strategy) ??
      portfolioReturn(picks.strategy, byWallet, from, end, ...cost);
    const b: MethodResult =
      rebuiltReturn(rec, "baseline", picks.baseline) ??
      portfolioReturn(picks.baseline, byWallet, from, end, ...cost);
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
