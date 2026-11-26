/**
 * Owner, 2026-11-26: worst single-market loss and sizing skill are shown on the trader page
 * (display only, no checks), and Stage 2's shortlist puts would-be Verified/Elite/Candidate
 * traders ahead of the Watchlist (tierIfCopyable).
 */
import { describe, expect, it } from "vitest";

import type { ScoreCheck } from "@/lib/db/schema";
import { DEFAULT_SCORING_CONFIG } from "@/lib/scoring/config";
import {
  concentration,
  sizingSkill,
  type PositionRecord,
  type TraderMetrics,
} from "@/lib/scoring/metrics";
import { tierIfCopyable, type ScoreResult } from "@/lib/scoring/score";

const pos = (conditionId: string, cost: number, pnl: number): PositionRecord =>
  ({
    conditionId,
    tokenId: `${conditionId}-yes`,
    eventId: null,
    category: null,
    avgPrice: 0.5,
    sharesBought: cost / 0.5,
    realizedPnl: pnl,
    unrealizedPnl: 0,
    closed: true,
    won: null,
    firstEntryAt: null,
    lastActivityAt: null,
    endAt: null,
  }) as PositionRecord;

describe("worst single-market loss", () => {
  it("is the most negative market result, both legs combined, and its share of gross profit", () => {
    const c = concentration([
      pos("a", 100, 300),
      pos("b", 100, 100),
      pos("c", 100, -150),
      { ...pos("c", 100, -50), tokenId: "c-no" },
    ]);
    expect(c.worstMarketLoss).toBe(-200);
    expect(c.worstLossShare).toBeCloseTo(0.5, 6);
  });

  it("is 0 when no market lost money, null with no positions", () => {
    expect(concentration([pos("a", 100, 10)]).worstMarketLoss).toBe(0);
    expect(concentration([]).worstMarketLoss).toBeNull();
  });
});

describe("sizing skill", () => {
  it("is positive when the big bets do better than the small ones", () => {
    // Small bets lose 10%, the big bet makes 20%.
    const r = sizingSkill([pos("a", 10, -1), pos("b", 10, -1), pos("c", 1000, 200)]);
    expect(r.equalWeightRoi).toBeCloseTo((-0.1 - 0.1 + 0.2) / 3, 6);
    expect(r.sizingSkill).toBeCloseTo(198 / 1020 - r.equalWeightRoi!, 6);
    expect(r.sizingSkill!).toBeGreaterThan(0);
  });

  it("is negative when the big bets do worse (the 3× conviction sizing would hurt)", () => {
    const r = sizingSkill([pos("a", 10, 2), pos("b", 10, 2), pos("c", 1000, -300)]);
    expect(r.sizingSkill!).toBeLessThan(0);
  });

  it("ignores positions under $1 and is null without any", () => {
    expect(sizingSkill([pos("a", 0.5, 5)])).toEqual({ sizingSkill: null, equalWeightRoi: null });
    expect(sizingSkill([pos("a", 0.5, 5), pos("b", 10, 1)]).sizingSkill).toBeCloseTo(0, 9);
  });
});

describe("tierIfCopyable", () => {
  const check = (code: string, ok: boolean): ScoreCheck => ({
    code,
    label: code,
    ok,
    value: null,
    threshold: null,
  });
  const m = { nHoldout: 10, sinceVerifiedDays: null } as unknown as TraderMetrics;
  const result = (checks: ScoreCheck[]): ScoreResult => ({
    tier: "watchlist",
    score: 50,
    passed: false,
    checks,
  });

  it("a Candidate that only fails copy ROI before replay counts as a Candidate", () => {
    const r = result([check("skill", false), check("copy_roi", false), check("sample", true)]);
    expect(tierIfCopyable(m, r, DEFAULT_SCORING_CONFIG)).toBe("candidate");
  });

  it("a trader that only fails copy ROI counts as Verified", () => {
    const r = result([check("copy_roi", false), check("sample", true)]);
    expect(tierIfCopyable(m, r, DEFAULT_SCORING_CONFIG)).toBe("verified");
  });

  it("a trader with another failed check stays on the Watchlist", () => {
    const r = result([check("copy_roi", false), check("recent", false)]);
    expect(tierIfCopyable(m, r, DEFAULT_SCORING_CONFIG)).toBe("watchlist");
  });
});
