import { SearchX } from "lucide-react";
import { connection } from "next/server";
import { Suspense } from "react";

import { EmptyState, PageHeader } from "@/components/common";
import { NavTab, PendingArea, PendingNavProvider } from "@/components/pending-nav";
import { isAdmin } from "@/lib/admin";
import { TierTabs } from "@/components/tier-tabs";
import { TraderCard } from "@/components/trader-card";
import { Skeleton } from "@/components/ui/skeleton";
import { timeAgo } from "@/lib/format";
import { getDb } from "@/lib/db/client";
import { getJobRuns, getTierCounts, getTraderList } from "@/lib/queries";
import { getScoringConfig } from "@/lib/settings";
import { TIER_TABS, type TierFilter } from "@/lib/tiers";

const CATEGORIES = ["all", "politics", "sports", "crypto", "economics", "tech", "culture"];
/** With no tier in the URL: the best of these that has anyone in it. */
const DEFAULT_TIERS: TierFilter[] = ["proven", "elite", "verified"];

export default function TradersPage({ searchParams }: PageProps<"/">) {
  return (
    <>
      <PageHeader
        title="Top traders"
        description="Polymarket traders ranked by consistency, not luck. Each one is tested against 19 checks: skill beyond what prices predicted (on bets placed after they were picked), many separate wins (no one-hit wonders), steady months, and still profitable when copied a couple of minutes late. Proven traders went on to make money for their copiers after they were verified."
      />
      <Suspense fallback={<GridSkeleton />}>
        <TraderGrid searchParams={searchParams} />
      </Suspense>
    </>
  );
}

/** The tier is always in the URL, so a chosen tab survives a category change. */
function href(params: { tier: string; category: string }) {
  const sp = new URLSearchParams({ tier: params.tier });
  if (params.category !== "all") sp.set("category", params.category);
  return `/?${sp}`;
}

async function TraderGrid({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  await connection();
  const sp = await searchParams;
  const admin = await isAdmin();
  const tiers = TIER_TABS.filter((t) => admin || !t.adminOnly);
  const category = CATEGORIES.includes(String(sp.category)) ? String(sp.category) : "all";
  const inCategory = category === "all" ? undefined : category;

  const [counts, runs, scoring] = await Promise.all([
    getTierCounts(inCategory),
    getJobRuns(20),
    getScoringConfig(getDb()),
  ]);
  const countOf = (t: TierFilter) =>
    t === "all"
      ? counts.all
      : t === "followed"
        ? counts.followed
        : t === "hidden"
          ? counts.hidden
          : (counts.tiers[t] ?? 0);
  const tier =
    tiers.find((t) => t.value === sp.tier)?.value ??
    DEFAULT_TIERS.find((t) => countOf(t) > 0) ??
    "verified";
  const list = await getTraderList({ tier, category: inCategory });
  const lastScore = runs.find((r) => (r.job === "daily" || r.job === "score") && r.status === "ok");

  return (
    <PendingNavProvider>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Category">
            {CATEGORIES.map((c) => (
              <NavTab
                key={c}
                group="category"
                href={href({ tier, category: c })}
                selected={c === category}
                className="shrink-0 rounded-full px-3 py-1.5 text-sm font-medium capitalize transition-colors"
                activeClassName="bg-foreground text-background"
                inactiveClassName="text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {c}
              </NavTab>
            ))}
          </div>
          <TierTabs
            selected={tier}
            tabs={tiers.map((t) => ({
              value: t.value,
              label: t.label,
              group: t.group,
              help: t.help(scoring),
              count: countOf(t.value),
              href: href({ tier: t.value, category }),
            }))}
          />
        </div>

        <p className="text-muted-foreground text-xs">
          {lastScore
            ? `Scores updated ${timeAgo(lastScore.finishedAt ?? lastScore.startedAt)} · `
            : "Not scored yet · "}
          {counts.all} {inCategory ? `${inCategory} ` : ""}traders analysed
        </p>

        <PendingArea>
          {list.length === 0 ? (
            <EmptyState title="No traders here yet" icon={SearchX}>
              {/* Nothing scored at all (a new install, or right after Start over): the tab's
                  own text ("look at the Candidates") would point at more empty tabs. */}
              {counts.all === 0 && !inCategory
                ? "No traders have been scored yet. The daily scoring run finds and checks them; they appear here after it finishes."
                : (tiers.find((t) => t.value === tier) ?? TIER_TABS[0]).empty(scoring)}
            </EmptyState>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {list.map((t) => (
                <TraderCard
                  key={t.wallet}
                  t={t}
                  admin={admin}
                  copyDelaySeconds={scoring.copyDelaySeconds}
                />
              ))}
            </div>
          )}
        </PendingArea>
      </div>
    </PendingNavProvider>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-64 rounded-xl" />
      ))}
    </div>
  );
}
