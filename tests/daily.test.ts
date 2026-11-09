/**
 * The daily pipeline's own decisions (src/lib/jobs/daily.ts): when a run counts as a
 * success, and what a failed or partial run must not do. Each stage is stubbed; the stages
 * themselves are tested in jobs/discover/scoring tests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { Db } from "@/lib/db/client";
import { jobRuns } from "@/lib/db/schema";
import { fetchJson } from "@/lib/http";
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
    ranked: WALLETS,
    boards: 1,
    seen: WALLETS.length,
    kept: WALLETS.length,
    fromHolders: 0,
  });
  vi.mocked(backfill.backfillTrader).mockResolvedValue({ positions: 1, pnlPoints: 1 });
  vi.mocked(backfill.resolveMarkets).mockResolvedValue({ fetched: 0, resolved: 0 });
  vi.mocked(backfill.prunePositions).mockResolvedValue(0);
  vi.mocked(backfill.cleanupStorage).mockResolvedValue({
    markets: 0,
    trades: 0,
    snapshots: 0,
    scores: 0,
  });
  vi.mocked(score.scoreAll).mockResolvedValue({
    scored: 6,
    shortlisted: 0,
    verified: 0,
    rejected: [],
    candidates: [],
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

  it("scores only today's rotation picks, and prunes Candidates along with rejected traders", async () => {
    // Designs #3/#8: candidates keep no position history between checks (storage).
    vi.mocked(score.scoreAll).mockResolvedValue({
      scored: 6,
      shortlisted: 0,
      verified: 0,
      rejected: [WALLETS[0]],
      candidates: [WALLETS[1]],
    });
    const stats = await runJob(db, "daily", (log) => dailyJob(db, cfg, opts, log));
    expect(vi.mocked(score.scoreAll).mock.calls[0][4]).toEqual(WALLETS);
    expect(backfill.prunePositions).toHaveBeenCalledWith(db, [WALLETS[0], WALLETS[1]]);
    expect(stats.rotation).toMatchObject({ fresh: 6, recheck: 0 });
  });

  const failFirst = (n: number) =>
    vi.mocked(backfill.backfillTrader).mockImplementation(async (_db, wallet) => {
      if (WALLETS.indexOf(wallet) < n) throw new Error("HTTP 503");
      return { positions: 1, pnlPoints: 1 };
    });
  const lastRun = async () => (await db.select().from(jobRuns)).at(-1)!;

  it("fails when more than half the backfills failed, and still records the counts", async () => {
    // Owner decision (2026-11-08): over 50% failed = no picks, backups retry.
    failFirst(4);
    await expect(runJob(db, "daily", (log) => dailyJob(db, cfg, opts, log))).rejects.toThrow(
      /4 of 6 backfills failed/,
    );
    expect(score.scoreAll).not.toHaveBeenCalled();
    expect(backtest.recordMonthlySelections).not.toHaveBeenCalled();
    expect(backfill.prunePositions).not.toHaveBeenCalled();
    const run = await lastRun();
    expect(run.status).toBe("error");
    expect(run.stats).toMatchObject({ backfill: { traders: 6, failed: 4 } });
    expect(await succeededToday(db, "daily")).toBe(false);
  });

  it("records each step's time and API calls in the run's stats (0957678)", async () => {
    // The slow-run investigation relies on these: which step was slow, and whether it was
    // 429s/retries or plain latency. Each mocked backfill makes one real (stubbed) request.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ ok: true }));
    vi.mocked(backfill.backfillTrader).mockImplementation(async () => {
      await fetchJson("https://x.test/a", { schema: z.object({ ok: z.boolean() }) });
      return { positions: 1, pnlPoints: 1 };
    });
    await runJob(db, "daily", (log) => dailyJob(db, cfg, opts, log));
    fetchSpy.mockRestore();
    const timings = (await lastRun()).stats?.timings as Record<
      string,
      { seconds: number; requests: number; rateLimited: number }
    >;
    expect(Object.keys(timings ?? {}).sort()).toEqual([
      "backfill",
      "backtest",
      "discovery",
      "market resolution",
      "scoring",
    ]);
    expect(timings.backfill.requests).toBe(WALLETS.length);
    expect(timings.scoring.requests).toBe(0);
    expect(timings.backfill.rateLimited).toBe(0);
    expect(timings.backfill.seconds).toBeGreaterThanOrEqual(0);
  });

  it("exactly half failing is still a run (failures listed in the stats)", async () => {
    failFirst(3);
    await runJob(db, "daily", (log) => dailyJob(db, cfg, opts, log));
    expect((await lastRun()).stats).toMatchObject({ backfill: { traders: 6, failed: 3 } });
    expect(backtest.recordMonthlySelections).toHaveBeenCalledTimes(1);
    expect(await succeededToday(db, "daily")).toBe(true);
  });

  it("a shrunken run (--limit 5, --per-board, --top) doesn't count as today's run or record picks", async () => {
    // Regression (J5): a quick local `daily --limit 5` made the scheduled run skip all day
    // and recorded the month's picks from a 5-trader pool.
    const small = [
      { ...opts, discover: { ...opts.discover, maxCandidates: 5 } },
      { ...opts, discover: { ...opts.discover, perBoard: 10 } },
      { ...opts, backtest: { ...opts.backtest, topK: 3 } },
    ];
    const runs = [];
    for (const o of small) runs.push(await runJob(db, "daily", (log) => dailyJob(db, cfg, o, log)));
    expect(await succeededToday(db, "daily")).toBe(false);
    expect(backtest.recordMonthlySelections).not.toHaveBeenCalled();
    expect(runs.map((r) => r.full)).toEqual([false, false, false]);
    // A bigger-than-default pool is still a full run.
    await runJob(db, "daily", (log) =>
      dailyJob(db, cfg, { ...opts, discover: { ...opts.discover, maxCandidates: 300 } }, log),
    );
    expect(backtest.recordMonthlySelections).toHaveBeenCalledTimes(1);
    expect(await succeededToday(db, "daily")).toBe(true);
  });
});
