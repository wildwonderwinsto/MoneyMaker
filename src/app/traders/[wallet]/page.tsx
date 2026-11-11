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
import { LockedAction } from "@/components/locked-action";
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
import { historyNote, positionsNote } from "@/lib/explain";
import {
  cents,
  copiedLate,
  monthlyCumulative,
  num,
  pct,
  polymarketMarketUrl,
  polymarketProfileUrl,
  shortAddress,
  timeAgo,
  traderName,
  usd,
} from "@/lib/format";
import { getDb } from "@/lib/db/client";
import { fetchRecentPositions, positionResult } from "@/lib/jobs/backfill";
import type { ScoringConfig } from "@/lib/scoring/config";
import type { TraderMetrics } from "@/lib/scoring/metrics";
import { provenStatus } from "@/lib/scoring/score";
import { normalCdf } from "@/lib/scoring/stats";
import { getScoringConfig } from "@/lib/settings";
import { getTrader } from "@/lib/queries";

export const metadata: Metadata = { title: "Trader" };

const PCT_CHECKS = new Set([
  "roi",
  "top_market",
  "top3_markets",
  "profitable_months",
  "both_sides",
  "copy_roi",
  "copy_loss",
  "recent",
]);

/** What the Recent positions table shows: a stored row, or one loaded live. */
interface PositionView {
  tokenId: string;
  conditionId: string;
  title?: string | null;
  slug?: string | null;
  outcome?: string | null;
  status?: string | null;
  size?: number | null;
  avgPrice?: number | null;
  totalCost?: number | null;
  realizedPnl?: number | null;
  unrealizedPnl?: number | null;
  won: boolean | null;
}

function CheckRow({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {ok ? (
        <CheckCircle2 className="text-yes mt-0.5 size-4 shrink-0" aria-label="Pass" />
      ) : (
        <XCircle className="text-no mt-0.5 size-4 shrink-0" aria-label="Fail" />
      )}
      <span className="flex-1">{label}</span>
      <span className="text-muted-foreground pt-0.5 text-xs tabular-nums">{value}</span>
    </li>
  );
}

/**
 * The Proven tier's record: the trader's bets since they became Verified, replayed as
 * copies (late, with slippage and fees). Shown once they've been Verified.
 */
