/** Deterministic synthetic traders for scoring tests. */
import type { MetricsInput, PnlSeriesPoint, PositionRecord } from "@/lib/scoring/metrics";
import { seededRandom } from "@/lib/scoring/stats";

export const NOW = Date.UTC(2026, 10, 1) / 1000; // 2026-11-01
const DAY = 86_400;

interface GenOpts {
  wallet: string;
  n: number;
  /** Entry price for each bet. */
  price: (i: number, rand: () => number) => number;
  /** Probability the bet actually wins (true edge). */
  winProb: (price: number) => number;
  shares: (i: number) => number;
  days: number;
  holdHours?: number;
  seed: number;
  tradeCount?: number;
}

/** Build positions spread evenly over `days`, plus a matching cumulative PnL series. */
export function generateTrader(o: GenOpts): MetricsInput {
  const rand = seededRandom(o.seed);
  const positions: PositionRecord[] = [];
  const start = NOW - o.days * DAY;
  for (let i = 0; i < o.n; i++) {
    const price = o.price(i, rand);
    const won = rand() < o.winProb(price);
    const shares = o.shares(i);
    const entry = start + Math.floor(((i + 0.5) / o.n) * (o.days - 2)) * DAY;
    positions.push({
      conditionId: `${o.wallet}-c${i}`,
      tokenId: `${o.wallet}-t${i}`,
      eventId: `${o.wallet}-e${i}`,
      category: i % 3 === 0 ? "politics" : "sports",
      avgPrice: price,
      sharesBought: shares,
      realizedPnl: shares * ((won ? 1 : 0) - price),
      unrealizedPnl: 0,
      closed: true,
      won,
      firstEntryAt: entry,
      lastActivityAt: entry + (o.holdHours ?? 48) * 3600,
    });
  }
  return {
    wallet: o.wallet,
    positions,
    pnlSeries: seriesFromPositions(positions, start),
    activity: { tradeCount: o.tradeCount ?? o.n * 3, joinDate: start },
    copyReplays: null,
    now: NOW,
  };
}

export function seriesFromPositions(positions: PositionRecord[], start: number): PnlSeriesPoint[] {
  const sorted = [...positions].sort((a, b) => a.lastActivityAt! - b.lastActivityAt!);
  const series: PnlSeriesPoint[] = [];
  let cum = 0;
  let idx = 0;
  for (let t = start; t <= NOW; t += DAY) {
    while (idx < sorted.length && sorted[idx].lastActivityAt! <= t)
      cum += sorted[idx++].realizedPnl;
    series.push({ ts: t, pnl: cum });
  }
  return series;
}

/** Bets near 50/50 and wins 68% of the time, every month, small even sizes. */
// Seed 1 realizes the intended ~+17-point edge (z 4.4). Seed 7 realized only +10 over 160
// bets, which the sequential skill test (2026-11-09) doesn't yet call proven; see
// "an unlucky draw of a skilled trader stays a Candidate" in tests/scoring.test.ts.
export const steadyGrinder = (seed = 1) => {
  const t = generateTrader({
    wallet: "0xgrinder",
    n: 160,
    price: (_i, r) => 0.4 + r() * 0.2,
    winProb: () => 0.68,
    shares: () => 200,
    days: 240,
    seed,
  });
  t.copyReplays = t.positions.map((p) => ({
    delayedPrice: p.avgPrice + 0.01,
    exitValue: p.won ? 1 : 0,
  }));
  return t;
};

/** Loses steadily, then one enormous long-shot win makes them look like a top trader. */
export const oneHitWonder = () => {
  const t = generateTrader({
    wallet: "0xonehit",
    n: 80,
    price: () => 0.5,
    winProb: () => 0.45,
    shares: () => 100,
    days: 200,
    seed: 11,
  });
  const big = t.positions[60];
  Object.assign(big, {
    avgPrice: 0.05,
    sharesBought: 400_000,
    won: true,
    realizedPnl: 400_000 * 0.95,
  });
  t.pnlSeries = seriesFromPositions(t.positions, NOW - 200 * DAY);
  t.copyReplays = [];
  return t;
};

/** Buys 95¢ favorites: 95% win rate that is exactly what prices implied — no edge. */
export const favoriteBuyer = () =>
  generateTrader({
    wallet: "0xfav",
    n: 300,
    price: () => 0.95,
    winProb: (p) => p,
    shares: () => 1000,
    days: 240,
    seed: 3,
  });

/** Profitable high-frequency bot: thousands of trades a day, holds for minutes. */
export const hftBot = () =>
  generateTrader({
    wallet: "0xbot",
    n: 400,
    price: (_i, r) => 0.3 + r() * 0.4,
    winProb: (p) => p + 0.08,
    shares: () => 500,
    days: 200,
    holdHours: 0.05,
    seed: 5,
    tradeCount: 900_000,
  });

/** Pure luck: outcomes drawn from the prices it paid. */
export const coinFlipper = (seed = 19) =>
  generateTrader({
    wallet: `0xflip${seed}`,
    n: 150,
    price: (_i, r) => 0.2 + r() * 0.6,
    winProb: (p) => p,
    shares: () => 300,
    days: 240,
    seed,
  });
