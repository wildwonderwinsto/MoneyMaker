/**
 * Plain-English explanations of copy-engine decisions, shown when hovering or tapping a
 * reason on the Live page. Uses the exact numbers stored with each decision; older
 * signals without them fall back to parsing the short reason text. Pure.
 */
import type { ReasonCode } from "@/lib/db/schema";

type Details = Record<string, number | string | boolean | null> | null | undefined;

export interface Explanation {
  title: string;
  /** Short paragraphs, in order. */
  body: string[];
  /** What the admin can change in Settings to get a different result, if anything. */
  setting?: string;
}

const c = (x: number) => `${(x * 100).toFixed(1)}¢`;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${x.toFixed(2)}`;
const num = (d: Details, k: string): number | null =>
  d && typeof d[k] === "number" && Number.isFinite(d[k]) ? (d[k] as number) : null;

/** Guess the code of an old signal from its reason text. */
export function codeFromReason(reason: string): ReasonCode {
  const rules: Array<[RegExp, ReasonCode]> = [
    [/^Copied on re-check|^Bought/, "bought"],
    [/^Sold/, "sold"],
    [/^Price moved to/, "price_moved"],
    [/^Daily loss limit/, "daily_loss"],
    [/^Signal is .* old/, "stale"],
    [/^Leader paid .*above/, "price_too_high"],
    [/^Leader paid .*below/, "price_too_low"],
    [/^Leader trade too small/, "leader_too_small"],
    [/^Market ends in/, "ending_soon"],
    [/^Game already started/, "in_play"],
    [/^Combo bet/, "combo"],
    [/^Market is closed/, "market_closed"],
    [/^Market info unavailable/, "no_market"],
    [/^No sellers/, "no_sellers"],
    [/^No buyers/, "no_buyers"],
    [/^Not enough liquidity/, "no_liquidity"],
    [/below the exchange minimum/, "below_exchange_min"],
    [/^Per-market limit/, "market_cap"],
    [/^Per-trader limit/, "trader_cap"],
    [/^Not enough cash|^No cash/, "no_cash"],
    [/^Copy size .* below/, "below_min_order"],
    [/^No copied position/, "no_position"],
    [/^Copying sells is turned off/, "sells_off"],
    [/sell size is unknown/, "sell_size_unknown"],
    [/^Already copied \d+ buys? into this position/, "buy_limit"],
    [/below your sell floor/, "sell_floor"],
  ];
  return rules.find(([re]) => re.test(reason))?.[1] ?? "other";
}

/** Numbers from an old "Price moved to 73.0¢ (leader paid 47.3¢)" style reason. */
function legacyNumbers(reason: string): Details {
  const moved = reason.match(/Price moved to ([\d.]+)¢ \(leader paid ([\d.]+)¢\)/);
  if (moved) return { bestAsk: Number(moved[1]) / 100, leaderPrice: Number(moved[2]) / 100 };
  const loss = reason.match(/Daily loss limit hit \(([\d.]+)%\)/);
  if (loss) return { dailyLossPct: Number(loss[1]) / 100 };
  const paid = reason.match(/Leader paid ([\d.]+)¢ \((above|below) ([\d.]+)¢/);
  if (paid) {
    const key = paid[2] === "above" ? "maxEntryPrice" : "minEntryPrice";
    return { leaderPrice: Number(paid[1]) / 100, [key]: Number(paid[3]) / 100 };
  }
  const small = reason.match(/Leader trade too small \(\$([\d.]+)\)/);
  if (small) return { leaderUsd: Number(small[1]) };
  return null;
}

export function explain(opts: {
  reason: string;
  code?: ReasonCode | null;
  details?: Details;
  side?: string;
  outcome?: string | null;
  retries?: number;
}): Explanation {
  const code = opts.code ?? codeFromReason(opts.reason);
  const d: Details = opts.details ?? legacyNumbers(opts.reason);
  const side = opts.outcome ? `"${opts.outcome}"` : "this outcome";
  const retried =
    opts.retries && opts.retries > 0
      ? `The engine re-checked it ${opts.retries} time${opts.retries === 1 ? "" : "s"}.`
      : null;

  switch (code) {
    case "price_moved": {
      const ask = num(d, "bestAsk");
      const paid = num(d, "leaderPrice");
      const limit = num(d, "limitPrice");
      const drift = num(d, "maxPriceDrift");
      const leaderShares = num(d, "leaderShares");
      const topShares = num(d, "bestAskShares");
      const body: string[] = [];
      if (ask !== null && paid !== null) {
        body.push(
          `The trader paid ${c(paid)} per ${side} share. By the time the engine looked, the cheapest share anyone was selling cost ${c(ask)}: ${c(ask - paid)} more.`,
        );
      }
      if (limit !== null) {
        body.push(
          `Your limit is ${drift !== null ? `${c(drift)} above what the trader paid` : "close to what the trader paid"}, so the engine would pay at most ${c(limit)}. Paying more would hand away most of the edge you're copying, so it passed.`,
        );
      }
      if (leaderShares !== null && topShares !== null && leaderShares > topShares * 3) {
        body.push(
          `Their order was big (${Math.round(leaderShares).toLocaleString()} shares) and likely bought up all the cheap shares itself. In thin markets, sellers usually come back within minutes.`,
        );
      } else {
        body.push(
          "Polymarket's page shows the midpoint between buyers and sellers, which can look cheaper than what you'd actually pay to buy right now.",
        );
      }
      body.push(
        "With re-checks on, the engine keeps trying until the trade is too old, and copies it if the price comes back within your limit.",
      );
      if (retried) body.push(retried);
      return {
        title: "Skipped: the price ran away",
        body,
        setting: "Max price move vs. the trader · Re-check skipped trades",
      };
    }
    case "daily_loss": {
      const loss = num(d, "dailyLossPct");
      const max = num(d, "maxDailyLossPct");
      return {
        title: "Skipped: daily loss limit",
        body: [
          `The paper account is down ${loss !== null ? pct(loss) : "more than allowed"} since the start of today (UTC)${max !== null ? `, past your ${pct(max)} limit` : ""}.`,
          "While the limit is hit, no new positions are opened. Sells and settlements still happen. It resets at midnight UTC.",
        ],
        setting: "Daily loss limit",
      };
    }
    case "stale": {
      const age = num(d, "ageSeconds");
      const max = num(d, "maxAgeSeconds");
      return {
        title: "Skipped: too old",
        body: [
          `The engine saw this trade ${age !== null ? `${Math.round(age / 60)} minutes` : "a long time"} after it happened${max !== null ? ` (the limit is ${Math.round(max / 60)} minutes)` : ""}.`,
          "Copying long after the trader means a different price and less edge, usually after downtime.",
        ],
        setting: "Ignore trades older than",
      };
    }
    case "price_too_high":
    case "price_too_low": {
      const paid = num(d, "leaderPrice");
      const bound = num(d, code === "price_too_high" ? "maxEntryPrice" : "minEntryPrice");
      return {
        title: code === "price_too_high" ? "Skipped: price too high" : "Skipped: long shot",
        body: [
          code === "price_too_high"
            ? `The trader paid ${paid !== null ? c(paid) : "a high price"} per share. Above ${bound !== null ? c(bound) : "your maximum"} there's little left to win (at most ${paid !== null ? c(1 - paid) : "a few cents"} per share) for the risk of losing all of it.`
            : `The trader paid ${paid !== null ? c(paid) : "very little"} per share, below your ${bound !== null ? c(bound) : "minimum"}. Long shots like this rarely win and their order books are thin.`,
        ],
        setting: code === "price_too_high" ? "Highest price to buy at" : "Lowest price to buy at",
      };
    }
    case "leader_too_small": {
      const amt = num(d, "leaderUsd");
      const min = num(d, "minLeaderUsd");
      return {
        title: "Skipped: trade too small",
        body: [
          `The trader only put in ${amt !== null ? usd(amt) : "a small amount"}${min !== null ? ` (your minimum is ${usd(min)})` : ""}. Tiny trades are usually noise (testing, rounding, splitting orders), not conviction.`,
          "Pieces of one order placed seconds apart are added together before this check.",
        ],
        setting: "Ignore trader trades under",
      };
    }
    case "ending_soon":
      // Old signals only: the end date is no longer used (owner decision 2026-11-10).
      return {
        title: "Skipped: market about to end",
        body: [
          `This market's listed end was ${num(d, "minutesLeft") ?? "a few"} minutes away. (An older rule: Polymarket's end date turned out not to be when markets really close, so it's no longer used.)`,
        ],
        setting: "Skip games already in play",
      };
    case "in_play":
      return {
        title: "Skipped: game already started",
        body: [
          `This game started ${num(d, "minutesSinceStart") ?? "some"} minutes earlier. In-play prices move fast, and copies of in-play trades have returned less than pre-game ones.`,
          "Sells are still copied, so positions bought before kickoff close with the trader.",
        ],
        setting: "Skip games already in play",
      };
    case "combo":
      return {
        title: "Skipped: combo bet",
        body: [
          "The trader bought a combo (one bet on several markets at once). Combos have no order book to copy into, so they can't be copied.",
        ],
      };
    case "market_cap":
    case "trader_cap":
      return {
        title: code === "market_cap" ? "Skipped: market limit" : "Skipped: trader limit",
        body: [
          code === "market_cap"
            ? "You already have as much money in this market as your per-market limit allows. This keeps one bad market from sinking the account."
            : "You already have as much money with this trader as your per-trader limit allows. This keeps one trader's bad streak from sinking the account.",
        ],
        setting: code === "market_cap" ? "Most in one market" : "Most with one trader",
      };
    case "no_cash":
      return {
        title: "Skipped: no cash",
        body: [
          "The paper account has no cash left to buy with. Money comes back when positions are sold or markets settle.",
        ],
      };
    case "below_min_order":
      return {
        title: "Skipped: too small to place",
        body: ["After every limit, the copy would have been below your minimum order size."],
        setting: "Smallest order",
      };
    case "no_sellers":
    case "no_liquidity":
      return {
        title: "Skipped: no one selling near that price",
        body: [
          "There were no sellers within your price limit at the moment the engine checked.",
          "With re-checks on, it keeps trying until the trade is too old.",
          ...(retried ? [retried] : []),
        ],
        setting: "Max price move vs. the trader · Re-check skipped trades",
      };
    case "below_exchange_min":
      return {
        title: "Skipped: below exchange minimum",
        body: [
          "Polymarket requires a minimum number of shares per order, and this copy would have been smaller.",
        ],
      };
    case "no_position":
      return {
        title: "Nothing to sell",
        body: [
          "The trader sold shares the engine never copied (they were bought before you followed them, or that buy was skipped), so there was nothing to sell.",
        ],
      };
    case "sells_off":
      return {
        title: "Skipped: sells not copied",
        body: ["Copying sells is turned off, so positions are held until the market settles."],
        setting: "Copy the trader's sells",
      };
    case "buy_limit": {
      const max = num(d, "maxBuysPerPosition");
      return {
        title: "Skipped: buy limit for this position",
        body: [
          `The trader added to a position you already copied ${num(d, "positionBuys") ?? "several"} time${num(d, "positionBuys") === 1 ? "" : "s"}${max !== null ? `, and your limit is ${max}` : ""}. Quick repeated adds can pile a lot into one market before anyone can react, so the engine held off.`,
          "Their sells are still copied, so you exit with them.",
        ],
        setting: "Most buys into one position",
      };
    }
    case "leader_converted":
      return {
        title: "The trader converted shares in this market — check it",
        body: [
          "They used a conversion (multi-outcome markets) instead of a sale, so we can't tell how much of this side they gave up. It is not mirrored automatically.",
          "If they've left the market, close the position by hand from its page.",
        ],
      };
    case "sell_floor": {
      const bid = num(d, "bestBid");
      const paid = num(d, "leaderPrice");
      const floor = num(d, "limitPrice");
      const mid = num(d, "midpoint");
      if (mid !== null) {
        // A leader merge: no trader sell price, so the floor is measured from the midpoint.
        return {
          title: "Held: buyers too far below the market price",
          body: [
            `The trader merged Yes + No shares back into cash, so there's no sell price to follow; your floor is measured from the market midpoint (${c(mid)}). The best buyer was offering only ${bid !== null ? c(bid) : "much less"}${floor !== null ? `, under your floor of ${c(floor)}` : ""}.`,
            "The position stays open. It's sold with the trader's next exit if buyers come back, or settles when the market ends.",
          ],
          setting: "Lowest sell price vs. the trader",
        };
      }
      return {
        title: "Held: buyers too far below the trader's price",
        body: [
          `The trader sold at ${paid !== null ? c(paid) : "a price"}, but the best buyer left was offering only ${bid !== null ? c(bid) : "much less"}${floor !== null ? `, under your floor of ${c(floor)}` : ""}. Usually their own sell just used up the buyers.`,
          "The position stays open. It's sold with the trader's next sell if buyers come back, or settles when the market ends.",
        ],
        setting: "Lowest sell price vs. the trader",
      };
    }
    case "no_buyers":
      return {
        title: "Couldn't sell",
        body: [
          "Nobody was buying this outcome when the trader sold. The position stays open and settles when the market ends.",
        ],
      };
    case "market_closed":
    case "no_market":
      return {
        title: "Skipped: market unavailable",
        body: ["The market was closed, or its details couldn't be loaded from Polymarket."],
      };
    case "bought":
      return {
        title: "Copied",
        body: [
          `Filled against Polymarket's live order book at the prices sellers were actually asking, so slippage is included.${num(d, "fills") && num(d, "fills")! > 1 ? ` The trader's order filled in ${num(d, "fills")} pieces, combined into one copy.` : ""}`,
          ...(retried ? [retried] : []),
        ],
      };
    case "sold":
      return {
        title: "Sold with the trader",
        body: [
          `The trader sold ${num(d, "leaderSoldPct") !== null ? pct(num(d, "leaderSoldPct")!) : "part"} of their position, so the engine sold the same share of yours at the best prices buyers were offering.`,
        ],
      };
    default:
      return { title: "Decision", body: [opts.reason] };
  }
}

/**
 * What the trader page says when it has no positions to show. Candidates and rejected
 * traders keep no position history between checks (storage); it's downloaded again at
 * their next check. Null when there are positions.
 */
export function positionsNote(tier: string | null | undefined, positions: number): string | null {
  if (positions > 0) return null;
  if (tier === "candidate") {
    return "Candidate: history isn't stored between checks; it reloads at the next check (about weekly).";
  }
  return "Position history is only kept for followed, Verified, Elite and Watchlist traders.";
}
