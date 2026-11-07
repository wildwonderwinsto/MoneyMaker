/**
 * Settings shown in plain language and natural units. Values are STORED as the engine
 * uses them (fractions, 0–1 prices, seconds, basis points) and SHOWN as %, ¢, minutes…
 * `toDisplay` / `fromDisplay` convert between the two.
 */
export type Unit =
  | "number"
  | "usd"
  | "pct"
  | "cents"
  /** Stored in seconds, shown in minutes. */
  | "minutes"
  /** Stored and shown in minutes. */
  | "min"
  | "seconds"
  | "bps"
  | "hours"
  | "times";
type Values = Record<string, unknown>;

export interface Ctx {
  equity: number;
}

export type Field =
  | {
      kind: "number";
      name: string;
      label: string;
      help: string;
      unit: Unit;
      step?: number;
      min?: number;
      max?: number;
      showIf?: (v: Values) => boolean;
      example?: (v: Values, ctx: Ctx) => string | null;
    }
  | {
      kind: "boolean";
      name: string;
      label: string;
      help: string;
      showIf?: (v: Values) => boolean;
    }
  | {
      kind: "choice";
      name: string;
      label: string;
      help: string;
      options: Array<{ value: string | number; label: string; help?: string }>;
      showIf?: (v: Values) => boolean;
      example?: (v: Values, ctx: Ctx) => string | null;
    };

export interface Group {
  id: string;
  title: string;
  description: string;
  fields: Field[];
}

export const UNIT_SUFFIX: Record<Unit, string> = {
  number: "",
  usd: "$",
  pct: "%",
  cents: "¢",
  minutes: "min",
  min: "min",
  seconds: "sec",
  bps: "%",
  hours: "h",
  times: "×",
};

const round = (x: number, d = 6) => Math.round(x * 10 ** d) / 10 ** d;

export function toDisplay(unit: Unit, stored: number): number {
  switch (unit) {
    case "pct":
    case "cents":
      return round(stored * 100, 4);
    case "minutes":
      return round(stored / 60, 2);
    case "bps":
      return round(stored / 100, 4);
    default:
      return stored;
  }
}

export function fromDisplay(unit: Unit, shown: number): number {
  switch (unit) {
    case "pct":
    case "cents":
      return round(shown / 100, 8);
    case "minutes":
      return Math.round(shown * 60);
    case "bps":
      return round(shown * 100, 4);
    default:
      return shown;
  }
}

