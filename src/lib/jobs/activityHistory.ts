/**
 * A wallet's own activity (/v2/activity, every type), fetched fresh — audit #9 (owner
 * decision 2026-11-08). Two uses:
 *
 * 1. Rebuild a recorded pick's month: what copying the bets they opened that month would
 *    have returned, from their trades, sells and redeems — not from /positions rows, which
 *    for active wallets cover only the newest ~1,000 positions (B2).
 * 2. Recent-activity profile for the bot check (baseline at record time, scoring): trades a
 *    day, and the share of redeems / merges / conversions.
 *
 * Verified live (2026-11-09): with no `type` the API returns TRADE, REDEEM, MERGE, SPLIT,
 * CONVERSION (+ rebates, yield, reward, migration rows); `start`/`end` are honoured; REDEEM
 * rows carry token, shares and payout; MERGE / SPLIT / CONVERSION rows carry only the market
 * (no token), so their cost per share is unknowable.
 */
import { collect, getActivity, paginate, type Activity } from "@/lib/polymarket/data";
import { MAX_REDEEM_MERGE_SHARE } from "@/lib/scoring/config";

/** Rows fetched per pick-month or profile (newest first); older rows are "not covered". */
export const ACTIVITY_ROW_CAP = 6000;
/** Recent window for the bot profile. */
export const PROFILE_DAYS = 30;

const DAY = 86_400;
const POSITION_TYPES = new Set(["TRADE", "REDEEM", "MERGE", "SPLIT", "CONVERSION"]);
const UNKNOWN_COST = new Set(["MERGE", "SPLIT", "CONVERSION"]);

export interface ActivityWindow {
  rows: Activity[];
  /** Earliest moment covered: `from`, or later when the row cap cut the window. */
  coverageStart: number;
  partial: boolean;
}

/** Every activity row in [from, to), newest first, at most `cap` rows. */
export async function fetchActivityWindow(
  wallet: string,
  from: number,
  to: number,
  cap = ACTIVITY_ROW_CAP,
): Promise<ActivityWindow> {
  const rows = await collect(
    paginate(
      (cursor) =>
        getActivity({ user: wallet, start: from, end: to - 1, sortDirection: "DESC", cursor }),
      { maxItems: cap },
    ),
  );
  const capped = rows.length >= cap;
  const coverageStart = capped ? Math.min(...rows.map((r) => r.timestamp)) : from;
  return { rows, coverageStart, partial: coverageStart > from };
}

export interface PickResult {
  bets: number;
  /** Leader's dollars in the bets counted (cost incl. fees). */
  staked: number;
  /** Copy P&L on those dollars after entry slippage and taker fee (stake-weighted). */
  pnl: number;
}

/**
 * What copying the bets opened in the window would have returned. Per token: buys (cost =
 * USDC paid, fee included), sells and redeems (USDC received), and whatever is still held,
 * valued by `value` (settled payout or today's price; undefined = unknown → bet left out).
 * Left out: markets touched by a merge / split / conversion (unknown cost), and tokens whose
 * first row in the window isn't a buy (opened before the window or before coverage).
 */
export function rebuildPickMonth(
  rows: Activity[],
  value: (tokenId: string) => number | undefined,
  slippage: number,
  feeRate: number,
  /** The copy engine's filters (B4): leader bets it would skip aren't counted. */
  filters: { minLeaderUsd: number; minEntryPrice: number; maxEntryPrice: number } = {
    minLeaderUsd: 0,
    minEntryPrice: 0,
    maxEntryPrice: 1,
  },
): PickResult {
  const unknown = new Set(rows.filter((r) => UNKNOWN_COST.has(r.type)).map((r) => r.condition_id));
  const byToken = new Map<string, Activity[]>();
  for (const r of rows) {
    if (!POSITION_TYPES.has(r.type) || !r.token_id || unknown.has(r.condition_id)) continue;
    if (r.type !== "TRADE" && r.type !== "REDEEM") continue;
    byToken.set(r.token_id, [...(byToken.get(r.token_id) ?? []), r]);
  }
  let bets = 0;
  let staked = 0;
  let pnl = 0;
  for (const [token, list] of byToken) {
    list.sort((a, b) => a.timestamp - b.timestamp);
    if (!(list[0].type === "TRADE" && list[0].side === "BUY")) continue;
    let bought = 0;
    let cost = 0;
    let out = 0;
    let received = 0;
    for (const r of list) {
      if (r.type === "TRADE" && r.side === "BUY") {
        bought += r.size;
        cost += r.usdc_size;
      } else {
        out += r.size;
        received += r.usdc_size;
      }
    }
    const held = Math.max(0, bought - out);
    const mark = held > 1e-9 ? value(token) : 0;
    if (mark === undefined || cost <= 0 || bought <= 0) continue;
    if (cost < filters.minLeaderUsd) continue;
    if (cost / bought < filters.minEntryPrice || cost / bought > filters.maxEntryPrice) continue;
    const leaderReturn = (received + held * mark) / cost - 1;
    // Our entry: the leader's average price plus slippage, plus the taker fee.
    const avg = cost / bought;
    const entry = Math.min(0.999, avg + slippage);
    const allIn = entry + feeRate * entry * (1 - entry);
    const ours = Math.max(-1, (1 + leaderReturn) * (avg / allIn) - 1);
    bets++;
    staked += cost;
    pnl += cost * ours;
  }
  return { bets, staked, pnl };
}

export interface ActivityProfile {
  tradesPerDay: number;
  /** Share of position rows that are redeems / merges / conversions. */
  redeemMergeShare: number;
  rows: number;
}

/** Recent behaviour from the last PROFILE_DAYS (or as far back as the row cap reaches). */
export function activityProfile(rows: Activity[], from: number, to: number): ActivityProfile {
  const position = rows.filter((r) => POSITION_TYPES.has(r.type));
  const capped = rows.length >= ACTIVITY_ROW_CAP;
  const start = capped && rows.length ? Math.min(...rows.map((r) => r.timestamp)) : from;
  const days = Math.max(1 / 24, (to - start) / DAY);
  const rmc = position.filter(
    (r) => r.type === "REDEEM" || r.type === "MERGE" || r.type === "CONVERSION",
  ).length;
  return {
    tradesPerDay: rows.filter((r) => r.type === "TRADE").length / days,
    redeemMergeShare: position.length ? rmc / position.length : 0,
    rows: rows.length,
  };
}

/** Bot-like recently: too many trades a day, or mostly redeems / merges / conversions. */
export function isBotLike(p: ActivityProfile, maxTradesPerDay: number): boolean {
  return p.tradesPerDay > maxTradesPerDay || p.redeemMergeShare > MAX_REDEEM_MERGE_SHARE;
}

export async function recentProfile(wallet: string, now: number): Promise<ActivityProfile> {
  const from = now - PROFILE_DAYS * DAY;
  const w = await fetchActivityWindow(wallet, from, now);
  return activityProfile(w.rows, from, now);
}
