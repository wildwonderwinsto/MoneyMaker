/** Market info: Gamma lookups and the DB cache the copy engine reads (src/lib/copy/markets.ts). */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { getMarketInfo } from "@/lib/copy/markets";
import type { Db } from "@/lib/db/client";
import { markets } from "@/lib/db/schema";
import { getMarketsByConditionIds } from "@/lib/polymarket/gamma";

import { createTestDb } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());
afterEach(() => vi.unstubAllGlobals());

const gammaMarket = (conditionId: string, closed: boolean) => ({
  id: conditionId,
  question: `${conditionId}?`,
  conditionId,
  closed,
  outcomes: '["Yes","No"]',
  outcomePrices: closed ? '["1","0"]' : '["0.6","0.4"]',
  clobTokenIds: `["${conditionId}-yes","${conditionId}-no"]`,
  feesEnabled: true,
  feeSchedule: { rate: 0.05, exponent: 1 },
});

/** Gamma answering per `closed=` request with the given markets. */
function stubGamma(answer: (closed: boolean) => unknown[]) {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const closed = new URL(String(url)).searchParams.get("closed") === "true";
    return Response.json({ markets: answer(closed), next_cursor: null });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("getMarketsByConditionIds", () => {
  it("returns a market once even if it shows up as both open and closed", async () => {
    // Regression (C-F18): the open and closed requests run together, so a market closing
    // in between came back twice; one upsert with the same key twice is a Postgres error
    // ("ON CONFLICT DO UPDATE command cannot affect row a second time").
    stubGamma((closed) => [gammaMarket("0xflip", closed)]);
    const found = await getMarketsByConditionIds(["0xflip"]);
    expect(found).toHaveLength(1);
    expect(found[0].closed).toBe(true); // the settled state wins

    const info = await getMarketInfo(db, ["0xflip"]);
    expect(info.get("0xflip")?.winnerIndex).toBe(0);
  });
});