const n = (v: Values, k: string) => Number(v[k]);
const money = (x: number) => `$${x.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const c = (x: number) => `${round(x * 100, 1)}¢`;
const p = (x: number) => `${round(x * 100, 1)}%`;

export const RISK_GROUPS: Group[] = [
  {
    id: "speed",
    title: "Speed",
    description:
      "Copying fast matters most: the later you copy, the worse your price. The real-time feed copies within seconds; regular checks are the safety net.",
    fields: [
      {
        kind: "boolean",
        name: "realtime",
        label: "Real-time copying",
        help: "Listen to Polymarket's live trade feed and copy followed traders seconds after they trade. Turn off only to rely on the regular checks below.",
      },
      {
        kind: "choice",
        name: "tickIntervalSeconds",
        label: "Check every",
        help: "How often every trader is also checked directly. It catches anything the live feed missed, re-checks skipped trades, settles finished markets and updates prices.",
        options: [
          { value: 15, label: "15 sec" },
          { value: 30, label: "30 sec" },
          { value: 60, label: "1 min" },
        ],
      },
      {
        kind: "boolean",
        name: "retrySkipped",
        label: "Re-check skipped trades",
        help: "If a trade was skipped because the price ran away or nobody was selling, keep checking it (until it's too old) and copy it if the price comes back within your limit.",
      },
    ],
  },
  {
    id: "sizing",
    title: "How much to bet",
    description: "How big each copied trade is. Every limit under Safety still applies on top.",
    fields: [
      {
        kind: "choice",
        name: "sizingMode",
        label: "Sizing",
        help: "",
        options: [
          {
            value: "proportional",
            label: "Match their conviction",
            help: "Bet more when they bet more than usual: a bet twice their usual size gets twice your usual stake.",
          },
          {
            value: "fixed",
            label: "Fixed amount",
            help: "Every copy uses the same dollar amount.",
          },
        ],
        example: (v, ctx) =>
          v.sizingMode === "fixed"
            ? `Every copy: ${money(n(v, "fixedUsd"))} (× the trader's weight).`
            : `Example: a trader bets twice their usual amount → you put ${p(Math.min(2, n(v, "maxConviction")) * n(v, "stakePct") * n(v, "proportionalMultiplier"))} of your ${money(ctx.equity)} = ${money(Math.max(ctx.equity * Math.min(2, n(v, "maxConviction")) * n(v, "stakePct") * n(v, "proportionalMultiplier"), n(v, "minCopyUsd")))}.`,
      },
      {
        kind: "number",
        name: "fixedUsd",
        label: "Amount per copy",
        help: "Dollars put into every copied buy (multiplied by that trader's weight).",
        unit: "usd",
        min: 1,
        step: 1,
        showIf: (v) => v.sizingMode === "fixed",
      },
      {
        kind: "number",
        name: "stakePct",
        label: "Usual bet",
        help: "What you put in when a trader makes a bet of their usual size (their median per market over the last 90 days).",
        unit: "pct",
        min: 0,
        max: 100,
        step: 0.5,
        showIf: (v) => v.sizingMode !== "fixed",
      },
      {
        kind: "number",
        name: "maxConviction",
        label: "Biggest bet",
        help: "A bet much bigger than their usual counts as at most this many usual bets, so one huge bet can't take over your account.",
        unit: "times",
        min: 1,
        max: 20,
        step: 0.5,
        showIf: (v) => v.sizingMode !== "fixed",
      },
      {
        kind: "number",
        name: "proportionalMultiplier",
        label: "Multiplier",
        help: "Scales every copy: 0.5× bets half as much, 2× twice as much.",
        unit: "times",
        min: 0,
        max: 10,
        step: 0.1,
        showIf: (v) => v.sizingMode !== "fixed",
      },
      {
        kind: "number",
        name: "minCopyUsd",
        label: "Smallest copy",
        help: "Copies of bets that are small for the trader still get at least this much.",
        unit: "usd",
        min: 0,
        step: 1,
        showIf: (v) => v.sizingMode !== "fixed",
      },
    ],
  },
  {
    id: "limits",
    title: "Safety limits",
    description: "Caps that protect the account from any one market, trader or bad day.",
    fields: [
      {
        kind: "number",
        name: "maxPositionPct",
        label: "Most in one market",
        help: "Never have more than this share of your money in a single market.",
        unit: "pct",
        min: 0,
        max: 100,
        step: 1,
        example: (v, ctx) =>
          `With ${money(ctx.equity)}: at most ${money(ctx.equity * n(v, "maxPositionPct"))} per market.`,
      },
      {
        kind: "number",
        name: "maxTraderExposurePct",
        label: "Most with one trader",
        help: "Never have more than this share of your money copied from one trader.",
        unit: "pct",
        min: 0,
        max: 100,
        step: 1,
        example: (v, ctx) =>
          `With ${money(ctx.equity)}: at most ${money(ctx.equity * n(v, "maxTraderExposurePct"))} per trader.`,
      },
      {
        kind: "number",
        name: "maxDailyLossPct",
        label: "Daily loss limit",
        help: "Stop opening new positions after losing this much today (UTC). Sells and settlements continue; it resets at midnight UTC.",
        unit: "pct",
        min: 0,
        max: 100,
        step: 1,
      },
      {
        kind: "number",
        name: "minOrderUsd",
        label: "Smallest order",
        help: "Skip a copy if, after every limit, it would be smaller than this.",
        unit: "usd",
        min: 0,
        step: 0.5,
      },
      {
        kind: "number",
        name: "maxBuysPerPosition",
        label: "Most buys into one position",
        help: "Copy at most this many of a trader's buys into the same position; later adds are skipped. Stops a burst of quick adds from stacking up one market. 0 = no limit.",
        unit: "number",
        min: 0,
        max: 50,
        step: 1,
        example: (v) =>
          n(v, "maxBuysPerPosition") > 0
            ? `A trader buying the same outcome 4 times gets copied ${Math.min(4, n(v, "maxBuysPerPosition"))} time${Math.min(4, n(v, "maxBuysPerPosition")) === 1 ? "" : "s"}.`
            : "Off: every qualifying add is copied (other limits still apply).",
      },
    ],
  },
  {
    id: "filters",
    title: "Which trades to copy",
    description: "Filters that skip trades unlikely to be worth copying.",
    fields: [
      {
        kind: "number",
        name: "maxPriceDrift",
        label: "Max price move vs. the trader",
        help: "The most extra you'll pay per share compared with what the trader paid. Higher copies more trades but gives away more of the edge.",
        unit: "cents",
        min: 0,
        max: 50,
        step: 0.5,
        example: (v) =>
          `If the trader paid 50¢, you'll pay at most ${c(0.5 + n(v, "maxPriceDrift"))}.`,
      },
      {
        kind: "number",
        name: "maxEntryPrice",
        label: "Highest price to buy at",
        help: "Skip buys above this price: little left to win for the risk of losing it all.",
        unit: "cents",
        min: 0,
        max: 100,
        step: 1,
        example: (v) =>
          `At ${c(n(v, "maxEntryPrice"))} you risk ${c(n(v, "maxEntryPrice"))} to win ${c(1 - n(v, "maxEntryPrice"))} per share.`,
      },
      {
        kind: "number",
        name: "minEntryPrice",
        label: "Lowest price to buy at",
        help: "Skip long shots below this price. They rarely win and their order books are thin.",
        unit: "cents",
        min: 0,
        max: 100,
        step: 0.5,
      },
      {
        kind: "number",
        name: "minLeaderUsd",
        label: "Ignore trader trades under",
        help: "Tiny trades are usually noise. Pieces of one order placed seconds apart are added up first.",
        unit: "usd",
        min: 0,
        step: 1,
      },
      {
        kind: "number",
        name: "minMinutesToEnd",
        label: "Skip markets ending within",
        help: "Prices jump around right before a market ends, with no time to react.",
        unit: "min",
        min: 0,
        step: 1,
      },
      {
        kind: "number",
        name: "maxSignalAgeSeconds",
        label: "Ignore trades older than",
        help: "Don't copy (or keep re-checking) trades older than this, e.g. after downtime.",
        unit: "minutes",
        min: 0.5,
        step: 0.5,
      },
      {
        kind: "boolean",
        name: "copySells",
        label: "Copy the trader's sells",
        help: "When the trader sells part of a position, sell the same share of yours. Off = hold until the market settles.",
      },
      {
        kind: "number",
        name: "sellFloorPct",
        label: "Lowest sell price vs. the trader",
        help: "When copying a sell, don't sell for more than this much below the trader's price. A big sell often wipes out the buyers, leaving only much lower bids. Shares that can't sell above the floor stay open. 0 = always sell at whatever buyers offer.",
        unit: "pct",
        min: 0,
        max: 100,
        step: 5,
        showIf: (v) => v.copySells !== false,
        example: (v) =>
          n(v, "sellFloorPct") > 0
            ? `If the trader sells at 40¢, you sell only to buyers paying at least ${c(0.4 * (1 - n(v, "sellFloorPct")))}.`
            : "Off: sells always go through at the best bids available.",
      },
    ],
  },
  {
    id: "hedging",
    title: "Hedging (cancel out losses)",
    description:
      "In a Yes/No market exactly one side pays $1. Buying the other side of a losing copy can lock in the result or make a flip cost nothing. You can also hedge by hand from any open position.",
    fields: [
      {
        kind: "choice",
        name: "autoHedge",
        label: "Automatic hedging",
        help: "",
        options: [
          { value: "off", label: "Off", help: "Never hedge automatically." },
          {
            value: "lock",
            label: "Lock in",
            help: "Buy as many of the other side as you hold. The loss stops growing (it also can't recover).",
          },
          {
            value: "breakeven",
            label: "Break even",
            help: "Buy enough of the other side that you lose nothing if the market flips. Costs more.",
          },
        ],
      },
      {
        kind: "number",
        name: "hedgeTriggerLossPct",
        label: "Hedge when a copy is down",
        help: "Hedge a copied position once it has lost this share of what it cost.",
        unit: "pct",
        min: 5,
        max: 100,
        step: 5,
        showIf: (v) => v.autoHedge !== "off",
      },
      {
        kind: "number",
        name: "hedgeMaxCostPct",
        label: "Most to spend on one hedge",
        help: "Skip the hedge if it would cost more than this share of your money.",
        unit: "pct",
        min: 0,
        max: 100,
        step: 1,
        showIf: (v) => v.autoHedge !== "off",
        example: (v, ctx) =>
          `With ${money(ctx.equity)}: at most ${money(ctx.equity * n(v, "hedgeMaxCostPct"))} per hedge.`,
      },
      {
        kind: "number",
        name: "hedgeMaxPrice",
        label: "Highest price for the other side",
        help: "Don't hedge when the other side costs more than this: the hedge would cost nearly as much as it protects.",
        unit: "cents",
        min: 5,
        max: 99,
        step: 1,
        showIf: (v) => v.autoHedge !== "off",
      },
    ],
  },
  {
    id: "simulation",
    title: "Simulation",
    description: "Makes paper results more realistic.",
    fields: [
      {
        kind: "number",
        name: "takerFeeBps",
        label: "Extra trading fee",
        help: "Added on top of Polymarket's own taker fee, which every simulated fill already pays (rate × price × (1 − price) per share; the rate depends on the market's category). Leave at 0 unless you want a safety margin.",
        unit: "bps",
        min: 0,
        max: 10,
        step: 0.05,
      },
    ],
  },
];

