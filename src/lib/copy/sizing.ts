import type { ReasonCode } from "@/lib/db/schema";

import type { RiskConfig } from "./config";

export interface SizingInput {
  equity: number;
  cash: number;
  /** USDC the leader spent on this trade. */
  leaderUsd: number;
  /** Leader's open-positions value (from /v2/value); 0 if unknown. */
  leaderPortfolioUsd: number;
  /** Follow weight for this leader. */
  weight: number;
  /** Our current cost basis in this market (all leaders) and with this leader. */
  marketExposure: number;
  traderExposure: number;
}

type Details = Record<string, number | string | boolean | null>;

export type SizingResult =
  | { usd: number; details: Details }
  | { usd: 0; reason: string; code: ReasonCode; details: Details };

/** How many USDC to put into a copied buy, after every risk cap. */
export function sizeBuy(input: SizingInput, cfg: RiskConfig): SizingResult {
  const { equity, cash, leaderUsd, leaderPortfolioUsd, weight } = input;
  if (equity <= 0 || cash <= 0) {
    return { usd: 0, reason: "No cash available", code: "no_cash", details: { cash, equity } };
  }
  if (leaderUsd < cfg.minLeaderUsd) {
    return {
      usd: 0,
      reason: `Leader trade too small ($${leaderUsd.toFixed(2)})`,
      code: "leader_too_small",
      details: { leaderUsd, minLeaderUsd: cfg.minLeaderUsd },
    };
  }

  let usd: number;
  let leaderFraction: number | null = null;
  if (cfg.sizingMode === "fixed") {
    usd = cfg.fixedUsd * weight;
  } else {
    // Fraction of the leader's book they just committed (their conviction).
    const leaderBook = Math.max(leaderPortfolioUsd, leaderUsd);
    leaderFraction = leaderBook > 0 ? leaderUsd / leaderBook : 0;
    usd = Math.max(equity * leaderFraction * cfg.proportionalMultiplier, cfg.minCopyUsd) * weight;
  }
  const wanted = usd;

  const caps: Array<[number, string, ReasonCode]> = [
    [equity * cfg.maxPositionPct - input.marketExposure, "Per-market limit reached", "market_cap"],
    [
      equity * cfg.maxTraderExposurePct - input.traderExposure,
      "Per-trader limit reached",
      "trader_cap",
    ],
    [cash, "Not enough cash", "no_cash"],
  ];
  let binding: { reason: string; code: ReasonCode } | null = null;
  for (const [cap, reason, code] of caps) {
    if (cap < usd) {
      usd = Math.max(0, cap);
      binding = { reason, code };
    }
  }

  const details: Details = {
    sizingMode: cfg.sizingMode,
    wantedUsd: wanted,
    usd,
    leaderFraction,
    weight,
    cappedBy: binding?.code ?? null,
  };
  if (usd < cfg.minOrderUsd) {
    return {
      usd: 0,
      reason:
        binding?.reason ?? `Copy size $${usd.toFixed(2)} is below the $${cfg.minOrderUsd} minimum`,
      code: binding?.code ?? "below_min_order",
      details: { ...details, minOrderUsd: cfg.minOrderUsd },
    };
  }
  return { usd, details };
}
