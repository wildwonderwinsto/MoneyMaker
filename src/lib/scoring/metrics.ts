/**
 * Pure trader metrics. No I/O: inputs are plain records built from the database,
 * so every number here is unit-testable and reproducible.
 */
import type { ScoringConfig } from "./config";
import { hashString, mean, median, seededRandom, stdev, wilsonLowerBound } from "./stats";

const DAY = 86_400;

export interface PositionRecord {
  conditionId: string;
  tokenId: string;
  eventId: string | null;
  category: string | null;
  /** Volume-weighted average entry price (0–1). */
  avgPrice: number;
  /** Total shares ever bought. */
  sharesBought: number;
  realizedPnl: number;
  unrealizedPnl: number;
  /** True when the market has closed. */
  closed: boolean;
  /** Whether this outcome won; null while unresolved/unknown. */
  won: boolean | null;
  /** Epoch seconds. */
  firstEntryAt: number | null;
  lastActivityAt: number | null;
}

export interface PnlSeriesPoint {
  /** Epoch seconds. */
  ts: number;
  /** Cumulative PnL in USDC. */
  pnl: number;
}

export interface ActivityProfile {
  /** Lifetime number of fills. */
  tradeCount: number | null;
  /** Epoch seconds. */
  joinDate: number | null;
}

/** A leader BUY replayed as if we entered `copyDelaySeconds` later. */
export interface CopyReplay {
  /** Our hypothetical entry price after the delay. */
  delayedPrice: number;
  /** 1/0 if resolved, otherwise the latest price (mark-to-market). */
  exitValue: number;
}

export interface TraderMetrics {
  nClosed: number;
  nResolved: number;
  nEvents: number;
  totalCost: number;
  totalPnl: number;
  winRate: number | null;
  winRateLowerBound: number | null;
  /** Fraction of resolved bets that won vs. what entry prices implied. */
  resolvedWinRate: number | null;
  expectedWinRate: number | null;
  zSkill: number | null;
  /** Mean (outcome − entry price) per resolved bet: edge in probability points. */
  edgePerBet: number | null;
  /** Dollar-weighted Monte Carlo p-value: P(random outcomes ≥ actual PnL). */
  mcPValue: number | null;
  roi: number | null;
  roiShrunk: number | null;
  topMarketShare: number | null;
  top3Share: number | null;
  pnlExTop3: number;
  months: number;
  profitableMonthsPct: number | null;
  maxDrawdown: number;
  recoveryFactor: number | null;
  sharpe: number | null;
  tradesPerDay: number | null;
  bothSidesRatio: number;
  medianHoldHours: number | null;
  oosRoi: number | null;
  oosPnl: number | null;
  copyAdjRoi: number | null;
  nCopyReplays: number;
  lastTradeAt: number | null;
  daysSinceTrade: number | null;
  primaryCategory: string | null;
  monthlyPnl: Array<{ month: string; pnl: number }>;
}

const cost = (p: PositionRecord) => p.sharesBought * p.avgPrice;

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

export interface SkillResult {
  n: number;
  wins: number;
  expectedWins: number;
  z: number | null;
  edgePerBet: number | null;
}

/**
 * Calibration-adjusted skill: compare actual wins with the wins implied by entry prices.
 * Under "no skill" each bet wins with probability p (its price), so
 * wins ~ Poisson-binomial with mean Σp and variance Σp(1−p).
 */
export function skillZ(positions: PositionRecord[], cfg: ScoringConfig): SkillResult {
  const bets = positions.filter(
    (p) => p.won !== null && p.avgPrice >= cfg.minEntryPrice && p.avgPrice <= cfg.maxEntryPrice,
  );
  const wins = bets.filter((p) => p.won).length;
  const expectedWins = bets.reduce((a, p) => a + p.avgPrice, 0);
  const variance = bets.reduce((a, p) => a + p.avgPrice * (1 - p.avgPrice), 0);
  return {
    n: bets.length,
    wins,
    expectedWins,
    z: variance > 0 ? (wins - expectedWins) / Math.sqrt(variance) : null,
    edgePerBet: bets.length ? mean(bets.map((p) => (p.won ? 1 : 0) - p.avgPrice)) : null,
  };
}

/**
 * Outcome-randomization test (dollar-weighted, robust to fat tails): re-draw every
 * resolved outcome from its entry price and count how often random luck matches the
 * trader's hold-to-resolution PnL. Deterministically seeded per wallet.
 */
