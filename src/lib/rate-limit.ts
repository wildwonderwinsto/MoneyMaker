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

/**
 * The client address for the password limiter: the right-most X-Forwarded-For entry, the
 * one appended by the proxy in front of us. Entries to its left are whatever the client
 * sent, so keying on the first one gave a guesser fresh attempts with every request.
 * (Pending: confirm on Render with /api/admin/forwarded, then remove that check.)
 */
export function limiterKey(h: { get(name: string): string | null }): string {
  const forwarded = (h.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return forwarded.at(-1) || h.get("x-real-ip") || "local";
}

export function clearAttempts(key: string) {
  buckets.delete(key);
}
