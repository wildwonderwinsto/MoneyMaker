/**
 * Tiny in-memory attempt limiter (per process), used to slow down password guessing.
 * One Render instance serves the app, so process memory is enough here.
 */
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

const buckets = new Map<string, { count: number; resetAt: number }>();

/** Count an attempt; false once `key` used up its attempts in the current window. */
export function allowAttempt(key: string, now = Date.now(), max = MAX_ATTEMPTS): boolean {
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  b.count++;
  return b.count <= max;
}

export function clearAttempts(key: string) {
  buckets.delete(key);
}