export const SCORING_GROUPS: Group[] = [
  {
    id: "sample",
    title: "Enough history",
    description: "Too few bets can't tell skill from luck.",
    fields: [
      {
        kind: "number",
        name: "minResolved",
        label: "Finished markets",
        help: "Minimum markets that have resolved.",
        unit: "number",
        min: 1,
        step: 1,
      },
      {
        kind: "number",
        name: "minEvents",
        label: "Different events",
        help: "Minimum separate events, so 40 bets on one election don't count as 40 samples.",
        unit: "number",
        min: 1,
        step: 1,
      },
      {
        kind: "number",
        name: "minMonths",
        label: "Active months",
        help: "Minimum months with trading.",
        unit: "number",
        min: 1,
        step: 1,
      },
    ],
  },
  {
    id: "skill",
    title: "Skill, not luck",
    description: "Statistical tests that compare their wins with what the prices predicted.",
    fields: [
      {
        kind: "number",
        name: "minZ",
        label: "Skill score (z)",
        help: "How many standard deviations their win rate beats what prices implied. 2 ≈ only a 2.5% chance of luck.",
        unit: "number",
        step: 0.1,
      },
      {
        kind: "number",
        name: "fdrQ",
        label: "False-discovery rate",
        help: "When testing hundreds of traders, some look skilled by chance. This caps that share among those who pass.",
        unit: "pct",
        min: 0,
        max: 100,
        step: 1,
      },
      {
        kind: "number",
        name: "simulations",
        label: "Luck simulations",
        help: "Random re-draws of every outcome used to measure luck. More is more precise but slower.",
        unit: "number",
        min: 100,
        max: 20000,
        step: 100,
      },
      {
        kind: "number",
        name: "minRoiShrunk",
        label: "Return (sample-adjusted)",
        help: "Minimum return on money risked, shrunk toward zero for small samples.",
        unit: "pct",
        step: 1,
      },
    ],
  },
  {
    id: "consistency",
    title: "Consistent, not one big win",
    description: "Profits should come from many bets and many months.",
    fields: [
      {
        kind: "number",
        name: "maxTopMarketShare",
        label: "Biggest win's share",
        help: "One market can be at most this share of all profits.",
        unit: "pct",
        min: 0,
        max: 100,
        step: 1,
      },
      {
        kind: "number",
        name: "maxTop3Share",
        label: "Top-3 wins' share",
        help: "The three biggest markets can be at most this share of all profits.",
        unit: "pct",
        min: 0,
        max: 100,
        step: 1,
      },
      {
        kind: "number",
        name: "minProfitableMonthsPct",
        label: "Profitable months",
        help: "Share of active months that ended in profit.",
        unit: "pct",
        min: 0,
        max: 100,
        step: 5,
      },
      {
        kind: "number",
        name: "minRecoveryFactor",
        label: "Profit vs. worst drawdown",
        help: "Net profit must be at least this many times their worst peak-to-low drop.",
        unit: "times",
        step: 0.1,
      },
    ],
  },
  {
    id: "copyable",
    title: "Copyable",
    description:
      "Their edge has to survive you copying them a bit later, at a slightly worse price, after paying Polymarket's taker fee.",
    fields: [
      {
        kind: "number",
        name: "copyDelaySeconds",
        label: "Copy delay to test",
        help: "Their trades are replayed as if you bought this much later.",
        unit: "seconds",
        min: 0,
        step: 10,
      },
      {
        kind: "number",
        name: "copySlippage",
        label: "Extra price paid",
        help: "Added to the delayed price to account for crossing the spread.",
        unit: "cents",
        min: 0,
        max: 10,
        step: 0.5,
      },
      {
        kind: "number",
        name: "minCopyAdjRoi",
        label: "Min return when copied late",
        help: "The replayed copies must return at least this much.",
        unit: "pct",
        step: 1,
      },
      {
        kind: "number",
        name: "copyRoiZ",
        label: "Caution on copy returns",
        help: "A few big bets can make the average copy return look great by luck. The check uses the average minus this many standard errors: 1.28 means about 90% confident, 0 uses the plain average.",
        unit: "number",
        min: 0,
        max: 3,
        step: 0.01,
      },
      {
        kind: "number",
        name: "minCopyReplays",
        label: "Trades to replay (minimum)",
        help: "Fewer replayable trades than this isn't enough evidence, and the check can't pass.",
        unit: "number",
        min: 1,
        step: 1,
      },
      {
        kind: "number",
        name: "minReplayLeaderUsd",
        label: "Replay trades of at least",
        help: "Only replay trades the copy engine would actually copy.",
        unit: "usd",
        min: 0,
        step: 1,
      },
      {
        kind: "number",
        name: "maxTradesPerDay",
        label: "Max trades per day",
        help: "More than this looks like a bot you can't keep up with.",
        unit: "number",
        step: 10,
      },
      {
        kind: "number",
        name: "maxBothSidesRatio",
        label: "Buys both sides in",
        help: "Market makers buy Yes and No in the same market; they aren't betting on outcomes.",
        unit: "pct",
        min: 0,
        max: 100,
        step: 1,
      },
      {
        kind: "number",
        name: "minMedianHoldHours",
        label: "Typical holding time",
        help: "Traders who flip positions within minutes are too fast to copy.",
        unit: "hours",
        min: 0,
        step: 0.5,
      },
    ],
  },
  {
    id: "recent",
    title: "Still good today",
    description: "Past skill has to still show up recently.",
    fields: [
      {
        kind: "number",
        name: "oosDays",
        label: "Recent window",
        help: "Days counted as “recent”.",
        unit: "number",
        min: 7,
        step: 1,
      },
      {
        kind: "number",
        name: "minOosRoi",
        label: "Recent return",
        help: "Minimum return within the recent window.",
        unit: "pct",
        step: 1,
      },
      {
        kind: "number",
        name: "maxDaysSinceTrade",
        label: "Traded within (days)",
        help: "Must have traded at least this recently.",
        unit: "number",
        min: 1,
        step: 1,
      },
      {
        kind: "number",
        name: "eliteScore",
        label: "Elite score",
        help: "Verified traders with at least this score (0–100) are marked Elite.",
        unit: "number",
        min: 0,
        max: 100,
        step: 1,
      },
    ],
  },
];

/**
 * A follow's sizing weight as typed in its box: null (no change) when blank, not a number
 * or outside 0–5. A blank box used to become `Number("")` = 0×, silently pausing copies.
 */
export function parseWeight(raw: string): number | null {
  if (raw.trim() === "") return null;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 && v <= 5 ? v : null;
}
