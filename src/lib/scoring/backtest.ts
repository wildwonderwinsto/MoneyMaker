/**
 * Walk-forward backtest of the selection method (pure, no I/O).
 *
 * For each month: score every trader using ONLY information available before the month
 * starts (positions whose market ended earlier, PnL series up to then), pick the top-K,
 * then "copy" the bets those traders opened during the month with extra slippage.
 * Baseline: the naive approach — copy last month's top-K by realized profit.
 *
 * Known bias (disclosed in the UI): the candidate pool is today's leaderboard, which
 * favors traders who survived. Strategy and baseline share that bias, so the comparison
 * between them is the meaningful number, not the absolute return.
 */
import type { ScoringConfig } from "./config";
import { computeMetrics, type MetricsInput, type PositionRecord } from "./metrics";
import { scoreTrader } from "./score";
import { benjaminiHochbergThreshold, mean } from "./stats";

const DAY = 86_400;

export interface BacktestParams {
  months: number;
  topK: number;
  /** Extra price paid per copied entry (price points). */
  copySlippage: number;
  startingEquity: number;
  /** Simulations per trader per month (lower than live scoring for speed). */
  simulations: number;
}

export const DEFAULT_BACKTEST: BacktestParams = {
  months: 6,
  topK: 10,
  copySlippage: 0.01,
  startingEquity: 1000,
  simulations: 300,
};

export interface BacktestMonth {
  month: string;
  strategyPicks: string[];
  baselinePicks: string[];
  strategyReturn: number;
  baselineReturn: number;
  strategyBets: number;
  baselineBets: number;
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
  };
}

/** Return of copying one bet at a slightly worse price (equal $ stake per bet). */
export function copiedBetReturn(p: PositionRecord, slippage: number): number | null {
  const cost = p.sharesBought * p.avgPrice;
  if (cost <= 0 || p.avgPrice <= 0) return null;
  const pnl = p.realizedPnl + (p.closed ? 0 : p.unrealizedPnl);
  const leaderReturn = pnl / cost;
  const ours = (1 + leaderReturn) * (p.avgPrice / Math.min(0.999, p.avgPrice + slippage)) - 1;
  return Math.max(-1, ours);
}

const monthStart = (y: number, m: number) => Date.UTC(y, m, 1) / 1000;

/** Restrict a trader's data to what was knowable at `asOf`. */
export function asOf(input: MetricsInput, at: number): MetricsInput {
  return {
    ...input,
    now: at,
    copyReplays: null,
    positions: input.positions.filter((p) => (p.endAt ?? p.lastActivityAt ?? Infinity) < at),
    pnlSeries: input.pnlSeries.filter((pt) => pt.ts < at),
  };
}

function portfolioReturn(
  picks: string[],
  byWallet: Map<string, MetricsInput>,
  from: number,
  to: number,
  slippage: number,
) {
  let bets = 0;
  // Proportional copying: each leader's bets are weighted by the dollars they risked,
  // so a tiny long-shot can't dominate the result.
  const perTrader = picks.map((w) => {
    let staked = 0;
    let pnl = 0;
    for (const p of byWallet.get(w)?.positions ?? []) {
      if (p.firstEntryAt === null || p.firstEntryAt < from || p.firstEntryAt >= to) continue;
      const r = copiedBetReturn(p, slippage);
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

function maxDrawdown(curve: CurvePoint[]): number {
  let peak = -Infinity;
  let dd = 0;
  for (const pt of curve) {
    peak = Math.max(peak, pt.equity);
    dd = Math.max(dd, (peak - pt.equity) / peak);
  }
  return dd;
}

export function runBacktest(
  traders: MetricsInput[],
  baseCfg: ScoringConfig,
  params: BacktestParams,
  now: number,
): BacktestResult {
  const cfg = { ...baseCfg, simulations: params.simulations };
  const byWallet = new Map(traders.map((t) => [t.wallet, t]));
  const today = new Date(now * 1000);
  const months: BacktestMonth[] = [];

  // Last `months` complete calendar months.
  for (let k = params.months; k >= 1; k--) {
    const start = monthStart(today.getUTCFullYear(), today.getUTCMonth() - k);
    const end = monthStart(today.getUTCFullYear(), today.getUTCMonth() - k + 1);
    const label = new Date(start * 1000).toISOString().slice(0, 7);

    const formation = traders.map((t) => asOf(t, start));
    const metrics = formation.map((f) => computeMetrics(f, cfg));
    const pValues = metrics.map((m) => m.mcPValue).filter((p): p is number => p !== null);
    const ctx = {
      mcPThreshold: benjaminiHochbergThreshold(pValues, cfg.fdrQ),
      candidates: pValues.length,
    };

    // Copy-ROI can't be measured historically; its effect is modelled via slippage.
    const eligible = formation
      .map((f, i) => ({ wallet: f.wallet, result: scoreTrader(metrics[i], cfg, ctx) }))
      .filter((x) => x.result.checks.every((c) => c.ok || c.code === "copy_roi"))
      .sort((a, b) => b.result.score - a.result.score)
      .slice(0, params.topK)
      .map((x) => x.wallet);

    const baseline = traders
      .map((t) => ({
        wallet: t.wallet,
        pnl: t.positions
          .filter((p) => {
            const at = p.endAt ?? p.lastActivityAt ?? Infinity;
            return p.closed && at >= start - 30 * DAY && at < start;
          })
          .reduce((a, p) => a + p.realizedPnl, 0),
      }))
      .filter((x) => x.pnl > 0)
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, params.topK)
      .map((x) => x.wallet);

    const s = portfolioReturn(eligible, byWallet, start, end, params.copySlippage);
    const b = portfolioReturn(baseline, byWallet, start, end, params.copySlippage);
    months.push({
      month: label,
      strategyPicks: eligible,
      baselinePicks: baseline,
      strategyReturn: s.ret,
      baselineReturn: b.ret,
      strategyBets: s.bets,
      baselineBets: b.bets,
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
    },
  };
}
