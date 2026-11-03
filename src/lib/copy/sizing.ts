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

export type SizingResult = { usd: number } | { usd: 0; reason: string };

/** How many USDC to put into a copied buy, after every risk cap. */
export function sizeBuy(input: SizingInput, cfg: RiskConfig): SizingResult {
  const { equity, cash, leaderUsd, leaderPortfolioUsd, weight } = input;
  if (equity <= 0 || cash <= 0) return { usd: 0, reason: "No cash available" };
  if (leaderUsd < cfg.minLeaderUsd) {
    return { usd: 0, reason: `Leader trade too small ($${leaderUsd.toFixed(2)})` };
  }

  let usd: number;
  if (cfg.sizingMode === "fixed") {
    usd = cfg.fixedUsd * weight;
  } else {
    // Fraction of the leader's book they just committed (their conviction).
    const leaderBook = Math.max(leaderPortfolioUsd, leaderUsd);
    const fraction = leaderBook > 0 ? leaderUsd / leaderBook : 0;
    usd = Math.max(equity * fraction * cfg.proportionalMultiplier, cfg.minCopyUsd) * weight;
  }

  const caps: Array<[number, string]> = [
    [equity * cfg.maxPositionPct - input.marketExposure, "Per-market limit reached"],
    [equity * cfg.maxTraderExposurePct - input.traderExposure, "Per-trader limit reached"],
    [cash, "Not enough cash"],
  ];
  let binding: string | null = null;
  for (const [cap, reason] of caps) {
    if (cap < usd) {
      usd = Math.max(0, cap);
      binding = reason;
    }
  }

  if (usd < cfg.minOrderUsd) {
    return {
      usd: 0,
      reason: binding ?? `Copy size $${usd.toFixed(2)} is below the $${cfg.minOrderUsd} minimum`,
    };
  }
  return { usd };
}
