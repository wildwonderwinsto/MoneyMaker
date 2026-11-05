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

export function shortAddress(wallet: string) {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

export function traderName(t: { name?: string | null; wallet: string }) {
  // Polymarket auto-generates names like "0xabc…-1789545517033" for anonymous users.
  if (!t.name || /^0x[0-9a-f]{40}/i.test(t.name)) return shortAddress(t.wallet);
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