export function monteCarloPValue(
  positions: PositionRecord[],
  cfg: ScoringConfig,
  seedKey: string,
): number | null {
  const bets = positions.filter(
    (p) => p.won !== null && p.avgPrice >= cfg.minEntryPrice && p.avgPrice <= cfg.maxEntryPrice,
  );
  if (bets.length === 0) return null;
  const prices = bets.map((p) => p.avgPrice);
  const shares = bets.map((p) => p.sharesBought);
  const actual = bets.reduce((a, p, i) => a + shares[i] * ((p.won ? 1 : 0) - prices[i]), 0);

  const rand = seededRandom(hashString(seedKey));
  let atLeast = 0;
  for (let s = 0; s < cfg.simulations; s++) {
    let sim = 0;
    for (let i = 0; i < prices.length; i++) {
      sim += shares[i] * ((rand() < prices[i] ? 1 : 0) - prices[i]);
    }
    if (sim >= actual) atLeast++;
  }
  return (atLeast + 1) / (cfg.simulations + 1);
}

// ---------------------------------------------------------------------------
// Concentration (one-hit-wonder test)
// ---------------------------------------------------------------------------

export function concentration(positions: PositionRecord[]) {
  // Aggregate per market (condition) so both legs of one market count once.
  const byMarket = new Map<string, number>();
  for (const p of positions) {
    byMarket.set(p.conditionId, (byMarket.get(p.conditionId) ?? 0) + p.realizedPnl);
  }
  const pnls = [...byMarket.values()].sort((a, b) => b - a);
  const gross = pnls.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const net = pnls.reduce((a, b) => a + b, 0);
  const top = (k: number) =>
    pnls
      .slice(0, k)
      .filter((x) => x > 0)
      .reduce((a, b) => a + b, 0);
  return {
    topMarketShare: gross > 0 ? top(1) / gross : null,
    top3Share: gross > 0 ? top(3) / gross : null,
    pnlExTop3: net - top(3),
  };
}

// ---------------------------------------------------------------------------
// Consistency (from the cumulative PnL series)
// ---------------------------------------------------------------------------

export function monthlyPnl(series: PnlSeriesPoint[]): Array<{ month: string; pnl: number }> {
  const sorted = [...series].sort((a, b) => a.ts - b.ts);
  const monthEnd = new Map<string, number>();
  for (const pt of sorted) monthEnd.set(new Date(pt.ts * 1000).toISOString().slice(0, 7), pt.pnl);
  const out: Array<{ month: string; pnl: number }> = [];
  let prev = 0;
  for (const [month, value] of monthEnd) {
    out.push({ month, pnl: value - prev });
    prev = value;
  }
  return out;
}

export function drawdownStats(series: PnlSeriesPoint[]) {
  const sorted = [...series].sort((a, b) => a.ts - b.ts);
  let peak = 0;
  let maxDrawdown = 0;
  for (const pt of sorted) {
    peak = Math.max(peak, pt.pnl);
    maxDrawdown = Math.max(maxDrawdown, peak - pt.pnl);
  }
  const final = sorted.at(-1)?.pnl ?? 0;
  const recoveryFactor =
    sorted.length === 0 ? null : maxDrawdown > 0 ? final / maxDrawdown : final > 0 ? 99 : 0;

  const daily = sorted.slice(1).map((pt, i) => pt.pnl - sorted[i].pnl);
  const sd = stdev(daily);
  const sharpe = daily.length >= 10 && sd > 0 ? (mean(daily) / sd) * Math.sqrt(365) : null;
  return {
    maxDrawdown,
    recoveryFactor: recoveryFactor === null ? null : Math.min(99, recoveryFactor),
    sharpe,
  };
}

// ---------------------------------------------------------------------------
// Copyability
// ---------------------------------------------------------------------------

/** Equal-weight ROI of replayed copies (each copy stakes $1 at the delayed price). */
export function copyAdjustedRoi(replays: CopyReplay[]): number | null {
  const valid = replays.filter((r) => r.delayedPrice > 0 && r.delayedPrice < 0.99);
  if (valid.length === 0) return null;
  return mean(valid.map((r) => (r.exitValue - r.delayedPrice) / r.delayedPrice));
}

export function bothSidesRatio(positions: PositionRecord[]): number {
  const tokensByCondition = new Map<string, Set<string>>();
  for (const p of positions) {
    const set = tokensByCondition.get(p.conditionId) ?? new Set<string>();
    set.add(p.tokenId);
    tokensByCondition.set(p.conditionId, set);
  }
  if (tokensByCondition.size === 0) return 0;
  const both = [...tokensByCondition.values()].filter((s) => s.size > 1).length;
  return both / tokensByCondition.size;
}

// ---------------------------------------------------------------------------
// All metrics
// ---------------------------------------------------------------------------

