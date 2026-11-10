import { describe, expect, it } from "vitest";

import {
  fromDisplay,
  RISK_GROUPS,
  SCORING_GROUPS,
  toDisplay,
  type Group,
} from "@/components/settings/fields";
import { DEFAULT_RISK_CONFIG, RiskConfigSchema } from "@/lib/copy/config";
import { DEFAULT_SCORING_CONFIG, ScoringConfigSchema } from "@/lib/scoring/config";

const names = (groups: Group[]) => groups.flatMap((g) => g.fields.map((f) => f.name));

describe("settings fields", () => {
  it("every field is a real setting, and every risk setting is on screen", () => {
    const risk = Object.keys(RiskConfigSchema.shape);
    const scoring = Object.keys(ScoringConfigSchema.shape);
    for (const n of names(RISK_GROUPS)) expect(risk).toContain(n);
    for (const n of names(SCORING_GROUPS)) expect(scoring).toContain(n);
    expect([...names(RISK_GROUPS)].sort()).toEqual([...risk].sort());
  });

  it("converts units both ways without drift", () => {
    expect(toDisplay("pct", 0.1)).toBe(10);
    expect(fromDisplay("pct", 10)).toBe(0.1);
    expect(toDisplay("cents", 0.92)).toBe(92);
    expect(fromDisplay("cents", 3)).toBe(0.03);
    expect(toDisplay("minutes", 600)).toBe(10);
    expect(fromDisplay("minutes", 2.5)).toBe(150);
    // minMinutesToEnd is already stored in minutes (10 = 10 min, not 0.17).
    expect(toDisplay("min", 10)).toBe(10);
    expect(fromDisplay("min", 10)).toBe(10);
    expect(toDisplay("bps", 25)).toBe(0.25);
    expect(fromDisplay("bps", 0.25)).toBe(25);
  });

  it("round-trips the defaults exactly through the display units", () => {
    for (const [groups, defaults, schema] of [
      [RISK_GROUPS, DEFAULT_RISK_CONFIG, RiskConfigSchema],
      [SCORING_GROUPS, DEFAULT_SCORING_CONFIG, ScoringConfigSchema],
    ] as const) {
      const out: Record<string, unknown> = { ...defaults };
      for (const f of groups.flatMap((g) => g.fields)) {
        if (f.kind !== "number") continue;
        const v = (defaults as Record<string, number>)[f.name];
        out[f.name] = fromDisplay(f.unit, toDisplay(f.unit, v));
      }
      expect(schema.parse(out)).toEqual(defaults);
    }
  });

  it("switching sizing to fixed validates and sticks", () => {
    const next = RiskConfigSchema.parse({
      ...DEFAULT_RISK_CONFIG,
      sizingMode: "fixed",
      fixedUsd: 30,
    });
    expect(next.sizingMode).toBe("fixed");
    expect(next.fixedUsd).toBe(30);
  });
});

describe("settings that contradict each other (UI-09)", () => {
  it("rejects a minimum entry price above the maximum, naming the field", () => {
    const r = RiskConfigSchema.safeParse({ minEntryPrice: 0.6, maxEntryPrice: 0.4 });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].path).toEqual(["minEntryPrice"]);
    expect(RiskConfigSchema.safeParse({ minEntryPrice: 0.4, maxEntryPrice: 0.4 }).success).toBe(
      true,
    );
  });
});

describe("the weight box (UI-10)", () => {
  it("a blank or invalid entry is no change, not 0×", async () => {
    const { parseWeight } = await import("@/components/settings/fields");
    expect(parseWeight("")).toBeNull();
    expect(parseWeight("   ")).toBeNull();
    expect(parseWeight("abc")).toBeNull();
    expect(parseWeight("6")).toBeNull();
    expect(parseWeight("0")).toBe(0);
    expect(parseWeight("1.25")).toBe(1.25);
  });
});

describe("caps that would silently block every buy at 0", () => {
  it.each([
    ["maxDailyLossPct", "Daily loss limit"],
    ["maxPositionPct", "Most in one market"],
    ["maxTraderExposurePct", "Most with one trader"],
    ["hedgeMaxCostPct", "Most to spend on one hedge"],
  ])("rejects 0 and negatives for %s, naming the field", (field, label) => {
    for (const v of [0, -0.1]) {
      const r = RiskConfigSchema.safeParse({ [field]: v });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0].path).toEqual([field]);
      expect(r.error?.issues[0].message).toContain(label);
    }
    expect(RiskConfigSchema.safeParse({ [field]: 0.01 }).success).toBe(true);
  });
});

