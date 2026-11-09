/**
 * Cheap Candidate re-checks (owner decision 2026-11-09, capacity option b).
 *
 * Between full checks (every 4 weeks), a Candidate is re-checked from its post-pick
 * positions only: their skill evidence is folded into the running total (the same one full
 * checks use) and judged. A cheap re-check never promotes: proven evidence sets
 * `full_check_due`, and the next full check (every check, fresh history) decides. Clear
 * evidence of no edge, or the 180-day limit without proof, rejects.
 */
import { eq, inArray } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import { type ScoreCheck, traders, traderScores } from "@/lib/db/schema";
import type { ScoringConfig } from "@/lib/scoring/config";
import { computeMetrics, NO_EDGE_EVIDENCE, type TraderMetrics } from "@/lib/scoring/metrics";
import { buildChecks } from "@/lib/scoring/score";
import { eBenjaminiHochbergThreshold } from "@/lib/scoring/stats";

import { backfillPostPick, prunePositions, resolveMarkets } from "./backfill";
import {
  loadEvidence,
  loadInputs,
  recentTestedEValues,
  saveEvidence,
  withRunningEvidence,
} from "./score";
import { mapPool, toEpoch } from "./util";

export type LightDecision = "full_check" | "reject" | "keep";

/** Proven → a full check decides; disproven or timed out → rejected; else still a Candidate. */
export function lightDecision(
  m: TraderMetrics,
  cfg: ScoringConfig,
  eThreshold: number,
): LightDecision {
  if ((m.nHoldout ?? 0) >= cfg.minResolved && m.eSkill >= eThreshold) return "full_check";
  if (m.eNoEdge >= NO_EDGE_EVIDENCE || (m.holdoutDays ?? 0) >= cfg.maxCandidateDays)
    return "reject";
  return "keep";
}

export async function lightCheck(
  db: Db,
  cfg: ScoringConfig,
  wallets: string[],
  log: (m: string) => void,
  now = Math.floor(Date.now() / 1000),
): Promise<{ checked: number; fullCheckDue: number; rejected: number; failed: number }> {
  if (wallets.length === 0) return { checked: 0, fullCheckDue: 0, rejected: 0, failed: 0 };
  const rows = await db
    .select({ w: traders.wallet, holdout: traders.holdoutFrom, first: traders.firstCheckedAt })
    .from(traders)
    .where(inArray(traders.wallet, wallets));
  let failed = 0;
  const ok: string[] = [];
  await mapPool(rows, 2, async (r) => {
    const from = toEpoch(r.holdout ?? r.first);
    if (from === null) return;
    try {
      await backfillPostPick(db, r.w, from);
      ok.push(r.w);
    } catch {
      failed++;
    }
  });
  await resolveMarkets(db, () => {});

  const { inputs } = await loadInputs(db, ok, now);
  const states = await loadEvidence(db, ok);
  const quick = { ...cfg, simulations: 100 }; // the luck p-value is display-only
  const metrics = new Map<string, TraderMetrics>();
  for (const [w, input] of inputs) {
    metrics.set(w, withRunningEvidence(computeMetrics(input, quick), input, states, cfg));
  }
  const earlier = await recentTestedEValues(
    db,
    new Date((now - 30 * 86_400) * 1000),
    new Set(ok),
    cfg.minResolved,
  );
  const pool = [
    ...earlier,
    ...[...metrics.values()]
      .filter((m) => (m.nHoldout ?? 0) >= cfg.minResolved)
      .map((m) => m.eSkill),
  ];
  const ctx = { eThreshold: eBenjaminiHochbergThreshold(pool, cfg.fdrQ), candidates: pool.length };

  const stored = new Map(
    (ok.length
      ? await db.select().from(traderScores).where(inArray(traderScores.wallet, ok))
      : []
    ).map((r) => [r.wallet, r]),
  );
  let due = 0;
  let rejected = 0;
  const at = new Date(now * 1000);
  for (const [w, m] of metrics) {
    const decision = lightDecision(m, cfg, ctx.eThreshold);
    const prev = stored.get(w);
    // Other checks keep the last full check's values; only the skill ones are new.
    const merged = {
      ...((prev?.metrics ?? {}) as unknown as TraderMetrics),
      eSkill: m.eSkill,
      eNoEdge: m.eNoEdge,
      nHoldout: m.nHoldout,
      holdoutDays: m.holdoutDays,
    };
    const checks: ScoreCheck[] = buildChecks(merged, cfg, ctx);
    if (decision === "full_check") due++;
    if (decision === "reject") rejected++;
    await db
      .update(traderScores)
      .set({
        tier: decision === "reject" ? "rejected" : "candidate",
        passed: false,
        checks,
        metrics: merged as unknown as Record<string, unknown>,
        computedAt: at,
      })
      .where(eq(traderScores.wallet, w));
    await db
      .update(traders)
      .set({ lastCheckedAt: at, fullCheckDue: decision === "full_check" })
      .where(eq(traders.wallet, w));
  }
  await saveEvidence(db, states);
  await prunePositions(db, ok);
  log(
    `cheap re-checks: ${metrics.size} Candidates (${due} proven → full check next, ${rejected} rejected, ${failed} failed)`,
  );
  return { checked: metrics.size, fullCheckDue: due, rejected, failed };
}