export interface MetricsInput {
  wallet: string;
  positions: PositionRecord[];
  pnlSeries: PnlSeriesPoint[];
  activity: ActivityProfile;
  copyReplays: CopyReplay[] | null;
  /** Epoch seconds; injectable for tests. */
  now: number;
}

export function computeMetrics(input: MetricsInput, cfg: ScoringConfig): TraderMetrics {
  const { positions, pnlSeries, activity, now } = input;
  const closed = positions.filter((p) => p.closed);
  const resolved = positions.filter((p) => p.won !== null);

  const totalCost = closed.reduce((a, p) => a + cost(p), 0);
  const totalPnl = closed.reduce((a, p) => a + p.realizedPnl, 0);
  const roi = totalCost > 0 ? totalPnl / totalCost : null;
  const nClosed = closed.length;
  const winners = closed.filter((p) => p.realizedPnl > 0).length;

  const skill = skillZ(positions, cfg);
  const conc = concentration(closed);
  const months = monthlyPnl(pnlSeries);
  const activeMonths = months.filter((m) => Math.abs(m.pnl) > 1e-6);
  const dd = drawdownStats(pnlSeries);

  // Out-of-sample: positions that finished within the last `oosDays`.
  const cutoff = now - cfg.oosDays * DAY;
  const oos = closed.filter((p) => (p.lastActivityAt ?? 0) >= cutoff);
  const oosCost = oos.reduce((a, p) => a + cost(p), 0);
  const sortedSeries = [...pnlSeries].sort((a, b) => a.ts - b.ts);
  const atCutoff = [...sortedSeries].reverse().find((pt) => pt.ts <= cutoff);
  const latest = sortedSeries.at(-1);

  const holds = closed
    .filter((p) => p.firstEntryAt && p.lastActivityAt && p.lastActivityAt >= p.firstEntryAt)
    .map((p) => (p.lastActivityAt! - p.firstEntryAt!) / 3600);

  const lastTradeAt = positions.reduce<number | null>(
    (acc, p) =>
      p.lastActivityAt && (acc === null || p.lastActivityAt > acc) ? p.lastActivityAt : acc,
    null,
  );

  const costByCategory = new Map<string, number>();
  for (const p of positions) {
    if (p.category) costByCategory.set(p.category, (costByCategory.get(p.category) ?? 0) + cost(p));
  }
  const primaryCategory = [...costByCategory.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const daysActive = activity.joinDate ? Math.max(1, (now - activity.joinDate) / DAY) : null;
  const replays = input.copyReplays;

  return {
    nClosed,
    nResolved: resolved.length,
    nEvents: new Set(resolved.map((p) => p.eventId ?? p.conditionId)).size,
    totalCost,
    totalPnl,
    winRate: nClosed ? winners / nClosed : null,
    winRateLowerBound: nClosed ? wilsonLowerBound(winners, nClosed) : null,
    resolvedWinRate: skill.n ? skill.wins / skill.n : null,
    expectedWinRate: skill.n ? skill.expectedWins / skill.n : null,
    zSkill: skill.z,
    edgePerBet: skill.edgePerBet,
    mcPValue: monteCarloPValue(positions, cfg, input.wallet),
    roi,
    roiShrunk: roi === null ? null : roi * (nClosed / (nClosed + cfg.roiShrinkK)),
    topMarketShare: conc.topMarketShare,
    top3Share: conc.top3Share,
    pnlExTop3: conc.pnlExTop3,
    months: activeMonths.length,
    profitableMonthsPct: activeMonths.length
      ? activeMonths.filter((m) => m.pnl > 0).length / activeMonths.length
      : null,
    maxDrawdown: dd.maxDrawdown,
    recoveryFactor: dd.recoveryFactor,
    sharpe: dd.sharpe,
    tradesPerDay:
      activity.tradeCount !== null && daysActive ? activity.tradeCount / daysActive : null,
    bothSidesRatio: bothSidesRatio(positions),
    medianHoldHours: holds.length ? median(holds) : null,
    oosRoi:
      oos.length >= 5 && oosCost > 0 ? oos.reduce((a, p) => a + p.realizedPnl, 0) / oosCost : null,
    oosPnl: latest && atCutoff ? latest.pnl - atCutoff.pnl : null,
    copyAdjRoi: replays ? copyAdjustedRoi(replays) : null,
    nCopyReplays: replays?.length ?? 0,
    lastTradeAt,
    daysSinceTrade: lastTradeAt === null ? null : Math.max(0, (now - lastTradeAt) / DAY),
    primaryCategory,
    monthlyPnl: months,
  };
}
