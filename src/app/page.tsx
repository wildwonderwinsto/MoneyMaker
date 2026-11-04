import { cn } from "cn";
import { SearchX } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { EmptyState, PageHeader } from "@/components/common";
import { TraderCard } from "@/components/trader-card";
import { Skeleton } from "@/components/ui/skeleton";
import { timeAgo } from "@/lib/format";
import { getJobRuns, getTierCounts, getTraderList, type TierFilter } from "@/lib/queries";

const CATEGORIES = ["all", "politics", "sports", "crypto", "economics", "tech", "culture"];
const TIERS: Array<{ value: TierFilter; label: string }> = [
  { value: "verified", label: "Verified" },
  { value: "watchlist", label: "Watchlist" },
  { value: "followed", label: "Following" },
  { value: "all", label: "Everyone" },
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
  const tier = (TIERS.find((t) => t.value === sp.tier)?.value ?? "verified") as TierFilter;
  const category = CATEGORIES.includes(String(sp.category)) ? String(sp.category) : "all";

  const [list, counts, runs] = await Promise.all([
    getTraderList({ tier, category: category === "all" ? undefined : category }),
    getTierCounts(),
    getJobRuns(20),
  ]);
  const lastScore = runs.find((r) => (r.job === "daily" || r.job === "score") && r.status === "ok");
  const verifiedCount = (counts.elite ?? 0) + (counts.verified ?? 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 overflow-x-auto" role="tablist" aria-label="Category">
          {CATEGORIES.map((c) => (
            <Link
              key={c}
              href={href({ tier, category: c })}
              role="tab"
              aria-selected={c === category}
              className={cn(
                "rounded-full px-3 py-1.5 text-sm font-medium capitalize transition-colors",
                c === category
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {c}
            </Link>
          ))}
        </div>
        <div className="bg-muted flex gap-1 rounded-lg p-1" role="tablist" aria-label="Tier">
          {TIERS.map((t) => (
            <Link
              key={t.value}
              href={href({ tier: t.value, category })}
              role="tab"
              aria-selected={t.value === tier}
              className={cn(
                "rounded-md px-3 py-1 text-sm font-medium transition-colors",
                t.value === tier
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
              {t.value === "verified" && ` (${verifiedCount})`}
              {t.value === "watchlist" && ` (${counts.watchlist ?? 0})`}
            </Link>
          ))}
        </div>
      </div>

      <p className="text-muted-foreground text-xs">
        {lastScore
          ? `Scores updated ${timeAgo(lastScore.finishedAt ?? lastScore.startedAt)} · `
          : "Not scored yet · "}
        {Object.values(counts).reduce((a, b) => a + (b ?? 0), 0)} traders analysed
      </p>

      {list.length === 0 ? (
        <EmptyState title="No traders here yet" icon={SearchX}>
          {tier === "verified"
            ? "Nobody has passed every check yet. That's the filter doing its job. Look at the Watchlist, or wait for the next daily scoring run."
            : "Run the daily job (npm run job -- daily) to discover and score traders."}
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((t) => (
            <TraderCard key={t.wallet} t={t} />
          ))}
        </div>
      )}
    </div>
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
