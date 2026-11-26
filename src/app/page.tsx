import { cn } from "cn";
import { Activity, ArrowRight, LineChart, Radio, Users } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { Avatar, MarketThumb, PageHeader, Signed, StatTile, TierBadge } from "@/components/common";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { num, pct, timeAgo, traderName, usd } from "@/lib/format";
import { groupSignals } from "@/lib/live";
import {
  getEngineStatus,
  getHomeOverview,
  getLast24hSummary,
  getSignals,
  getTierCounts,
  type EngineStatusView,
  type HomeOverview,
  type SignalRow,
} from "@/lib/queries";

/** Color only real gains/losses; exactly zero stays neutral. */
const toneOf = (x: number) => (x > 0 ? "gain" : x < 0 ? "loss" : undefined);

export default function HomePage() {
  return (
    <>
      <PageHeader
        title="Overview"
        description="MoneyMaker finds Polymarket traders who win by skill, not luck, and copies their trades with paper money at real prices. Here is how it's going."
      />
      <Suspense fallback={<HomeSkeleton />}>
        <HomeContent />
      </Suspense>
    </>
  );
}

async function HomeContent() {
  await connection();
  const [home, status, summary, signals, counts] = await Promise.all([
    getHomeOverview(),
    getEngineStatus(),
    getLast24hSummary(),
    // Same query (and cached result) as the Live page.
    getSignals(200),
    getTierCounts(),
  ]);
  const recent = groupSignals(signals.map((r) => ({ ...r.signal, row: r }))).slice(0, 6);

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-4">
        <StatTile
          label="Equity"
          value={usd(home.equity)}
          hint={`Started with ${usd(home.startingBalance)}`}
        />
        <StatTile
          label="Total return"
          value={pct(home.totalReturn, 2, { sign: true })}
          tone={toneOf(home.totalReturn)}
          hint={`Realized ${usd(home.realized, { sign: true })}`}
        />
        <StatTile
          label="Open positions"
          value={num(home.openCount)}
          hint={
            <>
              Unrealized{" "}
              <Signed value={home.unrealized}>{usd(home.unrealized, { sign: true })}</Signed>
            </>
          }
        />
        <StatTile
          label="Win rate"
          value={pct(home.winRate, 0)}
          hint={`${home.finishedCount} finished positions · ${usd(home.cash)} cash`}
        />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3 lg:gap-6">
        <div className="space-y-4 lg:col-span-2">
          <RecentActivity groups={recent} />
          <Followed home={home} />
        </div>
        <div className="space-y-4">
          <EngineSummary status={status} />
          <Last24h summary={summary} />
          <TraderPool counts={counts} />
        </div>
      </div>
    </div>
  );
}

function SeeAll({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <CardAction>
      <Link
        href={href}
        className="text-muted-foreground hover:text-foreground -my-2 inline-flex items-center gap-1 py-2 text-sm"
      >
        {children} <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </CardAction>
  );
}

const DECISION = {
  copied: { label: "Copied", className: "bg-yes/10 text-yes" },
  closed: { label: "Sold", className: "bg-primary/10 text-primary" },
  skipped: { label: "Skipped", className: "bg-muted text-muted-foreground" },
} as const;

type Row = SignalRow["signal"] & { row: SignalRow };