function ProvenRecord({
  metrics,
  cfg,
  passed,
}: {
  metrics: Partial<TraderMetrics>;
  cfg: ScoringConfig;
  passed: boolean;
}) {
  if (typeof metrics.sinceVerifiedFrom !== "number") return null;
  const p = provenStatus(metrics as TraderMetrics, cfg);
  const since = new Date(metrics.sinceVerifiedFrom * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const open = metrics.sinceVerifiedOpenCopies ?? 0;
  return (
    <div className="mt-5 border-t pt-4">
      <p className="text-sm font-medium">Proven record</p>
      <p className="text-muted-foreground mt-0.5 mb-3 text-xs">
        Their bets since they were verified ({since}), copied late with slippage and fees.
        {passed ? "" : " Counts only while every check above passes."}
      </p>
      <ul className="space-y-2.5">
        <CheckRow
          ok={p.days !== null && p.days >= cfg.provenMinDays}
          label={`At least ${cfg.provenMinDays} days since verified`}
          value={p.days === null ? "not measured" : `${num(p.days, 0)} days`}
        />
        <CheckRow
          ok={p.copies !== null && p.copies >= cfg.provenMinCopies}
          label={`At least ${cfg.provenMinCopies} copied bets since verified`}
          value={
            p.copies === null
              ? "not replayed"
              : `${p.copies} bets${open ? ` (${open} still open)` : ""}`
          }
        />
        <CheckRow
          ok={p.copyRoi !== null && p.copyRoi > 0}
          label={
            "Copying them made money since" +
            (cfg.copyRoiZ > 0 ? ` (${pct(normalCdf(cfg.copyRoiZ), 0)} confident)` : "")
          }
          value={p.copyRoi === null ? "not measured" : pct(p.copyRoi, 1, { sign: true })}
        />
      </ul>
    </div>
  );
}

function checkValue(c: ScoreCheck): string {
  if (c.display) return c.display;
  if (c.value === null) return "not measured";
  if (c.code === "skill" || c.code === "no_edge") return `evidence ×${num(c.value, 1)}`;
  if (c.code === "candidate_age") return `${num(c.value, 0)} days`;
  if (c.code === "hold_time") return `${num(c.value, 1)} h`;
  if (c.code === "active") return `${num(c.value, 1)} days ago`;
  if (PCT_CHECKS.has(c.code)) return pct(c.value, 1);
  return num(c.value, c.code === "recovery" ? 2 : 0);
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
  const [data, admin, scoring] = await Promise.all([
    getTrader(wallet.toLowerCase()),
    isAdmin(),
    getScoringConfig(getDb()),
  ]);
  if (!data) notFound();
  const { trader, score, follow, pnl, hidden } = data;
  // Nothing stored (Candidates and Rejected traders are pruned after scoring): an unlocked
  // admin gets the latest positions live from Polymarket (owner, 2026-11-10). Visitors'
  // page loads never call Polymarket (UI-17), so they keep the note.
  let positions: PositionView[] = data.positions;
  let live: "loaded" | "failed" | null = null;
  if (positions.length === 0 && admin) {
    try {
      positions = await fetchRecentPositions(trader.wallet);
      live = "loaded";
    } catch {
      live = "failed";
    }
  }
  const metrics = (score?.metrics ?? {}) as {
    monthlyPnl?: Array<{ month: string; pnl: number }>;
    resolvedWinRate?: number | null;
    recoveryFactor?: number | null;
    nCopyReplays?: number;
    copyAdjRoiMean?: number | null;
    copyReplayDays?: number | null;
    copyOpenReplays?: number;
    copyDelaySeconds?: number;
    nClosed?: number;
    nHoldout?: number | null;
  };
  const name = traderName(trader);
  const passed = score?.checks.filter((c) => c.ok).length ?? 0;
  const monthly = monthlyCumulative(metrics.monthlyPnl);

  return (
    <div className="space-y-4 sm:space-y-6">
      <Link
        href="/"
        className="text-muted-foreground hover:text-foreground -my-2 inline-block py-2 text-sm"
      >
        ← All traders
      </Link>

      <div className="flex flex-wrap items-center gap-3 sm:gap-4">
        <Avatar wallet={trader.wallet} src={trader.profileImage} size={64} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">{name}</h1>
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
            <p className="text-3xl font-semibold tabular-nums sm:text-4xl">
              {Math.round(score.score)}
            </p>
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
        ) : follow?.enabled ? (
          <span className="bg-yes/10 text-yes rounded-full px-3 py-1.5 text-sm font-semibold">
            Following
          </span>
        ) : (
          <LockedAction label="Follow" size="default" />
        )}
      </div>

      {!score ? (
        <p className="text-muted-foreground">This trader hasn&apos;t been scored yet.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatTile
              label="Realized P&L"
              value={usd(score.totalPnl, { compact: true, sign: true })}
              tone={(score.totalPnl ?? 0) >= 0 ? "gain" : "loss"}
              hint={
                typeof metrics.nClosed === "number"
                  ? `${metrics.nClosed} finished positions`
                  : `${score.nResolved} resolved markets`
              }
            />
            <StatTile
              label="Return on risk"
              value={pct(score.roi, 1, { sign: true })}
              hint={`${pct(score.roiShrunk, 1)} after sample-size adjustment`}
            />
            <StatTile
              label="Wins vs. expected"
              value={
                metrics.resolvedWinRate === null || metrics.resolvedWinRate === undefined
                  ? "—"
                  : `${pct(metrics.resolvedWinRate, 0)} / ${pct(score.expectedWinRate, 0)}`
              }
              hint={
                typeof metrics.nHoldout === "number" && metrics.nHoldout > 0
                  ? `Skill z = ${num(score.zSkill, 2)} · ${metrics.nHoldout} bets since picked`
                  : "Measured only on bets placed since they were picked; none settled yet"
              }
            />
            <StatTile
              label={`If copied ${copiedLate(metrics.copyDelaySeconds, scoring.copyDelaySeconds)}`}
              value={pct(score.copyAdjRoi, 1, { sign: true })}
              tone={score.copyAdjRoi === null ? undefined : score.copyAdjRoi >= 0 ? "gain" : "loss"}
              hint={
                typeof metrics.copyAdjRoiMean === "number"
                  ? `Cautious estimate · average ${pct(metrics.copyAdjRoiMean, 1, { sign: true })} over ${metrics.nCopyReplays} trades` +
                    (typeof metrics.copyReplayDays === "number"
                      ? ` in ${Math.max(1, Math.round(metrics.copyReplayDays))} days`
                      : "") +
                    (metrics.copyOpenReplays ? ` (${metrics.copyOpenReplays} still open)` : "")
                  : typeof metrics.nCopyReplays === "number" && metrics.nCopyReplays > 0
                    ? `Replayed ${metrics.nCopyReplays} of their trades`
                    : "Delayed entry + spread + fees"
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

          <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-5">
            <Card className="gap-4 py-4 sm:gap-6 sm:py-6 lg:col-span-2">
              <CardHeader className="px-4 sm:px-6">
                <CardTitle>Why this score</CardTitle>
                <CardDescription>
                  Passed {passed} of {score.checks.length} checks · updated{" "}
                  {timeAgo(score.computedAt)}
                </CardDescription>
              </CardHeader>
              <CardContent className="px-4 sm:px-6">
                <ul className="space-y-2.5">
                  {score.checks.map((c) => (
                    <CheckRow key={c.code} ok={c.ok} label={c.label} value={checkValue(c)} />
                  ))}
                </ul>
                <ProvenRecord
                  metrics={score.metrics as Partial<TraderMetrics>}
                  cfg={scoring}
                  passed={score.passed}
                />
              </CardContent>
            </Card>

            <div className="space-y-4 sm:space-y-6 lg:col-span-3">
              <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
                <CardHeader className="px-4 sm:px-6">
                  <CardTitle>Cumulative profit</CardTitle>
                  <CardDescription>
                    {pnl.length > 0
                      ? "Realized + unrealized P&L, daily"
                      : historyNote(score.tier, monthly.length > 0)}
                  </CardDescription>
                </CardHeader>
                <CardContent className="px-4 sm:px-6">
                  {/* Daily history is pruned for Candidates and Rejected traders (storage); the
                      monthly P&L kept with their score still gives the shape. */}
                  {pnl.length > 0 || monthly.length > 0 ? (
                    <LineChart
                      data={pnl.length > 0 ? pnl.map((p) => ({ t: p.day, pnl: p.pnl })) : monthly}
                      series={[{ key: "pnl", label: "Cumulative P&L", color: "var(--series-1)" }]}
                    />
                  ) : null}
                </CardContent>
              </Card>
              <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
                <CardHeader className="px-4 sm:px-6">
                  <CardTitle>Monthly profit & loss</CardTitle>
                  <CardDescription>Consistent winners have mostly blue bars</CardDescription>
                </CardHeader>
                <CardContent className="px-4 sm:px-6">
                  <PnlBars data={metrics.monthlyPnl ?? []} />
                </CardContent>
              </Card>
            </div>
          </div>

          <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
            <CardHeader className="px-4 sm:px-6">
              <CardTitle>Recent positions</CardTitle>
              <CardDescription>
                Latest 40 markets this trader was active in
                {live === "loaded" && " · loaded live from Polymarket (not stored for this tier)"}
              </CardDescription>
            </CardHeader>
            <CardContent className="px-4 sm:px-6">
              {positions.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {live === "failed"
                    ? "Couldn't load this trader's positions from Polymarket right now. Reload to try again."
                    : live === "loaded"
                      ? "Polymarket has no positions with a known cost for this trader."
                      : `${positionsNote(score?.tier, positions.length)}${admin ? "" : " Unlock to see the latest ones live."}`}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Market</TableHead>
                      <TableHead className="hidden md:table-cell">Side</TableHead>
                      <TableHead className="hidden text-right md:table-cell">Avg price</TableHead>
                      <TableHead className="hidden text-right md:table-cell">Invested</TableHead>
                      <TableHead className="text-right">P&L</TableHead>
                      <TableHead className="hidden md:table-cell">Result</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {positions.map((p) => {
                      const total = (p.realizedPnl ?? 0) + (p.unrealizedPnl ?? 0);
                      const r = positionResult(p, { live: live === "loaded" });
                      const result =
                        r === "won" ? (
                          <span className="text-yes font-medium">Won</span>
                        ) : r === "lost" ? (
                          <span className="text-no font-medium">Lost</span>
                        ) : r === "sold" || r === "closed" ? (
                          <span className="text-muted-foreground">
                            {r === "sold" ? "Sold" : "Closed"}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Open</span>
                        );
                      return (
                        <TableRow key={p.tokenId}>
                          <TableCell className="max-w-[340px] whitespace-normal md:max-w-[280px] md:truncate lg:max-w-[340px]">
                            {/* Under md: two lines of title, side and result underneath. */}
                            <span className="line-clamp-2 md:line-clamp-none">
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
                            </span>
                            <span className="text-muted-foreground mt-0.5 block text-xs md:hidden">
                              {p.outcome ?? "—"} · {result}
                            </span>
                          </TableCell>
                          <TableCell className="hidden md:table-cell">{p.outcome ?? "—"}</TableCell>
                          <TableCell className="hidden text-right tabular-nums md:table-cell">
                            {cents(p.avgPrice)}
                          </TableCell>
                          <TableCell className="hidden text-right tabular-nums md:table-cell">
                            {usd(p.totalCost, { compact: true })}
                          </TableCell>
                          <TableCell className="text-right">
                            <Signed value={total}>
                              {usd(total, { compact: true, sign: true })}
                            </Signed>
                          </TableCell>
                          <TableCell className="hidden md:table-cell">{result}</TableCell>
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
