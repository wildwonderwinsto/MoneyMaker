import { CheckCircle2, ExternalLink, XCircle } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";

import { LineChart } from "@/components/charts/line-chart";
import { PnlBars } from "@/components/charts/pnl-bars";
import { Avatar, Signed, StatTile, TierBadge } from "@/components/common";
import { FollowButton } from "@/components/follow-button";
import { HideButton } from "@/components/hide-button";
import { isAdmin } from "@/lib/admin";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ScoreCheck } from "@/lib/db/schema";
import {
  cents,
  num,
  pct,
  polymarketMarketUrl,
  polymarketProfileUrl,
  shortAddress,
  timeAgo,
  traderName,
  usd,
} from "@/lib/format";
import { getTrader } from "@/lib/queries";

export const metadata: Metadata = { title: "Trader" };

const PCT_CHECKS = new Set([
  "roi",
  "top_market",
  "top3_markets",
  "profitable_months",
  "both_sides",
  "copy_roi",
  "recent",
]);

function checkValue(c: ScoreCheck): string {
  if (c.value === null) return "not measured";
  if (c.code === "skill_luck") return `p = ${c.value.toExponential(1)}`;
  if (c.code === "hold_time") return `${num(c.value, 1)} h`;
  if (c.code === "active") return `${num(c.value, 1)} days ago`;
  if (PCT_CHECKS.has(c.code)) return pct(c.value, 1);
  return num(c.value, c.code === "skill_z" || c.code === "recovery" ? 2 : 0);
}

export default function TraderPage({ params }: PageProps<"/traders/[wallet]">) {
  return (
    <Suspense fallback={<Skeleton className="h-[600px] rounded-xl" />}>
      <TraderDetail params={params} />
    </Suspense>
  );
}

