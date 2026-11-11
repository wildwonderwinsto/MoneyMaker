import type { ReasonCode } from "@/lib/db/schema";

import type { RiskConfig } from "./config";

export interface SizingInput {
  equity: number;
  cash: number;
  /** USDC the leader spent on this trade. */
  leaderUsd: number;
  /** Leader's usual stake per market (traders.typicalStakeUsd); null if not known yet. */
  leaderTypicalUsd: number | null;
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

/**
 * Whether the account can pay for even the smallest order. Checked before anything else
 * (owner, 2026-11-11): without it no buy can happen, so nothing else is worth looking up.
 */
export function hasCashToBuy(cash: number, cfg: Pick<RiskConfig, "minOrderUsd">): boolean {
  return cash > 0 && cash >= cfg.minOrderUsd;
}

/** The skip for a leader trade under "Ignore trader trades under"; null when it is big enough. */
export function leaderTooSmall(
  leaderUsd: number,
  cfg: Pick<RiskConfig, "minLeaderUsd">,
): Extract<SizingResult, { usd: 0 }> | null {
  if (leaderUsd >= cfg.minLeaderUsd) return null;
  return {
    usd: 0,
    reason: `Leader trade too small ($${leaderUsd.toFixed(2)})`,
    code: "leader_too_small",
    details: { leaderUsd, minLeaderUsd: cfg.minLeaderUsd },
  };
}

/** How many USDC to put into a copied buy, after every risk cap. */
export function sizeBuy(input: SizingInput, cfg: RiskConfig): SizingResult {
  const { equity, cash, leaderUsd, leaderTypicalUsd, weight } = input;
  if (equity <= 0 || cash <= 0) {
    return { usd: 0, reason: "No cash available", code: "no_cash", details: { cash, equity } };
  }
  const tooSmall = leaderTooSmall(leaderUsd, cfg);
  if (tooSmall) return tooSmall;

  let usd: number;
  let conviction: number | null = null;
  if (cfg.sizingMode === "fixed") {
    usd = cfg.fixedUsd * weight;
  } else {
    // How big this bet is for them: 2 = twice their usual stake in a market.
    conviction =
      leaderTypicalUsd && leaderTypicalUsd > 0
        ? Math.min(cfg.maxConviction, leaderUsd / leaderTypicalUsd)
        : 1;
    const stake = equity * cfg.stakePct * conviction * cfg.proportionalMultiplier;
    usd = Math.max(stake, cfg.minCopyUsd) * weight;
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
    conviction,
    leaderTypicalUsd,
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
