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
  /** Market end date (epoch seconds). Unreliable: often a placeholder or before entry. */
  endAt?: number | null;
  /** When the market actually settled (epoch seconds), if known. */
  resolvedAt?: number | null;
  /** Sports: when the game started (epoch seconds); bets opened after it can't be copied. */
  gameStartAt?: number | null;
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
  /** Last real trade (epoch seconds), from the trade count; null = use positions. */
  lastTradeAt?: number | null;
}

/** A leader BUY replayed as if we entered `copyDelaySeconds` later. */
export interface CopyReplay {
  /** Our cost per share after the delay: price + slippage + taker fee. */
  delayedPrice: number;
  /** 1/0 if resolved, otherwise the latest price (mark-to-market). */
  exitValue: number;
  /** Leader's stake in USDC; copies are sized proportionally (defaults to 1). */
  weight?: number;
  /** When the leader bought (epoch seconds). */
  ts?: number;
  /** Still running: `exitValue` is today's price, not a final result. */
  open?: boolean;
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
  /** Resolved bets the skill tests used under the forward holdout; null = no holdout. */
  nHoldout: number | null;
  /** Sequential skill evidence on the same bets, each event once (see skillEvidence). */
  eSkill: number;
  /** Sequential evidence that the edge is below minEdge. */
  eNoEdge: number;
  /** Days since the holdout began; null = no holdout. */
  holdoutDays: number | null;
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
  /** Last 30 days (null = not looked up): trades a day, share of redeems/merges/conversions. */
  recentTradesPerDay: number | null;
  recentRedeemMergeShare: number | null;
  bothSidesRatio: number;
  medianHoldHours: number | null;
  oosRoi: number | null;
  oosPnl: number | null;
  /** Cautious copy return: stake-weighted average minus `copyRoiZ` standard errors. */
  copyAdjRoi: number | null;
  /** Plain stake-weighted average return of the replayed copies. */
  copyAdjRoiMean: number | null;
  /** Optimistic copy return (mean + copyLossZ standard errors); below 0 = clearly loses. */
  copyRoiUpper: number | null;
  /** Replays weighted by stake count like this many equal bets (Kish). */
  copyEffectiveN: number | null;
  /** Days between the first and last replayed trade. */
  copyReplayDays: number | null;
  /** Replays still running (valued at today's price). */
  copyOpenReplays: number;
  nCopyReplays: number;
  /**
   * Proven tier: copies of bets placed since the trader became Verified (epoch seconds the
   * record starts; null = never Verified in this holdout). Same replay model as the copy
   * check. Copies/returns null = not replayed this run.
   */
  sinceVerifiedFrom: number | null;
  sinceVerifiedDays: number | null;
  sinceVerifiedCopies: number | null;
  /** Cautious: stake-weighted average minus `copyRoiZ` standard errors. */
  sinceVerifiedCopyRoi: number | null;
  sinceVerifiedCopyRoiMean: number | null;
  sinceVerifiedOpenCopies: number | null;
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

/** Edges (win-probability points) the sequential skill test looks for, equally weighted. */
const SKILL_EDGES = [0.03, 0.05, 0.08, 0.12];
/** Bets of one event that settle within this long of its first settlement count together. */
const EVENT_WINDOW = DAY;
/** Confidence that the edge is below `minEdge` before a Candidate is Rejected (1 / 0.05). */
export const NO_EDGE_EVIDENCE = 20;

export interface SkillEvidence {
  /** Evidence of skill (≥ 1 favours skill); anytime-valid, so re-checking doesn't inflate it. */
  eSkill: number;
  /** Evidence that the edge is below `minEdge` (≥ NO_EDGE_EVIDENCE → Rejected). */
  eNoEdge: number;
  /** Events counted (each event once). */
  events: number;
}

/**
 * Sequential skill test (owner decision 2026-11-09, design S2; audit R2).
 *
 * For each bet at price p, how much likelier its result was if the trader wins p + δ of
 * the time than if they win p (no skill): q/p for a win, (1−q)/(1−p) for a loss. Under no
 * skill each ratio averages exactly 1, so the running product (averaged over several δ)
 * stays below 1/α with probability ≥ 1−α however often it is checked — unlike a z-score,
 * which a weekly re-check would eventually push over any fixed bar by luck.
 *
 * Bets in one event can move together (same game, one winner of many), so each event
 * counts once: its factor is the average of its bets' ratios, which still averages 1 under
 * no skill whatever the dependence. An event's factor is fixed once it has settled for
 * EVENT_WINDOW (later bets on it are ignored), so the evidence only grows by new events.
 * `eNoEdge` is the mirror test of "the edge is at least minEdge" against "no edge".
 */
export function skillEvidence(
  positions: PositionRecord[],
  cfg: ScoringConfig,
  now: number,
): SkillEvidence {
  return evidenceTotals(updateEvidence(emptyEvidence(), positions, cfg, now));
}

/** An unresolved bet stops blocking its event's count after this long (stuck data). */
const UNRESOLVED_WAIT = 30 * DAY;

/**
 * Running skill evidence (owner decision 2026-11-09, cheap re-checks): log factors summed
 * over the events counted so far, and those events' keys (32-bit hashes) so none is ever
 * counted twice. Cheap and full checks both fold new final events into the same total.
 */
export interface EvidenceState {
  logSkill: number[];
  logNoEdge: number;
  events: number;
  bets: number;
  eventKeys: number[];
}

export const emptyEvidence = (): EvidenceState => ({
  logSkill: SKILL_EDGES.map(() => 0),
  logNoEdge: 0,
  events: 0,
  bets: 0,
  eventKeys: [],
});

export function evidenceTotals(s: EvidenceState): SkillEvidence {
  return {
    eSkill: s.logSkill.reduce((a, l) => a + Math.exp(l), 0) / SKILL_EDGES.length,
    eNoEdge: Math.exp(s.logNoEdge),
    events: s.events,
  };
}

/**
 * Fold the events that became final into `state` (returns a new state). An event is final
 * once its first settlement is EVENT_WINDOW old AND none of its bets opened before then is
 * still unresolved (it might still settle inside the window); after UNRESOLVED_WAIT a stuck
 * bet stops blocking. Its factor then covers exactly the bets settled inside the window, so
 * an event whose markets settle across several checks is counted once, complete.
 */
export function updateEvidence(
  state: EvidenceState,
  positions: PositionRecord[],
  cfg: ScoringConfig,
  now: number,
): EvidenceState {
  const settledAt = (p: PositionRecord) => p.resolvedAt ?? p.lastActivityAt ?? p.firstEntryAt ?? 0;
  const byEvent = new Map<string, PositionRecord[]>();
  for (const p of positions) {
    if (p.avgPrice < cfg.minEntryPrice || p.avgPrice > cfg.maxEntryPrice) continue;
    const key = p.eventId ?? p.conditionId;
    byEvent.set(key, [...(byEvent.get(key) ?? []), p]);
  }
  const ratio = (p: PositionRecord, d: number) => {
    const q = Math.min(0.99, p.avgPrice + d);
    return p.won ? q / p.avgPrice : (1 - q) / (1 - p.avgPrice);
  };
  const seen = new Set(state.eventKeys);
  const next: EvidenceState = {
    ...state,
    logSkill: [...state.logSkill],
    eventKeys: [...state.eventKeys],
  };
  for (const [key, all] of byEvent) {
    const h = hashString(key);
    if (seen.has(h)) continue;
    const resolved = all.filter((p) => p.won !== null);
    if (resolved.length === 0) continue;
    const first = Math.min(...resolved.map(settledAt));
    const closes = first + EVENT_WINDOW;
    if (closes > now) continue; // not final yet
    const blocked = all.some((p) => p.won === null && (p.firstEntryAt ?? 0) <= closes);
    if (blocked && first + UNRESOLVED_WAIT > now) continue; // a bet may still settle inside
    const counted = resolved.filter((p) => settledAt(p) <= closes);
    const avg = (f: (p: PositionRecord) => number) =>
      counted.reduce((a, p) => a + f(p), 0) / counted.length;
    SKILL_EDGES.forEach((d, j) => (next.logSkill[j] += Math.log(avg((p) => ratio(p, d)))));
    next.logNoEdge += Math.log(avg((p) => 1 / ratio(p, cfg.minEdge)));
    next.events++;
    next.bets += counted.length;
    next.eventKeys.push(h);
    seen.add(h);
  }
  return next;
}

/**
 * Outcome-randomization test (dollar-weighted, robust to fat tails): re-draw every
 * resolved outcome from its entry price and count how often random luck matches the
 * trader's hold-to-resolution PnL. Deterministically seeded per wallet.
 */
/** Draws for the luck p-value (display only since audit R2; was the `simulations` setting). */
export const MC_SIMULATIONS = 2000;

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
  const draws = cfg.simulations ?? MC_SIMULATIONS;
  let atLeast = 0;
  for (let s = 0; s < draws; s++) {
    let sim = 0;
    for (let i = 0; i < prices.length; i++) {
      sim += shares[i] * ((rand() < prices[i] ? 1 : 0) - prices[i]);
    }
    if (sim >= actual) atLeast++;
  }
  return (atLeast + 1) / (draws + 1);
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

export interface CopyRoiStats {
  /** Stake-weighted average return (= total copy profit ÷ total copied). */
  mean: number;
  /** Standard error of `mean`; null with a single replay. */
  se: number | null;
  /** Kish effective sample size, (Σw)² ÷ Σw²: few big bets → small. */
  nEff: number;
}

/**
 * Stake-weighted ROI of replayed copies (sized proportionally to the leader's stake), with
 * its standard error from the ratio-estimator (linearization) variance:
 * SE² = n/(n−1) · Σ w²(r − mean)² ÷ (Σw)².
 */
export function copyRoiStats(replays: CopyReplay[]): CopyRoiStats | null {
  const valid = replays.filter(
    (r) => r.delayedPrice > 0 && r.delayedPrice < 0.99 && (r.weight ?? 1) > 0,
  );
  if (valid.length === 0) return null;
  const w = valid.map((r) => r.weight ?? 1);
  const ret = valid.map((r) => (r.exitValue - r.delayedPrice) / r.delayedPrice);
  const total = w.reduce((a, b) => a + b, 0);
  const m = w.reduce((a, wi, i) => a + wi * ret[i], 0) / total;
  const n = valid.length;
  const sq = w.reduce((a, wi, i) => a + wi * wi * (ret[i] - m) ** 2, 0);
  return {
    mean: m,
    se: n > 1 ? Math.sqrt((n / (n - 1)) * sq) / total : null,
    nEff: total ** 2 / w.reduce((a, wi) => a + wi * wi, 0),
  };
}

function replaySpanDays(replays: CopyReplay[] | null): number | null {
  const ts = (replays ?? []).map((r) => r.ts).filter((t): t is number => typeof t === "number");
  return ts.length ? (Math.max(...ts) - Math.min(...ts)) / DAY : null;
}

export interface SinceVerifiedRecord {
  from: number | null;
  days: number | null;
  copies: number | null;
  copyRoi: number | null;
  copyRoiMean: number | null;
  open: number | null;
}

/**
 * The Proven tier's record: replayed copies of bets placed at or after `from` (when the
 * trader became Verified). Days run from `from` to now; the cautious return uses the copy
 * check's confidence setting (`copyRoiZ`). Pure (tested).
 */
export function sinceVerifiedRecord(
  replays: CopyReplay[] | null,
  from: number | null,
  now: number,
  cfg: ScoringConfig,
): SinceVerifiedRecord {
  if (from === null) {
    return { from: null, days: null, copies: null, copyRoi: null, copyRoiMean: null, open: null };
  }
  const days = Math.max(0, (now - from) / DAY);
  if (replays === null) {
    return { from, days, copies: null, copyRoi: null, copyRoiMean: null, open: null };
  }
  const since = replays.filter((r) => typeof r.ts === "number" && r.ts >= from);
  const stats = copyRoiStats(since);
  return {
    from,
    days,
    copies: since.length,
    copyRoi: stats && stats.se !== null ? stats.mean - cfg.copyRoiZ * stats.se : null,
    copyRoiMean: stats?.mean ?? null,
    open: since.filter((r) => r.open).length,
  };
}

/** Stake-weighted ROI of replayed copies (the plain average). */
export function copyAdjustedRoi(replays: CopyReplay[]): number | null {
  return copyRoiStats(replays)?.mean ?? null;
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
  /** Last 30 days of activity (daily job; omitted in backtests and tests). */
  recentActivity?: { tradesPerDay: number; redeemMergeShare: number; rows: number } | null;
  /**
   * Forward holdout: epoch seconds the trader was first picked. The skill tests (z and the
   * luck test) then count only bets opened at or after it, because the pick itself was
   * based on the earlier profits. Omitted = all bets (backtest re-derivations).
   */
  holdoutFrom?: number | null;
  /**
   * Proven tier: when the trader became Verified (epoch seconds; null = not yet), and the
   * replayed copies of their bets since then (null = not replayed this run).
   */
  verifiedFrom?: number | null;
  sinceVerifiedReplays?: CopyReplay[] | null;
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

  const holdoutFrom = input.holdoutFrom ?? null;
  const tested =
    holdoutFrom === null
      ? positions
      : positions.filter((p) => p.firstEntryAt !== null && p.firstEntryAt >= holdoutFrom);
  const skill = skillZ(tested, cfg);
  const evidence = skillEvidence(tested, cfg, now);
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

  // Position activity also counts claims and settlements, so prefer the real last trade.
  const lastTradeAt =
    activity.lastTradeAt ??
    positions.reduce<number | null>(
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
  // Too few replays is not evidence either way: report "not measured".
  const copy = replays && replays.length >= cfg.minCopyReplays ? copyRoiStats(replays) : null;
  const record = sinceVerifiedRecord(
    input.sinceVerifiedReplays ?? null,
    input.verifiedFrom ?? null,
    now,
    cfg,
  );

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
    mcPValue: monteCarloPValue(tested, cfg, input.wallet),
    nHoldout: holdoutFrom === null ? null : skill.n,
    eSkill: evidence.eSkill,
    eNoEdge: evidence.eNoEdge,
    holdoutDays: holdoutFrom === null ? null : Math.max(0, (now - holdoutFrom) / DAY),
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
    recentTradesPerDay: input.recentActivity?.tradesPerDay ?? null,
    recentRedeemMergeShare: input.recentActivity?.redeemMergeShare ?? null,
    bothSidesRatio: bothSidesRatio(positions),
    medianHoldHours: holds.length ? median(holds) : null,
    oosRoi:
      oos.length >= 5 && oosCost > 0 ? oos.reduce((a, p) => a + p.realizedPnl, 0) / oosCost : null,
    oosPnl: latest && atCutoff ? latest.pnl - atCutoff.pnl : null,
    copyAdjRoi: copy && copy.se !== null ? copy.mean - cfg.copyRoiZ * copy.se : null,
    copyAdjRoiMean: copy?.mean ?? null,
    copyRoiUpper: copy && copy.se !== null ? copy.mean + cfg.copyLossZ * copy.se : null,
    copyEffectiveN: copy?.nEff ?? null,
    copyReplayDays: replaySpanDays(replays),
    copyOpenReplays: replays?.filter((r) => r.open).length ?? 0,
    nCopyReplays: replays?.length ?? 0,
    sinceVerifiedFrom: record.from,
    sinceVerifiedDays: record.days,
    sinceVerifiedCopies: record.copies,
    sinceVerifiedCopyRoi: record.copyRoi,
    sinceVerifiedCopyRoiMean: record.copyRoiMean,
    sinceVerifiedOpenCopies: record.open,
    lastTradeAt,
    daysSinceTrade: lastTradeAt === null ? null : Math.max(0, (now - lastTradeAt) / DAY),
    primaryCategory,
    monthlyPnl: months,
  };
}
