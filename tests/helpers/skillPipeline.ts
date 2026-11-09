/**
 * Forward-in-time simulation of the selection pipeline for traders WITH a known edge
 * (audit R1, 2026-11-09): picked on day 0, then checked on the rotation's schedule while
 * their post-pick bets resolve. Scoring is the production `computeMetrics` + `scoreTrader`;
 * only the calendar (who is checked when) is modelled here.
 *
 * Inputs measured on the latest local daily run (124 wallets with ≥20 stored positions,
 * 2026-11-09; script in the audit notes):
 * - positions opened per day: p25 0.43, p50 1.88, p75 6.4, p90 12.65;
 * - entry price quantiles (resolved, 2–98¢) below;
 * - days from entry to market resolution: p10 0.12, p25 0.29, p50 3.1, p75 17.8, p90 50.
 * Stake spread follows the zero-skill test's generator (log-sd ≈ 1.15), not the real
 * wallets' (≈ 2.2), so every non-skill check is passable and the test isolates the skill
 * stage. Copy replays: 2 min late at the same price +1¢ and a 5% taker fee, like the
 * zero-skill test (no adverse drift).
 */
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from "@/lib/scoring/config";
import {
  computeMetrics,
  type CopyReplay,
  type MetricsInput,
  type PositionRecord,
  type TraderMetrics,
} from "@/lib/scoring/metrics";
import { lightDecision } from "@/lib/jobs/lightCheck";
import { scoreTrader, type ScoreResult } from "@/lib/scoring/score";
import { eBenjaminiHochbergThreshold, seededRandom } from "@/lib/scoring/stats";

export const DAY = 86_400;

/** Real positions-opened-per-day quartiles + p90 (see header). */
export const REAL_BET_RATES = [0.43, 1.88, 6.4, 12.65];

/** [quantile, value] knots of the real entry-price distribution. */
const PRICE_KNOTS: Array<[number, number]> = [
  [0, 0.02],
  [0.05, 0.038],
  [0.1, 0.074],
  [0.2, 0.17],
  [0.3, 0.293],
  [0.4, 0.411],
  [0.5, 0.5],
  [0.6, 0.587],
  [0.7, 0.71],
  [0.8, 0.84],
  [0.9, 0.93],
  [0.95, 0.96],
  [1, 0.98],
];
/** [quantile, days] knots of the real entry → resolution lag. */
const LAG_KNOTS: Array<[number, number]> = [
  [0, 0.05],
  [0.1, 0.12],
  [0.25, 0.29],
  [0.5, 3.1],
  [0.75, 17.8],
  [0.9, 50],
  [1, 120],
];

function inverse(knots: Array<[number, number]>, u: number): number {
  for (let i = 1; i < knots.length; i++) {
    const [q1, v1] = knots[i];
    const [q0, v0] = knots[i - 1];
    if (u <= q1) return v0 + ((u - q0) / (q1 - q0)) * (v1 - v0);
  }
  return knots.at(-1)![1];
}

export interface SimBet {
  entry: number;
  resolve: number;
  p: number;
  shares: number;
  won: boolean;
}

export interface SimTrader {
  wallet: string;
  edge: number;
  rate: number;
  start: number;
  bets: SimBet[];
}

/** A trader who wins `edge` more often than prices say, active from a year before `day0`. */
export function skilledTrader(
  wallet: string,
  edge: number,
  rate: number,
  day0: number,
  horizonDays: number,
  seed: number,
): SimTrader {
  const rand = seededRandom(seed);
  const start = day0 - 360 * DAY;
  const span = (360 + horizonDays) * DAY;
  const n = Math.round(rate * (360 + horizonDays));
  const scale = Math.exp(3 * rand());
  const bets: SimBet[] = [];
  for (let i = 0; i < n; i++) {
    const entry = start + rand() * span;
    const p = inverse(PRICE_KNOTS, rand());
    const resolve = entry + inverse(LAG_KNOTS, rand()) * DAY;
    const shares = scale * 50 * Math.exp(4 * (rand() - 0.5));
    bets.push({ entry, resolve, p, shares, won: rand() < Math.min(0.99, p + edge) });
  }
  bets.sort((a, b) => a.entry - b.entry);
  return { wallet, edge, rate, start, bets };
}

