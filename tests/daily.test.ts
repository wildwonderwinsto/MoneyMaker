/**
 * The daily pipeline's own decisions (src/lib/jobs/daily.ts): when a run counts as a
 * success, and what a failed or partial run must not do. Each stage is stubbed; the stages
 * themselves are tested in jobs/discover/scoring tests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@/lib/db/client";
import { jobRuns } from "@/lib/db/schema";
import * as backfill from "@/lib/jobs/backfill";
import * as backtest from "@/lib/jobs/backtest";
import { dailyJob } from "@/lib/jobs/daily";
import * as discover from "@/lib/jobs/discover";
import * as score from "@/lib/jobs/score";
import { runJob, succeededToday } from "@/lib/jobs/util";
import { DEFAULT_BACKTEST } from "@/lib/scoring/backtest";
import { DEFAULT_SCORING_CONFIG as cfg } from "@/lib/scoring/config";

import { createTestDb } from "./helpers/db";

vi.mock("@/lib/jobs/discover", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/discover")>()),
  discoverCandidates: vi.fn(),
}));
vi.mock("@/lib/jobs/backfill", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/backfill")>()),
  backfillTrader: vi.fn(),
  resolveMarkets: vi.fn(),
  prunePositions: vi.fn(),
  cleanupStorage: vi.fn(),
}));
vi.mock("@/lib/jobs/score", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/score")>()),
  scoreAll: vi.fn(),
}));
vi.mock("@/lib/jobs/backtest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/backtest")>()),
  recordMonthlySelections: vi.fn(),
  backtestJob: vi.fn(),
}));

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

const WALLETS = Array.from({ length: 6 }, (_, i) => `0x${String(i).padStart(40, "0")}`);
const opts = {
  discover: discover.DEFAULT_DISCOVER,
  backtest: DEFAULT_BACKTEST,
  prune: true,
};

beforeEach(async () => {
  vi.clearAllMocks();
  await db.delete(jobRuns);
  vi.mocked(discover.discoverCandidates).mockResolvedValue({
    wallets: WALLETS,
    boards: 1,
    seen: WALLETS.length,
    kept: WALLETS.length,
    fromHolders: 0,
  });
  vi.mocked(backfill.backfillTrader).mockResolvedValue({ positions: 1, pnlPoints: 1 });
  vi.mocked(backfill.resolveMarkets).mockResolvedValue({ fetched: 0, resolved: 0 });
  vi.mocked(backfill.prunePositions).mockResolvedValue(0);
  vi.mocked(backfill.cleanupStorage).mockResolvedValue({ markets: 0, trades: 0, snapshots: 0 });
  vi.mocked(score.scoreAll).mockResolvedValue({
    scored: 6,
    shortlisted: 0,
    verified: 0,
    rejected: [],
  });
  vi.mocked(backtest.recordMonthlySelections).mockResolvedValue({
    month: "2026-11",
    strategy: 0,
    baseline: 0,
  });
  vi.mocked(backtest.backtestJob).mockResolvedValue(
    {} as Awaited<ReturnType<typeof backtest.backtestJob>>,
  );
});

describe("daily job health", () => {
  it("a normal run succeeds and counts as today's run", async () => {
    await runJob(db, "daily", (log) => dailyJob(db, cfg, opts, log));
    expect(await succeededToday(db, "daily")).toBe(true);
  });

  it("fails, and scores/records/prunes nothing, when every backfill failed", async () => {
    // Regression (J4): 150 of 150 backfills failed, yet the run re-scored stale history,
    // recorded the month's picks, pruned, and was marked ok, so the backups skipped.
    vi.mocked(backfill.backfillTrader).mockRejectedValue(new Error("HTTP 503"));
    await expect(runJob(db, "daily", (log) => dailyJob(db, cfg, opts, log))).rejects.toThrow(
      /6 of 6 backfills failed/,
    );
    expect(score.scoreAll).not.toHaveBeenCalled();
    expect(backtest.recordMonthlySelections).not.toHaveBeenCalled();
    expect(backfill.prunePositions).not.toHaveBeenCalled();
    expect(await succeededToday(db, "daily")).toBe(false);
  });
});
