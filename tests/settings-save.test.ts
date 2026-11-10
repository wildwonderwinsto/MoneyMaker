/**
 * Saving settings (batch 6): a Settings tab left open with old values must not overwrite
 * settings saved since it loaded (from another tab, device or admin).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { saveSettingsAction } from "@/app/actions";
import { DEFAULT_RISK_CONFIG } from "@/lib/copy/config";
import type { Db } from "@/lib/db/client";
import { DEFAULT_SCORING_CONFIG } from "@/lib/scoring/config";
import { getRiskConfig, getScoringConfig } from "@/lib/settings";

import { createTestDb } from "./helpers/db";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ refresh: () => {} }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
vi.mock("@/lib/admin", () => ({
  requireAdmin: async () => {},
  checkPasswordAndSetCookie: async () => false,
  clearAdminCookie: async () => {},
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("stale Settings tab", () => {
  it("a tab opened before another save can't overwrite it; a fresh tab can save", async () => {
    // Two tabs open on the defaults.
    const tabA = { ...DEFAULT_RISK_CONFIG };
    const tabB = { ...DEFAULT_RISK_CONFIG };

    // Tab A saves a lower daily loss limit.
    const a = await saveSettingsAction("risk", { ...tabA, maxDailyLossPct: 0.05 }, tabA);
    expect(a.ok).toBe(true);
    expect((await getRiskConfig(db)).maxDailyLossPct).toBe(0.05);

    // Tab B (still showing the old values) changes something else and saves.
    const b = await saveSettingsAction("risk", { ...tabB, minLeaderUsd: 50 }, tabB);
    expect(b.ok).toBe(false);
    expect(b.message).toMatch(/changed .*since this page loaded/i);
    const now = await getRiskConfig(db);
    expect(now.maxDailyLossPct).toBe(0.05); // tab A's change survived
    expect(now.minLeaderUsd).toBe(DEFAULT_RISK_CONFIG.minLeaderUsd);

    // After a reload tab B sees A's values and its save goes through.
    const reloaded = await getRiskConfig(db);
    const b2 = await saveSettingsAction("risk", { ...reloaded, minLeaderUsd: 50 }, reloaded);
    expect(b2.ok).toBe(true);
    expect(await getRiskConfig(db)).toMatchObject({ maxDailyLossPct: 0.05, minLeaderUsd: 50 });
  });

  it("applies to the verification rules too, and a save without what the tab loaded is refused", async () => {
    const tab = await getScoringConfig(db);
    expect(tab).toEqual(DEFAULT_SCORING_CONFIG);
    expect((await saveSettingsAction("scoring", { ...tab, minResolved: 60 }, tab)).ok).toBe(true);
    const stale = await saveSettingsAction("scoring", { ...tab, minEvents: 30 }, tab);
    expect(stale.ok).toBe(false);
    expect((await getScoringConfig(db)).minResolved).toBe(60);
    // Old clients that don't send what they loaded can't overwrite blindly.
    const blind = await saveSettingsAction("scoring", { ...tab, minEvents: 30 }, undefined);
    expect(blind.ok).toBe(false);
    expect((await getScoringConfig(db)).minEvents).toBe(DEFAULT_SCORING_CONFIG.minEvents);
  });
});
