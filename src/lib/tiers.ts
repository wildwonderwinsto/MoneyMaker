/**
 * The Traders page's tabs: tiers best first, then a gap, then lists. Pure (no I/O) so the
 * order and the tooltip text are tested, and the tooltips quote the live settings.
 */
import type { ScoreTier } from "@/lib/db/schema";
import type { ScoringConfig } from "@/lib/scoring/config";

export type TierFilter = ScoreTier | "all" | "followed" | "hidden";

export interface TierTab {
  value: TierFilter;
  label: string;
  /** "tiers" = one tier each; "lists" (after the gap) = other ways to slice the traders. */
  group: "tiers" | "lists";
  adminOnly?: boolean;
  /** Short tooltip: what being here means. */
  help: (cfg: ScoringConfig) => string;
  /** Shown when the tab is empty. */
  empty: (cfg: ScoringConfig) => string;
}

export const TIER_TABS: TierTab[] = [
  {
    value: "proven",
    label: "Proven",
    group: "tiers",
    help: (c) =>
      `Verified or Elite, and copying them has paid off since they were verified: at least ${c.provenMinDays} days and ${c.provenMinCopies} copied bets (late, with fees), with a cautious return above 0.`,
    empty: (c) =>
      `Nobody is Proven yet. A Verified or Elite trader gets here once their bets since being verified, copied late with fees, cover ${c.provenMinDays} days and ${c.provenMinCopies} copied bets with a cautious return above 0.`,
  },
  {
    value: "elite",
    label: "Elite",
    group: "tiers",
    help: (c) => `Passes every check with a score of ${c.eliteScore} or more out of 100.`,
    empty: (c) =>
      `No Elite traders right now. Elite means passing every check with a score of ${c.eliteScore} or more.`,
  },
  {
    value: "verified",
    label: "Verified",
    group: "tiers",
    help: () => "Passes every check, including real skill on bets placed after they were picked.",
    empty: () =>
      "Nobody here has passed every check yet. That's the filter doing its job. Look at the Candidates and the Watchlist, or wait for the next daily scoring run.",
  },
  {
    value: "candidate",
    label: "Candidates",
    group: "tiers",
    help: (c) =>
      `Passes everything else; skill is still being tested on bets placed since they were picked (up to ${c.maxCandidateDays} days).`,
    empty: () => "No Candidates right now. New picks show up here after the daily scoring run.",
  },
  {
    value: "watchlist",
    label: "Watchlist",
    group: "tiers",
    help: () =>
      "Near misses: up to 3 failed checks (only 1 while skill is still being tested). Re-checked regularly.",
    empty: () => "No near misses on the Watchlist right now.",
  },
  {
    value: "followed",
    label: "Following",
    group: "lists",
    help: () => "Traders being copied with paper money.",
    empty: () =>
      "Not following anyone yet. Press Follow on a trader to copy them with paper money.",
  },
  {
    value: "all",
    label: "Everyone",
    group: "lists",
    help: () => "Every scored trader, Rejected included.",
    empty: () => "Run the daily job (npm run job -- daily) to discover and score traders.",
  },
  {
    value: "hidden",
    label: "Hidden",
    group: "lists",
    adminOnly: true,
    help: () => "Traders you said no to. They're kept out of every other tab.",
    empty: () => "No hidden traders. Press “No” on a trader to hide them from this list.",
  },
];