/** What the daily job would load for this trader at `now` (bets resolve as time passes). */
export function inputAt(t: SimTrader, now: number, holdoutFrom: number): MetricsInput {
  const positions: PositionRecord[] = [];
  const events: Array<{ t: number; pnl: number }> = [];
  const buys: SimBet[] = [];
  t.bets.forEach((b, i) => {
    if (b.entry > now) return;
    const done = b.resolve <= now;
    const pnl = done ? b.shares * ((b.won ? 1 : 0) - b.p) : 0;
    positions.push({
      conditionId: `c${i}`,
      tokenId: `t${i}`,
      eventId: `e${i}`,
      category: null,
      avgPrice: b.p,
      sharesBought: b.shares,
      realizedPnl: pnl,
      unrealizedPnl: 0,
      closed: done,
      won: done ? b.won : null,
      firstEntryAt: b.entry,
      lastActivityAt: done ? b.resolve : b.entry,
      resolvedAt: done ? b.resolve : null,
    });
    if (done) events.push({ t: b.resolve, pnl });
    if (b.entry >= now - 90 * DAY && b.entry < now - 1020 && b.shares * b.p >= 25) buys.push(b);
  });
  events.sort((a, b) => a.t - b.t);
  const byDay = new Map<number, number>();
  let cum = 0;
  for (const e of events) byDay.set(Math.floor(e.t / DAY) * DAY, (cum += e.pnl));
  // The job replays an even sample of up to 150 recent buys.
  const sample = Array.from(
    { length: Math.min(150, buys.length) },
    (_, i) => buys[Math.floor((i * buys.length) / Math.min(150, buys.length))],
  );
  const copyReplays: CopyReplay[] = sample.map((b) => {
    const done = b.resolve <= now;
    const d = Math.min(0.999, b.p + 0.01);
    return {
      delayedPrice: d + 0.05 * d * (1 - d),
      exitValue: done ? (b.won ? 1 : 0) : b.p,
      weight: b.shares * b.p,
      ts: b.entry,
      open: !done,
    };
  });
  const last = t.bets.filter((b) => b.entry <= now).at(-1);
  return {
    wallet: t.wallet,
    positions,
    pnlSeries: [...byDay].map(([ts, pnl]) => ({ ts, pnl })),
    activity: {
      tradeCount: 3 * positions.length,
      joinDate: t.start,
      lastTradeAt: last?.entry ?? null,
    },
    copyReplays,
    now,
    holdoutFrom,
  };
}

export interface PipelineOptions {
  horizonDays: number;
  /** Earlier tested zero-skill wallets in the pooled skill test (e-BH). */
  pooledNull: number;
  candidateEveryDays: number;
  cooldownDays: number;
  /** New markets since the last check that end a cool-down early. */
  earlyReturnMarkets: number;
  /**
   * Whether a Rejected trader is picked again once eligible. Not guaranteed in production:
   * discovery must rank them into a free slot, so the default is no.
   */
  repick: boolean;
  /** Holdout start: the first check (today's `first_checked_at`) or the latest re-pick. */
  holdout: "first" | "repick";
  /** Candidates' weekly re-checks are cheap (production since 2026-11-09). */
  cheapRechecks: boolean;
}

export const PIPELINE_DEFAULTS: PipelineOptions = {
  horizonDays: 180,
  pooledNull: 500,
  candidateEveryDays: 7,
  cooldownDays: 30,
  earlyReturnMarkets: DEFAULT_SCORING_CONFIG.minResolved,
  repick: false,
  holdout: "first",
  cheapRechecks: true,
};

export interface PipelineResult {
  wallet: string;
  edge: number;
  rate: number;
  /** Days after the first check when the trader first reached Verified/Elite; null = never. */
  foundDay: number | null;
  checks: number;
  lastTier: string;
  /** Checks failed at the last check (why they weren't found). */
  lastFailed: string[];
}

