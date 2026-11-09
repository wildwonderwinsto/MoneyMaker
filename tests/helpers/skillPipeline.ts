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
  skillZ,
  type CopyReplay,
  type MetricsInput,
  type PositionRecord,
  type TraderMetrics,
} from "@/lib/scoring/metrics";
import { scoreTrader, type ScoreResult } from "@/lib/scoring/score";
import { benjaminiHochbergThreshold, seededRandom, simulationsFor } from "@/lib/scoring/stats";

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
  /** Earlier tested wallets in the pooled luck test (zero skill → uniform p-values). */
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
}

export const PIPELINE_DEFAULTS: PipelineOptions = {
  horizonDays: 180,
  pooledNull: 500,
  candidateEveryDays: 7,
  cooldownDays: 30,
  earlyReturnMarkets: DEFAULT_SCORING_CONFIG.minResolved,
  repick: false,
  holdout: "first",
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
  const full = {
    ...cfg,
    simulations: simulationsFor(o.pooledNull + traders.length, cfg.fdrQ, cfg.simulations),
  };
  const nullP = Array.from({ length: o.pooledNull }, (_, i) => (i + 0.5) / o.pooledNull);
  const state = traders.map((t) => ({
    t,
    next: 0,
    from: day0,
    tested: null as { day: number; p: number } | null,
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
    const today: Array<{ s: (typeof state)[number]; m: TraderMetrics | null }> = [];
    for (const s of due) {
      const input = inputAt(s.t, now, s.from);
      const held = input.positions.filter((p) => p.firstEntryAt! >= s.from);
      const z = skillZ(held, cfg);
      // skill_z is a hard check: once testable and below minZ the tier is Rejected whatever
      // the luck test says, so skip the (slow) Monte Carlo for these.
      if (z.n >= cfg.minResolved && (z.z ?? -Infinity) < cfg.minZ) {
        today.push({ s, m: null });
        s.tested = { day, p: 1 };
      } else {
        const m = computeMetrics(input, full);
        today.push({ s, m });
        if ((m.nHoldout ?? 0) >= cfg.minResolved && m.mcPValue !== null)
          s.tested = { day, p: m.mcPValue };
      }
    }
    const pooled = [
      ...nullP,
      ...state.filter((s) => s.tested && s.tested.day > day - 30).map((s) => s.tested!.p),
    ];
    const ctx = {
      mcPThreshold: benjaminiHochbergThreshold(pooled, cfg.fdrQ),
      candidates: pooled.length,
    };
    for (const { s, m } of today) {
      const r: ScoreResult | null = m ? scoreTrader(m, cfg, ctx) : null;
      s.res.checks++;
      s.res.lastTier = r?.tier ?? "rejected";
      s.res.lastFailed = r ? r.checks.filter((c) => !c.ok).map((c) => c.code) : ["skill_z"];
      if (r?.passed) {
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
