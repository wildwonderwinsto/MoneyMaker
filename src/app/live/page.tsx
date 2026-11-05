import { cn } from "cn";
import { Activity, ChevronDown, Lock, Radio, Zap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { EmptyState, MarketThumb, PageHeader } from "@/components/common";
import { HoverExplain } from "@/components/hover-explain";
import { FilterButton, LiveFeed } from "@/components/live-feed";
import { LiveSync } from "@/components/live-sync";
import { NextTick } from "@/components/next-tick";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { explain } from "@/lib/explain";
import { cents, num, polymarketMarketUrl, timeAgo, traderName, usd } from "@/lib/format";
import { groupSignals, sectionsByAge, summarize, type SignalGroup } from "@/lib/live";
import { getEngineStatus, getSignals, type EngineStatusView, type SignalRow } from "@/lib/queries";

export const metadata: Metadata = { title: "Live" };

const FILTERS = [
  { value: "all", label: "All" },
  { value: "copied", label: "Copied" },
  { value: "closed", label: "Sold" },
  { value: "skipped", label: "Skipped" },
] as const;

export default function LivePage() {
  return (
    <>
      <PageHeader
        title="Live signals"
        description="Every trade made by the traders you follow, what the copy engine did about it, and how it turned out. Hover or tap a reason for the full explanation."
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
const DECISION_LABEL = { copied: "Copied", closed: "Sold", skipped: "Skipped" } as const;

// The ?show= filter is applied in the browser (LiveFeed), so switching tabs needs no server trip.
async function LiveContent() {
  await connection();
  const [all, status] = await Promise.all([getSignals(200), getEngineStatus()]);
  const groups = groupSignals(all.map((r) => ({ ...r.signal, row: r })));

  return (
    <div className="grid items-start gap-4 lg:grid-cols-3 lg:gap-6">
      <LiveSync />
      <div className="space-y-4 lg:sticky lg:top-20 lg:order-last">
        <EngineCard status={status} />
        <SummaryCard summary={summarize(groups)} />
        <Card className="hidden gap-3 border-dashed py-4 lg:flex">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock className="size-4" aria-hidden /> Real-money trading
            </CardTitle>
            <CardDescription>Locked until paper results prove the strategy</CardDescription>
          </CardHeader>
          <CardContent className="text-muted-foreground space-y-2 text-sm">
            <p>
              Phase 2 will place real orders on US-legal venues (<strong>Kalshi</strong> or{" "}
              <strong>Polymarket US</strong>), with a kill switch, a daily loss limit and per-venue
              caps.
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-3 lg:col-span-2">
        <LiveFeed
          filters={FILTERS}
          items={sectionsByAge(groups).flatMap(([section, list]) =>
            list.map((g) => ({
              key: g.key,
              decision: g.head.decision,
              section,
              node: <SignalCard group={g} />,
            })),
          )}
          empty={
            <EmptyState title="No signals yet" icon={Radio}>
              {status.following === 0 ? (
                <>
                  Follow a few traders on the{" "}
                  <Link href="/" className="underline">
                    Traders
                  </Link>{" "}
                  page. Their new trades will show up here.
                </>
              ) : groups.length > 0 ? (
                "Nothing in this filter yet."
              ) : (
                "Waiting for the traders you follow to place their next trade."
              )}
            </EmptyState>
          }
        />
      </div>
    </div>
  );
}

function EngineCard({ status }: { status: EngineStatusView }) {
  const { healthy, stream } = status;
  const live = !!stream?.enabled && stream.connected;
  return (
    <Card className="gap-3 py-4 sm:gap-4 sm:py-6">
      <CardHeader className="px-4 sm:px-6">
        <CardTitle className="flex items-center gap-2">
          <Activity className="size-4" aria-hidden /> Copy engine
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5 px-4 text-sm sm:px-6">
        <p className="flex items-center gap-2">
          <span className={cn("size-2 rounded-full", healthy ? "bg-yes" : "bg-no")} aria-hidden />
          {healthy ? "Running" : "Not running"} · last check {timeAgo(status.lastTickAt)}
        </p>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-muted-foreground">Next check</span>
          <NextTick
            at={status.nextTickAt}
            from={status.lastTickAt?.toISOString() ?? null}
            intervalSeconds={status.intervalSeconds}
          />
        </p>
        <p className="flex items-start gap-2">
          <Zap
            className={cn("mt-0.5 size-4 shrink-0", live ? "text-yes" : "text-muted-foreground")}
            aria-hidden
          />
          <span>
            {live ? (
              <>
                <strong className="font-medium">Real-time feed on</strong>
                <span className="text-muted-foreground">
                  {" "}
                  · trades are copied seconds after they happen
                  {status.lastStreamBatchAt ? ` · last ${timeAgo(status.lastStreamBatchAt)}` : ""}
                </span>
              </>
            ) : !status.realtime ? (
              <span className="text-muted-foreground">
                Real-time feed is off in Settings; copying waits for each check.
              </span>
            ) : stream?.enabled ? (
              <span className="text-muted-foreground">Real-time feed reconnecting…</span>
            ) : (
              <span className="text-muted-foreground">
                Real-time feed starts once you follow someone (needs the server loop).
              </span>
            )}
          </span>
        </p>
        <p className="text-muted-foreground">
          Following {status.following} trader{status.following === 1 ? "" : "s"} ·{" "}
          <Link href="/paper" className="underline">
            paper results
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

type Row = SignalRow["signal"] & { row: SignalRow };

/** What happened in the last 24 hours, and the most common reasons trades were skipped. */
function SummaryCard({ summary }: { summary: ReturnType<typeof summarize> }) {
  const { total, copied, closed, skipped, topSkipReasons: top } = summary;
  const stats = [
    { label: "Trades", count: total, value: "all" },
    { label: "Copied", count: copied, value: "copied" },
    { label: "Sold", count: closed, value: "closed" },
    { label: "Skipped", count: skipped, value: "skipped" },
  ];
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4 sm:px-6">
        <CardTitle className="text-base">Last 24 hours</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 px-4 text-sm sm:px-6">
        <div className="grid grid-cols-4 gap-2 text-center">
          {stats.map((s) => (
            <FilterButton
              key={s.label}
              value={s.value}
              className="hover:bg-muted/50 rounded-md py-1"
            >
              <span className="block text-lg font-semibold tabular-nums">{s.count}</span>
              <span className="text-muted-foreground block text-xs">{s.label}</span>
            </FilterButton>
          ))}
        </div>
        {top.length > 0 && (
          <div>
            <p className="text-muted-foreground mb-1 text-xs">Most common skip reasons</p>
            <ul className="space-y-1">
              {top.map((r) => (
                <li key={r.label} className="flex items-baseline justify-between gap-2">
                  <span className="line-clamp-1">{r.label}</span>
                  <span className="text-muted-foreground shrink-0 tabular-nums">{r.n}×</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Outcome({ row }: { row: SignalRow }) {
  const { signal: s, outcome } = row;
  if (!outcome) return null;
  const chip = (value: number, label: string) => (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums",
        value > 0 ? "bg-gain/10 text-gain" : value < 0 ? "bg-loss/10 text-loss" : "bg-muted",
      )}
    >
      {label} {usd(value, { sign: true })}
    </span>
  );
  if (s.decision === "closed" && outcome.realized !== null) {
    return chip(outcome.realized, outcome.realized >= 0 ? "Profit" : "Loss");
  }
  const p = outcome.position;
  if (!p) return null;
  const body =
    p.status === "open"
      ? chip(p.unrealized + p.realizedPnl, "Open")
      : chip(
          p.realizedPnl,
          p.realizedPnl >= 0
            ? p.status === "settled"
              ? "Won"
              : "Profit"
            : p.status === "settled"
              ? "Lost"
              : "Loss",
        );
  return (
    <Link href={`/paper/positions/${p.id}`} className="hover:opacity-80" title="Open the position">
      {body}
    </Link>
  );
}

function SignalCard({ group }: { group: SignalGroup<Row> }) {
  const s = group.head;
  const many = group.rows.length > 1;
  const name = traderName({ name: s.row.name, wallet: s.wallet });
  const explanation = explain({
    reason: s.reason,
    code: s.reasonCode,
    details: s.details,
    side: s.side,
    outcome: s.outcome,
    retries: s.retries,
  });
  const title = s.slug ? (
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
  );
  return (
    <Card className="gap-0 py-3">
      <CardContent className="flex items-start gap-3 px-3 sm:px-4">
        <MarketThumb src={s.image} size={40} label={s.title} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="line-clamp-2 font-medium sm:line-clamp-1">{title}</p>
            <span className="text-muted-foreground shrink-0 pt-0.5 text-xs whitespace-nowrap">
              {timeAgo(s.leaderTs)}
            </span>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            <Link
              href={`/traders/${s.wallet}`}
              className="text-foreground font-medium hover:underline"
            >
              {name}
            </Link>{" "}
            <span
              className={cn(
                "mx-0.5 rounded px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap",
                s.side === "BUY" ? "bg-yes/10 text-yes" : "bg-no/10 text-no",
              )}
            >
              {s.side === "BUY" ? "Bought" : "Sold"} {s.outcome}
            </span>{" "}
            <span className="whitespace-nowrap">
              at {cents(group.avgPrice)}
              {many ? " avg" : ""} · {usd(group.totalUsdc, { compact: true })}
            </span>
            {many && <span className="whitespace-nowrap"> · {group.rows.length} fills</span>}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-xs font-semibold",
                DECISION_STYLE[s.decision],
              )}
            >
              {DECISION_LABEL[s.decision]}
            </span>
            <HoverExplain explanation={explanation} className="text-muted-foreground">
              {s.reason}
            </HoverExplain>
            <Outcome row={s.row} />
          </div>
          {many && (
            <details className="group mt-2 text-xs">
              <summary className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer list-none items-center gap-1">
                <ChevronDown
                  className="size-3.5 transition-transform group-open:rotate-180"
                  aria-hidden
                />
                Show {group.rows.length} fills
              </summary>
              <ul className="mt-2 divide-y rounded-md border">
                {group.rows.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between gap-3 px-2.5 py-1.5 tabular-nums"
                  >
                    <span className="text-muted-foreground">
                      {new Date(r.leaderTs).toLocaleTimeString("en-US", {
                        hour: "numeric",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </span>
                    <span>
                      {num(r.leaderSize, 1)} @ {cents(r.leaderPrice)}
                    </span>
                    <span className="font-medium">{usd(r.leaderUsdc)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