/**
 * Today's production calendar: first check on day 0 (the holdout starts there and is kept,
 * as `first_checked_at` is); Candidates and Watchlist re-checked every
 * `candidateEveryDays`; Rejected are out, or with `repick` come back after `cooldownDays`
 * or `earlyReturnMarkets` new markets.
 */
export function runPipeline(
  traders: SimTrader[],
  day0: number,
  cfg: ScoringConfig = DEFAULT_SCORING_CONFIG,
  o: PipelineOptions = PIPELINE_DEFAULTS,
): PipelineResult[] {
  // The Monte Carlo luck p-value is display-only now, so keep it cheap.
  const full = { ...cfg, simulations: 100 };
  // Earlier tested zero-skill wallets: evidence 1 (= none; under no skill it averages 1).
  const nullE = Array.from({ length: o.pooledNull }, () => 1);
  const state = traders.map((t) => ({
    t,
    next: 0,
    from: day0,
    lastFull: -Infinity,
    fullDue: false,
    tested: null as { day: number; e: number } | null,
    res: {
      wallet: t.wallet,
      edge: t.edge,
      rate: t.rate,
      foundDay: null,
      checks: 0,
      lastTier: "none",
      lastFailed: [],
    } as PipelineResult,
  }));

  for (let day = 0; day <= o.horizonDays; day++) {
    const now = day0 + day * DAY;
    const due = state.filter((s) => s.res.foundDay === null && s.next <= day);
    if (due.length === 0) continue;
    const today: Array<{ s: (typeof state)[number]; m: TraderMetrics }> = [];
    for (const s of due) {
      const m = computeMetrics(inputAt(s.t, now, s.from), full);
      today.push({ s, m });
      if ((m.nHoldout ?? 0) >= cfg.minResolved) s.tested = { day, e: m.eSkill };
    }
    const pooled = [
      ...nullE,
      ...state.filter((s) => s.tested && s.tested.day > day - 30).map((s) => s.tested!.e),
    ];
    const ctx = {
      eThreshold: eBenjaminiHochbergThreshold(pooled, cfg.fdrQ),
      candidates: pooled.length,
    };
    for (const { s, m } of today) {
      const r: ScoreResult = scoreTrader(m, cfg, ctx);
      s.res.checks++;
      // Production calendar (owner, 2026-11-09): a Candidate's re-checks are cheap (skill
      // only, never a promotion) unless a full one is due — every 4 weeks, or the day after
      // a cheap one proved the skill.
      const full =
        !o.cheapRechecks || s.fullDue || day - s.lastFull >= 28 || s.res.lastTier !== "candidate";
      if (!full) {
        const d = lightDecision(m, cfg, ctx.eThreshold);
        if (d === "reject") {
          s.res.lastTier = "rejected";
          s.next = Infinity;
        } else {
          s.fullDue = d === "full_check";
          s.next = s.fullDue ? day + 1 : day + o.candidateEveryDays;
        }
        continue;
      }
      s.lastFull = day;
      s.fullDue = false;
      s.res.lastTier = r.tier;
      s.res.lastFailed = r.checks.filter((c) => !c.ok).map((c) => c.code);
      if (r.passed) {
        s.res.foundDay = day;
        continue;
      }
      if (s.res.lastTier === "rejected") {
        // Back after the cool-down, or once they traded enough new markets.
        const since = s.t.bets.filter((b) => b.entry > now);
        const early = since[o.earlyReturnMarkets - 1]?.entry;
        const earlyDay = early === undefined ? Infinity : Math.ceil((early - day0) / DAY);
        s.next = o.repick ? Math.min(day + o.cooldownDays, earlyDay) : Infinity;
        if (o.holdout === "repick") s.from = day0 + s.next * DAY;
      } else s.next = day + o.candidateEveryDays;
    }
  }
  return state.map((s) => s.res);
}
