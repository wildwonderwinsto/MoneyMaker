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
