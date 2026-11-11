/** Display formatting helpers (pure; safe on server and client). */

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});
const compactUsdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

export function usd(
  x: number | null | undefined,
  opts: { compact?: boolean; sign?: boolean } = {},
) {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  const body = (opts.compact && Math.abs(x) >= 10_000 ? compactUsdFmt : usdFmt).format(Math.abs(x));
  const sign = x < 0 ? "−" : opts.sign && x > 0 ? "+" : "";
  return `${sign}${body}`;
}

const axisFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

const wholeUsdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/**
 * Chart axis labels: never cents, abbreviated from $10K ("$6,500", "$994", "$0", "$19.5K",
 * "−$6,500"), so a narrow axis never clips them ("$6,500.00" did) and a $1,001 vs $994
 * equity axis keeps its precision.
 */
export function axisUsd(x: number): string {
  if (!Number.isFinite(x)) return "";
  const a = Math.abs(x);
  const body = (a >= 10_000 ? axisFmt : wholeUsdFmt).format(a);
  return `${x < 0 && Math.round(a) !== 0 ? "−" : ""}${body}`;
}

export function pct(x: number | null | undefined, digits = 1, opts: { sign?: boolean } = {}) {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  const sign = x < 0 ? "−" : opts.sign && x > 0 ? "+" : "";
  return `${sign}${Math.abs(x * 100).toFixed(digits)}%`;
}

/** Price 0–1 shown as cents, e.g. 0.534 → "53¢". */
export function cents(x: number | null | undefined) {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  const c = x * 100;
  return `${c < 10 && c > 0 ? c.toFixed(1) : Math.round(c)}¢`;
}

export function num(x: number | null | undefined, digits = 0) {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return x.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

/** Bytes in binary units, e.g. 52_428_800 → "50.0 MB". */
export function bytes(x: number | null | undefined) {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = Math.max(0, x);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/**
 * "5 min late" for the copy delay a trader's copy check used (stored with the score). Scores
 * computed before the delay was stored use `fallback` (today's setting), else just "late".
 */
export function copiedLate(seconds: unknown, fallback?: number): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return fallback === undefined ? "late" : copiedLate(fallback);
  }
  if (seconds < 60) return `${Math.round(seconds)} s late`;
  return `${Math.round((seconds / 60) * 10) / 10} min late`;
}

export function shortAddress(wallet: string) {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

export function traderName(t: { name?: string | null; wallet: string }) {
  // Polymarket auto-generates names like "0xabc…-1789545517033" for anonymous users, and
  // some are a (sometimes cut-off) address: any long run of hex after 0x is not a name.
  if (!t.name || /^0x[0-9a-f]{20,}/i.test(t.name)) return shortAddress(t.wallet);
  return t.name;
}

export function timeAgo(date: Date | string | null | undefined, now = Date.now()) {
  if (!date) return "—";
  const ms = now - new Date(date).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${Math.max(0, s)}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export const polymarketProfileUrl = (wallet: string) => `https://polymarket.com/profile/${wallet}`;
export const polymarketMarketUrl = (slug: string) => `https://polymarket.com/market/${slug}`;
