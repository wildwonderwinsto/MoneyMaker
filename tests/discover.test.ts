import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Db } from "@/lib/db/client";
import { DEFAULT_DISCOVER, discoverCandidates, discoveryScore } from "@/lib/jobs/discover";
import * as data from "@/lib/polymarket/data";
import * as gamma from "@/lib/polymarket/gamma";
import { DEFAULT_SCORING_CONFIG as cfg } from "@/lib/scoring/config";

import { createTestDb } from "./helpers/db";

vi.mock("@/lib/polymarket/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/data")>()),
  getLeaderboard: vi.fn(),
  getUserStats: vi.fn(),
  getHolders: vi.fn(),
}));
vi.mock("@/lib/polymarket/gamma", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/gamma")>()),
  getTopMarkets: vi.fn(),
}));

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("discoveryScore", () => {
  it("prefers a consistent, efficient trader over a one-window whale", () => {
    const steady = discoveryScore({ periods: 3, categories: 1, efficiency: 0.12 });
    const whale = discoveryScore({ periods: 1, categories: 0, efficiency: 0.01 });
    expect(steady).toBeGreaterThan(whale);
  });

  it("caps each component so no single factor dominates", () => {
    expect(discoveryScore({ periods: 9, categories: 9, efficiency: 5 })).toBe(3 + 1 + 3);
    expect(discoveryScore({ periods: 0, categories: 0, efficiency: -1 })).toBe(0);
  });
});

describe("discoverCandidates", () => {
  const W = (n: number) => `0x${String(n).padStart(40, "0")}`;
  const WHALE = W(1);
  const STEADY = W(2);
  const LOSER = W(3);
  const HOLDER = W(4);

  const entry = (wallet: string, rank: number, pnl: number) => ({
    rank,
    user_id: wallet,
    pnl,
    volume: 1,
    user_name: null,
    profile_image: null,
    x_username: null,
    verified: false,
  });

  const stats = (wallet: string, realized: number, volume: number) => ({
    proxy_wallet: wallet,
    trades: 500,
    biggest_win: null,
    join_date: Date.now() / 1000 - 400 * 86_400,
    all_time_pnl: {
      realized_pnl: realized,
      economic_pnl: realized,
      volume_usdc: volume,
      trade_count: 2000,
    },
  });

  it("ranks by quality, adds market holders and drops lifetime losers", async () => {
    vi.mocked(data.getLeaderboard).mockImplementation(async ({ timePeriod }) => ({
      // The whale tops only the weekly board; the steady trader is mid-table everywhere.
      data:
        timePeriod === "week"
          ? [entry(WHALE, 1, 2_000_000), entry(STEADY, 250, 40_000), entry(LOSER, 260, 10)]
          : [entry(STEADY, 240, 90_000)],
      pagination: { has_more: false, next_cursor: null },
    }));
    vi.mocked(gamma.getTopMarkets).mockResolvedValue([
      gamma.GammaMarket.parse({ id: "1", question: "Q?", conditionId: "0xc" }),
    ]);
    vi.mocked(data.getHolders).mockResolvedValue([
      {
        proxy_wallet: HOLDER,
        amount: 5000,
        outcome_index: 0,
        name: "quiet",
        pseudonym: null,
        profile_image: null,
        verified: false,
      },
    ]);
    vi.mocked(data.getUserStats).mockImplementation(async (wallet) => {
      if (wallet === WHALE) return stats(wallet, 2_000_000, 100_000_000); // 2% per $
      if (wallet === STEADY) return stats(wallet, 120_000, 800_000); // 15% per $
      if (wallet === LOSER) return stats(wallet, -5_000, 50_000);
      return stats(wallet, 30_000, 150_000); // holder: 20% per $
    });

    const res = await discoverCandidates(
      db,
      cfg,
      { ...DEFAULT_DISCOVER, categories: ["overall"], timePeriods: ["week", "month", "all"] },
      () => {},
    );

    expect(res.fromHolders).toBe(1);
    expect(res.wallets).not.toContain(LOSER);
    expect(res.wallets).toContain(HOLDER);
    // Steady (3 windows, 15%) ahead of the whale (1 window, 2%) despite rank 250 vs 1.
    expect(res.wallets.indexOf(STEADY)).toBeLessThan(res.wallets.indexOf(WHALE));
  });
});
