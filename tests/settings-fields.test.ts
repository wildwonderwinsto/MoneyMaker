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