describe("settings that no longer change anything are gone (batch 6)", () => {
  it("minZ and simulations aren't stored settings; old saved values are dropped, the rest kept", async () => {
    const { parseSetting } = await import("@/lib/settings");
    const keys = Object.keys(ScoringConfigSchema.shape);
    expect(keys).not.toContain("minZ");
    expect(keys).not.toContain("simulations");
    const legacy = parseSetting(ScoringConfigSchema, {
      minZ: 9,
      simulations: 100,
      minResolved: 60,
    });
    expect(legacy.minResolved).toBe(60);
    expect(legacy).not.toHaveProperty("minZ");
    expect(legacy).not.toHaveProperty("simulations");
  });

  it("the display-only luck p-value still runs at its fixed precision", async () => {
    const { monteCarloPValue, MC_SIMULATIONS } = await import("@/lib/scoring/metrics");
    expect(MC_SIMULATIONS).toBe(2000);
    const bet = { avgPrice: 0.5, sharesBought: 10, won: true } as never;
    const p = monteCarloPValue([bet], DEFAULT_SCORING_CONFIG, "0xw")!;
    // One coin flip won: about half of 2,000 random draws match it.
    expect(p).toBeGreaterThan(0.4);
    expect(p).toBeLessThan(0.6);
    expect(Math.round(p * (MC_SIMULATIONS + 1)) / (MC_SIMULATIONS + 1)).toBeCloseTo(p, 12);
  });
});

describe("error messages under a field (batch 6)", () => {
  const field = (name: string) => {
    const f = RISK_GROUPS.flatMap((g) => g.fields).find((x) => x.name === name)!;
    return f;
  };
  it("shows the real reason when the value is inside the field's range", async () => {
    const { humanIssue } = await import("@/components/settings/fields");
    const minAboveMax = RiskConfigSchema.safeParse({ minEntryPrice: 0.6, maxEntryPrice: 0.4 });
    const msg = minAboveMax.error!.issues[0].message;
    // Was "Use 0 ¢ to 100 ¢", although 60¢ is inside that range.
    expect(humanIssue(msg, field("minEntryPrice"), 60)).toBe(msg);
    const zeroCap = RiskConfigSchema.safeParse({ maxPositionPct: 0 });
    expect(humanIssue(zeroCap.error!.issues[0].message, field("maxPositionPct"), 0)).toBe(
      "Most in one market must be above 0",
    );
  });
  it("names the range when the value is outside it", async () => {
    const { humanIssue } = await import("@/components/settings/fields");
    expect(humanIssue("Too big", field("maxPositionPct"), 150)).toBe("Use 0 % to 100 %");
    expect(humanIssue("Too small", field("maxSignalAgeSeconds"), 0.1)).toBe(
      "Use 0.5 min to 10080 min",
    );
  });
});

describe("scoring bounds (owner, 2026-11-10)", () => {
  it.each([
    ["maxTradesPerDay", 0],
    ["maxTradesPerDay", -5],
    ["roiShrinkK", -1],
    ["roiShrinkK", 1001],
    ["copyLossZ", 5],
    ["minEntryPrice", -0.1],
    ["maxEntryPrice", 1.2],
  ])("rejects %s = %d", (field, v) => {
    const r = ScoringConfigSchema.safeParse({ [field]: v });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].path).toEqual([field]);
  });
  it("rejects an entry band whose minimum is above its maximum, naming the field", () => {
    const r = ScoringConfigSchema.safeParse({ minEntryPrice: 0.6, maxEntryPrice: 0.4 });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].path).toEqual(["minEntryPrice"]);
  });
  it("accepts the defaults and the edges", () => {
    for (const v of [
      { maxTradesPerDay: 0.5 },
      { roiShrinkK: 0 },
      { roiShrinkK: 1000 },
      { minEntryPrice: 0, maxEntryPrice: 1 },
    ])
      expect(ScoringConfigSchema.safeParse(v).success).toBe(true);
  });
});
