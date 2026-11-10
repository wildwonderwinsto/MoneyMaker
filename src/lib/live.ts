/** Grouping for the Live feed (pure). */
import { codeFromReason } from "@/lib/explain";

export interface GroupableSignal {
  id: string;
  wallet: string;
  tokenId: string;
  side: string;
  decision: string;
  reason: string;
  reasonCode: string | null;
  groupId: string | null;
  leaderTs: Date;
  leaderPrice: number;
  leaderSize: number;
  leaderUsdc: number;
}

export interface SignalGroup<T extends GroupableSignal> {
  key: string;
  /** Newest first, like the feed. */
  rows: T[];
  head: T;
  totalUsdc: number;
  totalShares: number;
  avgPrice: number;
}

/**
 * Collapse consecutive signals that are really one thing: the same trader buying or
 * selling the same outcome in several pieces, with the same decision for the same
 * reason, within 15 minutes. Signals the engine itself merged always stay together.
 */
export function groupSignals<T extends GroupableSignal>(rows: T[], windowMs = 15 * 60_000) {
  const groups: SignalGroup<T>[] = [];
  const keyOf = (r: T) =>
    [r.wallet, r.tokenId, r.side, r.decision, r.reasonCode ?? codeFromReason(r.reason)].join("|");
  let cur: SignalGroup<T> | null = null;
  let curKey = "";
  for (const r of rows) {
    const k = keyOf(r);
    const last: T | undefined = cur?.rows.at(-1);
    const sameEngineGroup = !!r.groupId && !!last && last.groupId === r.groupId;
    const close = !!last && Math.abs(last.leaderTs.getTime() - r.leaderTs.getTime()) <= windowMs;
    if (cur && (sameEngineGroup || (k === curKey && close))) {
      cur.rows.push(r);
      continue;
    }
    cur = { key: r.id, rows: [r], head: r, totalUsdc: 0, totalShares: 0, avgPrice: 0 };
    curKey = k;
    groups.push(cur);
  }
  for (const g of groups) {
    g.totalUsdc = g.rows.reduce((a, r) => a + r.leaderUsdc, 0);
    g.totalShares = g.rows.reduce((a, r) => a + r.leaderSize, 0);
    g.avgPrice = g.totalShares > 0 ? g.totalUsdc / g.totalShares : g.head.leaderPrice;
  }
  return groups;
}

const HOUR = 3_600_000;

/** Feed sections by age (time zone independent, so server and browser agree). */
export function sectionsByAge<T extends GroupableSignal>(
  groups: SignalGroup<T>[],
  now = Date.now(),
): Array<[label: string, groups: SignalGroup<T>[]]> {
  const sections: Array<[string, SignalGroup<T>[]]> = [
    ["Last hour", []],
    ["Last 24 hours", []],
    ["Older", []],
  ];
  for (const g of groups) {
    const age = now - g.head.leaderTs.getTime();
    sections[age < HOUR ? 0 : age < 24 * HOUR ? 1 : 2][1].push(g);
  }
  return sections.filter(([, list]) => list.length > 0);
}

/** Last 24 hours of the feed: counts per decision and the most common skip reasons. */
export function summarize<T extends GroupableSignal>(groups: SignalGroup<T>[], now = Date.now()) {
  const recent = groups.filter((g) => now - g.head.leaderTs.getTime() < 24 * HOUR);
  const count = (d: string) => recent.filter((g) => g.head.decision === d).length;
  const reasons = new Map<string, { label: string; n: number }>();
  for (const g of recent) {
    if (g.head.decision !== "skipped") continue;
    const key = g.head.reasonCode ?? codeFromReason(g.head.reason);
    const r = reasons.get(key) ?? { label: g.head.reason, n: 0 };
    r.n++;
    reasons.set(key, r);
  }
  return {
    total: recent.length,
    copied: count("copied"),
    closed: count("closed"),
    skipped: count("skipped"),
    topSkipReasons: [...reasons.values()].sort((a, b) => b.n - a.n).slice(0, 3),
  };
}

/**
 * A position's story, oldest first. At the same moment the trader's trade comes first: our
 * fill is a copy of it, so it can't have happened before.
 */
export function chronological<T extends { ts: Date; kind: "trader" | "ours" }>(items: T[]): T[] {
  const rank = { trader: 0, ours: 1 } as const;
  return [...items].sort((a, b) => a.ts.getTime() - b.ts.getTime() || rank[a.kind] - rank[b.kind]);
}
