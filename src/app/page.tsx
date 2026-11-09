import { SearchX } from "lucide-react";
import { connection } from "next/server";
import { Suspense } from "react";

import { EmptyState, PageHeader } from "@/components/common";
import { NavTab, PendingArea, PendingNavProvider } from "@/components/pending-nav";
import { isAdmin } from "@/lib/admin";
import { TraderCard } from "@/components/trader-card";
import { Skeleton } from "@/components/ui/skeleton";
import { timeAgo } from "@/lib/format";
import { getJobRuns, getTierCounts, getTraderList, type TierFilter } from "@/lib/queries";

const CATEGORIES = ["all", "politics", "sports", "crypto", "economics", "tech", "culture"];
const TIERS: Array<{ value: TierFilter; label: string; adminOnly?: boolean }> = [
  { value: "verified", label: "Verified" },
  { value: "candidate", label: "Candidates" },
  { value: "watchlist", label: "Watchlist" },
  { value: "followed", label: "Following" },
  { value: "all", label: "Everyone" },
  { value: "hidden", label: "Hidden", adminOnly: true },
];

export default function TradersPage({ searchParams }: PageProps<"/">) {
  return (
    <>
      <PageHeader
        title="Top traders"
        description="Polymarket traders ranked by consistency, not luck. Each one is tested against 16 checks: skill beyond what prices predicted, many separate wins (no one-hit wonders), steady months, and still profitable when copied a couple of minutes late."
      />
      <Suspense fallback={<GridSkeleton />}>
        <TraderGrid searchParams={searchParams} />
      </Suspense>
    </>
  );
}

function href(params: { tier: string; category: string }) {
  const sp = new URLSearchParams();
  if (params.tier !== "verified") sp.set("tier", params.tier);
  if (params.category !== "all") sp.set("category", params.category);
  const q = sp.toString();
  return q ? `/?${q}` : "/";
}

async function TraderGrid({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  await connection();
  const sp = await searchParams;
  const admin = await isAdmin();
  const tiers = TIERS.filter((t) => admin || !t.adminOnly);
  const tier = (tiers.find((t) => t.value === sp.tier)?.value ?? "verified") as TierFilter;
  const category = CATEGORIES.includes(String(sp.category)) ? String(sp.category) : "all";

  const [list, { tiers: counts, hidden }, runs] = await Promise.all([
    getTraderList({ tier, category: category === "all" ? undefined : category }),
    getTierCounts(),
    getJobRuns(20),
  ]);
  const lastScore = runs.find((r) => (r.job === "daily" || r.job === "score") && r.status === "ok");
  const verifiedCount = (counts.elite ?? 0) + (counts.verified ?? 0);

  return (
    <PendingNavProvider>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            className="-mx-3 flex w-[calc(100%+1.5rem)] gap-1 overflow-x-auto px-3 pb-1 sm:mx-0 sm:w-auto sm:px-0 sm:pb-0"
            role="tablist"
            aria-label="Category"
          >
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
          <div
            className="bg-muted flex w-full gap-1 overflow-x-auto rounded-lg p-1 sm:w-auto"
            role="tablist"
            aria-label="Tier"
          >
            {tiers.map((t) => (
              <NavTab
                key={t.value}
                group="tier"
                href={href({ tier: t.value, category })}
                selected={t.value === tier}
                className="shrink-0 rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap transition-colors"
                activeClassName="bg-card text-foreground shadow-sm"
                inactiveClassName="text-muted-foreground hover:text-foreground"
              >
                {t.label}
                {t.value === "verified" && ` (${verifiedCount})`}
                {t.value === "candidate" && ` (${counts.candidate ?? 0})`}
                {t.value === "watchlist" && ` (${counts.watchlist ?? 0})`}
                {t.value === "hidden" && ` (${hidden})`}
              </NavTab>
            ))}
          </div>
        </div>

        <p className="text-muted-foreground text-xs">
          {lastScore
            ? `Scores updated ${timeAgo(lastScore.finishedAt ?? lastScore.startedAt)} · `
            : "Not scored yet · "}
          {Object.values(counts).reduce((a, b) => a + (b ?? 0), 0)} traders analysed
        </p>

        <PendingArea>
          {list.length === 0 ? (
            <EmptyState title="No traders here yet" icon={SearchX}>
              {tier === "verified"
                ? "Nobody has passed every check yet. That's the filter doing its job. Look at the Watchlist, or wait for the next daily scoring run."
                : tier === "hidden"
                  ? "No hidden traders. Press “No” on a trader to hide them from this list."
                  : "Run the daily job (npm run job -- daily) to discover and score traders."}
            </EmptyState>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {list.map((t) => (
                <TraderCard key={t.wallet} t={t} admin={admin} />
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
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-64 rounded-xl" />
      ))}
    </div>
  );
}
