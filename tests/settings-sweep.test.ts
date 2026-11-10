/**
 * Settings sweep (batch 6): every setting must change behaviour when changed, and no saved
 * value (however large) may break the engine.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DEFAULT_RISK_CONFIG, RiskConfigSchema } from "@/lib/copy/config";
import { runTick } from "@/lib/copy/tick";
import type { Db } from "@/lib/db/client";
import { appSettings, cursors, follows } from "@/lib/db/schema";
import * as clob from "@/lib/polymarket/clob";
import * as data from "@/lib/polymarket/data";
import { getRiskConfig } from "@/lib/settings";

import { createTestDb } from "./helpers/db";

vi.mock("@/lib/polymarket/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/data")>()),
  getActivity: vi.fn(),
  getPositions: vi.fn(),
}));
vi.mock("@/lib/polymarket/clob", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/clob")>()),
  getBook: vi.fn(),
  getMidpoints: vi.fn(),
}));

let db: Db;
let close: () => Promise<void>;
const t0 = Math.floor(Date.now() / 1000);
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(follows).values({ wallet: "0xleader" });
  await db.insert(cursors).values({ wallet: "0xleader", lastTs: t0 - 60 });
  vi.mocked(data.getActivity).mockResolvedValue({
    data: [],
    pagination: { has_more: false, next_cursor: null },
  } as never);
  vi.mocked(clob.getMidpoints).mockResolvedValue(new Map());
});
afterAll(async () => close());

describe("huge values", () => {
  it("maxSignalAgeSeconds: a huge saved value can't break re-checking skipped trades", async () => {
    // 1e13 s turned the retry window's start into an invalid date: every tick logged
    // "retry: Invalid time value" and skipped trades were never re-checked.
    await db
      .insert(appSettings)
      .values({ key: "risk", value: { ...DEFAULT_RISK_CONFIG, maxSignalAgeSeconds: 1e13 } })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: { ...DEFAULT_RISK_CONFIG, maxSignalAgeSeconds: 1e13 } },
      });
    const s = await runTick(db, t0 * 1000, { housekeeping: false });
    expect(s.errors).toEqual([]);
    // Out of range → that one field falls back to its default; the rest is kept.
    expect((await getRiskConfig(db)).maxSignalAgeSeconds).toBe(
      DEFAULT_RISK_CONFIG.maxSignalAgeSeconds,
    );
    const top = RiskConfigSchema.safeParse({ maxSignalAgeSeconds: 7 * 86_400 });
    expect(top.success).toBe(true);
    expect(RiskConfigSchema.safeParse({ maxSignalAgeSeconds: 7 * 86_400 + 1 }).success).toBe(false);
  });
});