function RecentActivity({ groups }: { groups: ReturnType<typeof groupSignals<Row>> }) {
  return (
    <Card className="gap-3 py-4 sm:gap-4 sm:py-6">
      <CardHeader className="px-4 sm:px-6">
        <CardTitle className="flex items-center gap-2">
          <Radio className="size-4" aria-hidden /> Latest trades
        </CardTitle>
        <SeeAll href="/live">Live</SeeAll>
      </CardHeader>
      <CardContent className="px-4 sm:px-6">
        {groups.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing yet. Trades by the traders you follow show up here as they happen.
          </p>
        ) : (
          <ul className="divide-y">
            {groups.map((g) => {
              const s = g.head;
              const d = DECISION[s.decision as keyof typeof DECISION] ?? DECISION.skipped;
              return (
                <li key={g.key} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <MarketThumb src={s.image} size={36} label={s.title} />
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-1 text-sm font-medium">{s.title}</p>
                    <p className="text-muted-foreground line-clamp-1 text-xs">
                      <Link href={`/traders/${s.wallet}`} className="hover:underline">
                        {traderName({ name: s.row.name, wallet: s.wallet })}
                      </Link>{" "}
                      {s.side === "BUY" ? "bought" : "sold"} {s.outcome ?? ""} · {usd(g.totalUsdc)}{" "}
                      · {timeAgo(s.leaderTs)}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold",
                      d.className,
                    )}
                  >
                    {d.label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Followed({ home }: { home: HomeOverview }) {
  return (
    <Card className="gap-3 py-4 sm:gap-4 sm:py-6">
      <CardHeader className="px-4 sm:px-6">
        <CardTitle className="flex items-center gap-2">
          <LineChart className="size-4" aria-hidden /> Traders you copy
        </CardTitle>
        <SeeAll href="/paper">Paper results</SeeAll>
      </CardHeader>
      <CardContent className="px-4 sm:px-6">
        {home.followed.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            You aren&apos;t copying anyone yet. Pick a few on the{" "}
            <Link href="/traders" className="underline">
              Traders
            </Link>{" "}
            page.
          </p>
        ) : (
          <ul className="divide-y">
            {home.followed.map((t) => (
              <li key={t.wallet} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <Avatar wallet={t.wallet} src={t.profileImage} size={32} />
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/traders/${t.wallet}`}
                    className="line-clamp-1 text-sm font-medium hover:underline"
                  >
                    {traderName(t)}
                  </Link>
                  <p className="text-muted-foreground text-xs">
                    {t.open} open position{t.open === 1 ? "" : "s"}
                  </p>
                </div>
                {t.tier && <TierBadge tier={t.tier} />}
                <span className="w-24 shrink-0 text-right text-sm font-medium tabular-nums">
                  <Signed value={t.pnl}>{usd(t.pnl, { sign: true })}</Signed>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function EngineSummary({ status }: { status: EngineStatusView }) {
  const live = !!status.stream?.enabled && status.stream.connected;
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4 sm:px-6">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="size-4" aria-hidden /> Copy engine
        </CardTitle>
        <SeeAll href="/live">Details</SeeAll>
      </CardHeader>
      <CardContent className="space-y-1.5 px-4 text-sm sm:px-6">
        <p className="flex items-center gap-2">
          <span
            className={cn("size-2 rounded-full", status.healthy ? "bg-yes" : "bg-no")}
            aria-hidden
          />
          {status.healthy ? "Running" : "Not running"} · last check {timeAgo(status.lastTickAt)}
        </p>
        <p className="text-muted-foreground">
          {live
            ? "Real-time feed on"
            : status.realtime
              ? "Real-time feed off right now"
              : "Real-time feed off"}{" "}
          · following {status.following} trader{status.following === 1 ? "" : "s"}
        </p>
        {status.outOfCash && <p className="text-loss font-medium">Out of cash: buys are paused</p>}
      </CardContent>
    </Card>
  );
}

function Last24h({ summary }: { summary: Awaited<ReturnType<typeof getLast24hSummary>> }) {
  const stats = [
    { label: "Trades", n: summary.total },
    { label: "Copied", n: summary.copied },
    { label: "Sold", n: summary.closed },
    { label: "Skipped", n: summary.skipped },
  ];
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4 sm:px-6">
        <CardTitle className="text-base">Last 24 hours</CardTitle>
      </CardHeader>
      <CardContent className="px-4 sm:px-6">
        <dl className="grid grid-cols-4 gap-2 text-center">
          {stats.map((s) => (
            <div key={s.label}>
              <dd className="text-lg font-semibold tabular-nums">{s.n}</dd>
              <dt className="text-muted-foreground text-xs">{s.label}</dt>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function TraderPool({ counts }: { counts: Awaited<ReturnType<typeof getTierCounts>> }) {
  const tiers = (["proven", "elite", "verified", "candidate"] as const).map((t) => ({
    tier: t,
    n: counts.tiers[t] ?? 0,
  }));
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4 sm:px-6">
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="size-4" aria-hidden /> Trader pool
        </CardTitle>
        <SeeAll href="/traders">Traders</SeeAll>
      </CardHeader>
      <CardContent className="space-y-2 px-4 text-sm sm:px-6">
        <ul className="space-y-1.5">
          {tiers.map(({ tier, n }) => (
            <li key={tier} className="flex items-center justify-between gap-2">
              <TierBadge tier={tier} />
              <span className="tabular-nums">{n}</span>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground text-xs">{counts.all} traders analysed in all</p>
      </CardContent>
    </Card>
  );
}

function HomeSkeleton() {
  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
        <Skeleton className="h-96 rounded-xl lg:col-span-2" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    </div>
  );
}
