/** Small, dependency-free statistics helpers used by the scoring engine. */

/** Standard normal CDF (Abramowitz & Stegun 26.2.17, |error| < 7.5e-8). */
export function normalCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const poly =
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const p = d * poly;
  return x >= 0 ? 1 - p : p;
}

/** Lower bound of the Wilson score interval for a binomial proportion. */
export function wilsonLowerBound(successes: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const phat = successes / n;
  const z2 = z * z;
  const centre = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return (centre - margin) / (1 + z2 / n);
}

/**
 * Benjamini–Hochberg: the largest p-value threshold that controls the false discovery
 * rate at level `q` across all tests. Returns 0 when nothing is significant.
 */
export function benjaminiHochbergThreshold(pValues: number[], q: number): number {
  const sorted = pValues.filter((p) => Number.isFinite(p)).sort((a, b) => a - b);
  const m = sorted.length;
  let threshold = 0;
  for (let i = 0; i < m; i++) {
    if (sorted[i] <= ((i + 1) / m) * q) threshold = sorted[i];
  }
  return threshold;
}

/**
 * e-BH (Wang & Ramdas 2022): the Benjamini–Hochberg procedure for e-values. With m tests,
 * the k largest pass when the k-th largest is ≥ m/(k·q); this returns that bar for the
 * largest such k (Infinity = nothing passes). Controls the false discovery rate at q
 * under any dependence between the tests.
 */
export function eBenjaminiHochbergThreshold(eValues: number[], q: number): number {
  const sorted = eValues.filter((e) => !Number.isNaN(e)).sort((a, b) => b - a);
  const m = sorted.length;
  let threshold = Infinity;
  for (let k = 1; k <= m; k++) if (q > 0 && sorted[k - 1] >= m / (k * q)) threshold = m / (k * q);
  return threshold;
}

/**
 * Simulations needed for the luck test to be passable at all. A Monte Carlo p-value can't
 * go below 1/(simulations + 1), while Benjamini–Hochberg needs the best of `candidates`
 * at or below q/candidates. With fewer simulations nobody can pass, however skilled.
 */
export function simulationsFor(candidates: number, q: number, wanted: number): number {
  return q > 0 ? Math.max(wanted, Math.ceil(candidates / q)) : wanted;
}

/** Deterministic PRNG (mulberry32) so scores are reproducible run to run. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of a string (FNV-1a), used to seed per-trader simulations. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Sample standard deviation. */
export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function clamp(x: number, lo = 0, hi = 1): number {
  return Math.min(hi, Math.max(lo, x));
}
