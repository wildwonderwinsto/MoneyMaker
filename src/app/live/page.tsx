import { cn } from "cn";
import { Activity, Lock, Radio } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { AutoRefresh } from "@/components/auto-refresh";
import { EmptyState, MarketThumb, PageHeader } from "@/components/common";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cents, polymarketMarketUrl, timeAgo, traderName, usd } from "@/lib/format";
import { getEngineStatus, getSignals } from "@/lib/queries";

export const metadata: Metadata = { title: "Live" };

export default function LivePage() {
  return (
    <>
      <PageHeader
        title="Live signals"
        description="Every trade made by the traders you follow, as soon as the engine sees it (checked every minute), and what the copy engine decided to do about it."
      />
      <Suspense fallback={<Skeleton className="h-[500px] rounded-xl" />}>
        <LiveContent />
      </Suspense>
    </>
  );
}

const DECISION_STYLE = {
  copied: "bg-yes/10 text-yes",
  closed: "bg-primary/10 text-primary",
  skipped: "bg-muted text-muted-foreground",
} as const;

async function LiveContent() {
  await connection();
  const [rows, status] = await Promise.all([getSignals(100), getEngineStatus()]);
  const { healthy } = status;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <AutoRefresh seconds={20} />
      <div className="space-y-3 lg:col-span-2">
        {rows.length === 0 ? (
          <EmptyState title="No signals yet" icon={Radio}>
            {status.following === 0 ? (
              <>
                Follow a few traders on the{" "}
                <Link href="/" className="underline">
                  Traders
                </Link>{" "}
                page. Their new trades will show up here.
              </>
            ) : (
              "Waiting for the traders you follow to place their next trade."
            )}
          </EmptyState>
        ) : (
          rows.map(({ signal: s, name }) => (
            <Card key={s.id} className="gap-0 py-3">
              <CardContent className="flex items-start gap-3 px-4">
                <MarketThumb src={s.image} size={44} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {s.slug ? (
                      <a
                        href={polymarketMarketUrl(s.slug)}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                      >
                        {s.title}
                      </a>
                    ) : (
                      s.title
                    )}
                  </p>
                  <p className="text-muted-foreground mt-0.5 text-sm">
                    <Link href={`/traders/${s.wallet}`} className="text-foreground hover:underline">
                      {traderName({ name, wallet: s.wallet })}
                    </Link>{" "}
                    <span
                      className={cn(
                        "mx-1 rounded px-1.5 py-0.5 text-xs font-semibold",
                        s.side === "BUY" ? "bg-yes/10 text-yes" : "bg-no/10 text-no",
                      )}
                    >
                      {s.side === "BUY" ? "Bought" : "Sold"} {s.outcome}
                    </span>
                    at {cents(s.leaderPrice)} · {usd(s.leaderUsdc, { compact: true })}
                  </p>
                  <p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-semibold capitalize",
                        DECISION_STYLE[s.decision],
                      )}
                    >
                      {s.decision}
                    </span>
                    <span className="text-muted-foreground">{s.reason}</span>
                  </p>
                </div>
                <span className="text-muted-foreground text-xs whitespace-nowrap">
                  {timeAgo(s.leaderTs)}
                </span>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="size-4" aria-hidden /> Copy engine
            </CardTitle>
            <CardDescription>Runs every minute via cron-job.org</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="flex items-center gap-2">
              <span
                className={cn("size-2 rounded-full", healthy ? "bg-yes" : "bg-no")}
                aria-hidden
              />
              {healthy ? "Running" : "Not running"} · last tick {timeAgo(status.lastTickAt)}
            </p>
            <p className="text-muted-foreground">
              Following {status.following} trader{status.following === 1 ? "" : "s"} ·{" "}
              <Link href="/paper" className="underline">
                see paper results
              </Link>
            </p>
          </CardContent>
        </Card>

        <Card className="border-dashed">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock className="size-4" aria-hidden /> Real-money trading
            </CardTitle>
            <CardDescription>Locked until paper results prove the strategy</CardDescription>
          </CardHeader>
          <CardContent className="text-muted-foreground space-y-2 text-sm">
            <p>
              Phase 2 will place real orders on US-legal venues: <strong>Kalshi</strong> (API + free
              demo account) or <strong>Polymarket US</strong>. Each Polymarket signal gets matched
              to the same market there.
            </p>
            <p>It will come with a kill switch, a daily loss limit, and per-venue caps.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
