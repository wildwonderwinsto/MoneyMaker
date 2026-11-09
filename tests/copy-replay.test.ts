/**
 * Copy replays (stage 2 of scoring) with the Polymarket APIs mocked.
 *
 * Storage (owner, 2026-11-09): the leader's raw trades used to be copied into trader_trades
 * (up to 2,000 per shortlisted trader, kept 120 days, 53% of live data in a local run) but
 * nothing ever read them. Replays must still be built; nothing may be stored.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Db } from "@/lib/db/client";
import { traderTrades } from "@/lib/db/schema";
import { buildCopyReplays, DEFAULT_SCORE } from "@/lib/jobs/score";
import * as clob from "@/lib/polymarket/clob";
import * as data from "@/lib/polymarket/data";
import * as gamma from "@/lib/polymarket/gamma";
import { DEFAULT_SCORING_CONFIG as cfg } from "@/lib/scoring/config";

import { createTestDb } from "./helpers/db";

vi.mock("@/lib/polymarket/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/data")>()),
  getActivity: vi.fn(),
}));
vi.mock("@/lib/polymarket/clob", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/clob")>()),
  getPriceHistory: vi.fn(),
  getMidpoints: vi.fn(),
}));
vi.mock("@/lib/polymarket/gamma", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polymarket/gamma")>()),
  getMarketsByConditionIds: vi.fn(),
}));

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

const NOW = Math.floor(Date.now() / 1000);
const buy = (i: number): data.Activity => ({
  proxy_wallet: "0xleader",
  timestamp: NOW - 86_400 * (i + 2),
  condition_id: `c${i}`,
  type: "TRADE",
  size: 100,
  usdc_size: 50,
  transaction_hash: `0xtx${i}`,
  price: 0.5,
  token_id: `t${i}`,
  side: "BUY",
  outcome_index: 0,
  title: null,
  slug: null,
  icon: null,
  event_slug: null,
  outcome: "Yes",
  name: null,
  pseudonym: null,
});

describe("buildCopyReplays", () => {
  it("replays the leader's buys without storing their raw trades", async () => {
    vi.mocked(data.getActivity).mockResolvedValue({
      data: [buy(0), buy(1), buy(2)],
      pagination: { has_more: false, next_cursor: null },
    } as never);
    vi.mocked(gamma.getMarketsByConditionIds).mockResolvedValue([]);
    vi.mocked(clob.getMidpoints).mockResolvedValue(
      new Map([
        ["t0", 0.6],
        ["t1", 0.55],
        ["t2", 0.4],
      ]),
    );
    vi.mocked(clob.getPriceHistory).mockImplementation(async (_t, o) => [
      { t: (o.startTs ?? 0) + 120, p: 0.5 },
    ]);
    const replays = await buildCopyReplays(db, "0xleader", cfg, DEFAULT_SCORE, NOW);
    expect(replays).toHaveLength(3);
    expect(await db.select().from(traderTrades)).toEqual([]);
  });
});