async function TraderDetail({ params }: { params: PageProps<"/traders/[wallet]">["params"] }) {
  await connection();
  const { wallet } = await params;
  const [data, admin] = await Promise.all([getTrader(wallet.toLowerCase()), isAdmin()]);
  if (!data) notFound();
  const { trader, score, follow, positions, pnl, hidden } = data;
  const metrics = (score?.metrics ?? {}) as {
    monthlyPnl?: Array<{ month: string; pnl: number }>;
    resolvedWinRate?: number | null;
    recoveryFactor?: number | null;
    nCopyReplays?: number;
  };
  const name = traderName(trader);
  const passed = score?.checks.filter((c) => c.ok).length ?? 0;

  return (
    <div className="space-y-6">
      <Link href="/" className="text-muted-foreground hover:text-foreground text-sm">
        ← All traders
      </Link>

      <div className="flex flex-wrap items-center gap-4">
        <Avatar wallet={trader.wallet} src={trader.profileImage} size={64} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{name}</h1>
          <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-2 text-sm">
            {score && <TierBadge tier={score.tier} />}
            <a
              href={polymarketProfileUrl(trader.wallet)}
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground inline-flex items-center gap-1"
            >
              {shortAddress(trader.wallet)} <ExternalLink className="size-3" aria-hidden />
            </a>
            {trader.xUsername && <span>@{trader.xUsername}</span>}
            {score?.primaryCategory && (
              <span className="capitalize">· {score.primaryCategory}</span>
            )}
          </div>
        </div>
        {score && (
          <div className="text-right">
            <p className="text-4xl font-semibold tabular-nums">{Math.round(score.score)}</p>
            <p className="text-muted-foreground text-xs">score / 100</p>
          </div>
        )}
        {admin ? (
          <div className="flex items-center gap-1">
            <HideButton wallet={trader.wallet} hidden={!!hidden} size="default" />
            {!hidden && (
              <FollowButton wallet={trader.wallet} following={!!follow?.enabled} size="default" />
            )}
          </div>
        ) : (
          follow?.enabled && (
            <span className="bg-yes/10 text-yes rounded-full px-3 py-1.5 text-sm font-semibold">
              Following
            </span>
          )
        )}
      </div>

      {!score ? (
        <p className="text-muted-foreground">This trader hasn&apos;t been scored yet.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatTile
              label="Realized P&L"
              value={usd(score.totalPnl, { compact: true, sign: true })}
              tone={(score.totalPnl ?? 0) >= 0 ? "gain" : "loss"}
              hint={`${score.nResolved} resolved markets`}
            />
            <StatTile
              label="Return on risk"
              value={pct(score.roi, 1, { sign: true })}
              hint={`${pct(score.roiShrunk, 1)} after sample-size adjustment`}
            />
            <StatTile
              label="Wins vs. expected"
              value={`${pct(metrics.resolvedWinRate, 0)} / ${pct(score.expectedWinRate, 0)}`}
              hint={`Skill z = ${num(score.zSkill, 2)}`}
            />
            <StatTile
              label="If copied 2 min late"
              value={pct(score.copyAdjRoi, 1, { sign: true })}
              tone={score.copyAdjRoi === null ? undefined : score.copyAdjRoi >= 0 ? "gain" : "loss"}
              hint={
                typeof metrics.nCopyReplays === "number" && metrics.nCopyReplays > 0
                  ? `Replayed ${metrics.nCopyReplays} of their trades`
                  : "Delayed entry + spread"
              }
            />
            <StatTile
              label="Profitable months"
              value={pct(score.profitableMonthsPct, 0)}
              hint={`Recovery ${num(metrics.recoveryFactor, 1)}× worst drawdown`}
            />
            <StatTile
              label="Biggest win share"
              value={pct(score.topMarketShare, 0)}
              hint="of all profits (lower = steadier)"
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-5">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Why this score</CardTitle>
                <CardDescription>
                  Passed {passed} of {score.checks.length} checks · updated{" "}
                  {timeAgo(score.computedAt)}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2.5">
                  {score.checks.map((c) => (
                    <li key={c.code} className="flex items-start gap-2 text-sm">
                      {c.ok ? (
                        <CheckCircle2
                          className="text-yes mt-0.5 size-4 shrink-0"
                          aria-label="Pass"
                        />
                      ) : (
                        <XCircle className="text-no mt-0.5 size-4 shrink-0" aria-label="Fail" />
                      )}
                      <span className="flex-1">{c.label}</span>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {checkValue(c)}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            <div className="space-y-6 lg:col-span-3">
              <Card>
                <CardHeader>
                  <CardTitle>Cumulative profit</CardTitle>
                  <CardDescription>Realized + unrealized P&L, daily</CardDescription>
                </CardHeader>
                <CardContent>
                  <LineChart
                    data={pnl.map((p) => ({ t: p.day, pnl: p.pnl }))}
                    series={[{ key: "pnl", label: "Cumulative P&L", color: "var(--series-1)" }]}
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Monthly profit & loss</CardTitle>
                  <CardDescription>Consistent winners have mostly blue bars</CardDescription>
                </CardHeader>
                <CardContent>
                  <PnlBars data={metrics.monthlyPnl ?? []} />
                </CardContent>
              </Card>
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Recent positions</CardTitle>
              <CardDescription>Latest 40 markets this trader was active in</CardDescription>
            </CardHeader>
            <CardContent>
              {positions.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  Position history is only kept for shortlisted traders.
                </p>
              ) : (
                <Table className="min-w-[640px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Market</TableHead>
                      <TableHead>Side</TableHead>
                      <TableHead className="text-right">Avg price</TableHead>
                      <TableHead className="text-right">Invested</TableHead>
                      <TableHead className="text-right">P&L</TableHead>
                      <TableHead>Result</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {positions.map((p) => {
                      const total = (p.realizedPnl ?? 0) + (p.unrealizedPnl ?? 0);
                      return (
                        <TableRow key={p.id}>
                          <TableCell className="max-w-[340px] truncate">
                            {p.slug ? (
                              <a
                                href={polymarketMarketUrl(p.slug)}
                                target="_blank"
                                rel="noreferrer"
                                className="hover:underline"
                              >
                                {p.title ?? p.slug}
                              </a>
                            ) : (
                              (p.title ?? p.conditionId)
                            )}
                          </TableCell>
                          <TableCell>{p.outcome ?? "—"}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {cents(p.avgPrice)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {usd(p.totalCost, { compact: true })}
                          </TableCell>
                          <TableCell className="text-right">
                            <Signed value={total}>
                              {usd(total, { compact: true, sign: true })}
                            </Signed>
                          </TableCell>
                          <TableCell>
                            {p.won === true ? (
                              <span className="text-yes font-medium">Won</span>
                            ) : p.won === false ? (
                              <span className="text-no font-medium">Lost</span>
                            ) : (
                              <span className="text-muted-foreground">Open</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
