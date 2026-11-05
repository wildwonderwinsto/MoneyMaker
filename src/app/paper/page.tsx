import { cn } from "cn";
import { ChevronDown, ChevronRight, LineChart as LineChartIcon, Shield } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { AutoRefresh } from "@/components/auto-refresh";
import { EquityChart } from "@/components/charts/equity-chart";
import { EmptyState, MarketThumb, PageHeader, Signed, StatTile } from "@/components/common";
import { ResetPaperForm } from "@/components/forms";
import { LockedAction } from "@/components/locked-action";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { isAdmin } from "@/lib/admin";
import { cents, num, pct, timeAgo, traderName, usd } from "@/lib/format";
import { getPaperOverview, type PaperOverview } from "@/lib/queries";

export const metadata: Metadata = { title: "Paper trading" };

/** Color only real gains/losses; exactly zero stays neutral. */
const toneOf = (x: number) => (x > 0 ? "gain" : x < 0 ? "loss" : undefined);

export default function PaperPage() {
  return (
    <>
      <PageHeader
        title="Paper trading"
        description="Fake money, real prices. Each copied trade is filled against the live Polymarket order book, so slippage is included. Positions settle at $1 or $0 when the market resolves."
      />
      <Suspense fallback={<Skeleton className="h-[600px] rounded-xl" />}>
        <PaperContent />
      </Suspense>
    </>
  );
}

async function PaperContent() {
  await connection();
  const [p, admin] = await Promise.all([getPaperOverview(), isAdmin()]);
  const unrealized = p.open.reduce(
    (a, x) => a + x.shares * (x.currentPrice ?? x.avgPrice) - x.costBasis,
    0,
  );
  const realized = p.closed.reduce((a, x) => a + x.realizedPnl, 0);
  const curve = [
    ...p.equityCurve,
    { t: new Date().toISOString(), equity: Math.round(p.equity * 100) / 100 },
  ];
  const names = new Map(p.byTrader.map((t) => [t.wallet, t.name]));

  return (
    <div className="space-y-4 sm:space-y-6">
      <AutoRefresh seconds={30} />
      <div className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label="Equity"
          value={usd(p.equity)}
          hint={`Started with ${usd(p.account.startingBalance)}`}
        />
        <StatTile
          label="Total return"
          value={pct(p.totalReturn, 2, { sign: true })}
          tone={toneOf(p.totalReturn)}
          hint={p.account.resetAt ? `since reset ${timeAgo(p.account.resetAt)}` : "all time"}
        />
        <StatTile label="Cash" value={usd(p.cash)} hint={`${p.open.length} open positions`} />
        <StatTile
          label="Unrealized P&L"
          value={usd(unrealized, { sign: true })}
          tone={toneOf(unrealized)}
          hint={`Realized ${usd(realized, { sign: true })}`}
        />
        <StatTile
          label="Win rate"
          value={pct(p.winRate, 0)}
          hint={`${p.finishedCount} finished positions`}
        />
      </div>

      <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
        <CardHeader className="px-3 sm:px-6">
          <CardTitle>Equity</CardTitle>
          <CardDescription>
            Cash + open positions at market prices. ▲ marks a buy, ▼ a sell or settlement: hover or
            tap one for the trade.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-3 sm:px-6">
          {curve.length < 2 ? (
            <p className="text-muted-foreground text-sm">
              The curve appears after the first ticks.
            </p>
          ) : (
            <EquityChart
              curve={curve}
              fills={p.markers.map((m) => ({ ...m, ts: m.ts.toISOString() }))}
              baseline={p.account.startingBalance}
            />
          )}
        </CardContent>
      </Card>

      <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
        <CardHeader className="px-3 sm:px-6">
          <CardTitle>Open positions</CardTitle>
          <CardDescription>
            Tap a position to see its trades, the trader&apos;s moves and hedge options.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-3 sm:px-6">
          {p.open.length === 0 ? (
            <EmptyState title="No open positions" icon={LineChartIcon}>
              Follow traders on the{" "}
              <Link href="/" className="underline">
                Traders
              </Link>{" "}
              page. Their next qualifying trade will be copied here.
            </EmptyState>
          ) : (
            <OpenPositions open={p.open} names={names} />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
        <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
          <CardHeader className="px-3 sm:px-6">
            <CardTitle>Results by trader</CardTitle>
            <CardDescription>
              How much money each trader has made (or lost) you. Open one to see every position.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-3 sm:px-6">
            {p.byTrader.length === 0 ? (
              <p className="text-muted-foreground text-sm">No copied trades yet.</p>
            ) : (
              <ul className="space-y-2">
                {p.byTrader.map((t) => (
                  <TraderResult key={t.wallet} t={t} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
          <CardHeader className="px-3 sm:px-6">
            <CardTitle>Recent fills</CardTitle>
            <CardDescription>Simulated against the live order book</CardDescription>
          </CardHeader>
          <CardContent className="px-3 sm:px-6">
            {p.fills.length === 0 ? (
              <p className="text-muted-foreground text-sm">No fills yet.</p>
            ) : (
              <ul className="divide-y text-sm">
                {p.fills.map(({ fill: f, title, outcome }) => (
                  <li key={f.id}>
                    <Link
                      href={f.positionId ? `/paper/positions/${f.positionId}` : "/paper"}
                      className="hover:bg-muted/50 -mx-2 flex items-center gap-3 rounded-md px-2 py-2"
                    >
                      <span
                        className={cn(
                          "w-11 shrink-0 text-xs font-semibold",
                          f.side === "BUY" || f.side === "WIN"
                            ? "text-yes"
                            : f.side === "SPLIT"
                              ? "text-muted-foreground"
                              : "text-no",
                        )}
                      >
                        {f.side}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-1">
                          {title} <span className="text-muted-foreground">· {outcome}</span>
                        </span>
                        <span className="text-muted-foreground text-xs tabular-nums">
                          {num(f.shares, 1)} @ {cents(f.avgPrice)} · {timeAgo(f.ts)}
                        </span>
                      </span>
                      <span className="text-right tabular-nums">
                        {usd(f.notional)}
                        {f.realizedPnl !== null && (
                          <span className="block text-xs">
                            <Signed value={f.realizedPnl}>
                              {usd(f.realizedPnl, { sign: true })}
                            </Signed>
                          </span>
                        )}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
        <CardHeader className="px-3 sm:px-6">
          <CardTitle>Account</CardTitle>
          <CardDescription>
            Start over with a fresh balance, for example after changing risk rules.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-3 sm:px-6">
          {admin ? (
            <ResetPaperForm current={p.account.startingBalance} />
          ) : (
            <LockedAction label="Reset account" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function OpenPositions({
  open,
  names,
}: {
  open: PaperOverview["open"];
  names: Map<string, string | null>;
}) {
  return (
    <ul className="divide-y">
      {open.map((x) => {
        const value = x.shares * (x.currentPrice ?? x.avgPrice);
        const pnl = value - x.costBasis;
        return (
          <li key={x.id}>
            <Link
              href={`/paper/positions/${x.id}`}
              className="hover:bg-muted/50 -mx-2 grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1 rounded-md px-2 py-2.5 md:grid-cols-[auto_minmax(0,1fr)_9rem_8rem_7rem_9rem_auto]"
            >
              <MarketThumb src={x.image} size={32} label={x.title} />
              <span className="min-w-0">
                <span className="line-clamp-2 text-sm font-medium md:line-clamp-1">{x.title}</span>
                <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                  <span>{x.outcome}</span>
                  {x.kind === "hedge" ? (
                    <span className="text-primary inline-flex items-center gap-0.5 font-medium">
                      <Shield className="size-3" aria-hidden /> hedge
                    </span>
                  ) : (
                    <span>
                      from {traderName({ name: names.get(x.sourceWallet), wallet: x.sourceWallet })}
                    </span>
                  )}
                </span>
              </span>
              <span className="text-muted-foreground hidden text-right text-sm tabular-nums md:block">
                {num(x.shares, 1)} sh
              </span>
              <span className="text-muted-foreground hidden text-right text-sm tabular-nums md:block">
                {cents(x.avgPrice)} → {cents(x.currentPrice)}
              </span>
              <span className="hidden text-right text-sm tabular-nums md:block">{usd(value)}</span>
              <span className="text-right text-sm">
                <Signed value={pnl}>{usd(pnl, { sign: true })}</Signed>
                <span className="text-muted-foreground block text-xs tabular-nums">
                  {x.costBasis > 0 ? pct(pnl / x.costBasis, 1, { sign: true }) : "—"}
                  <span className="md:hidden">
                    {" "}
                    · {cents(x.avgPrice)}→{cents(x.currentPrice)}
                  </span>
                </span>
              </span>
              <ChevronRight className="text-muted-foreground size-4" aria-hidden />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

const STATUS_LABEL: Record<string, string> = { open: "Open", closed: "Sold", settled: "Settled" };

function TraderResult({ t }: { t: PaperOverview["byTrader"][number] }) {
  return (
    <li className="rounded-lg border">
      <details className="group">
        <summary className="hover:bg-muted/40 flex cursor-pointer list-none items-center gap-3 rounded-lg p-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">
              {traderName({ name: t.name, wallet: t.wallet })}
            </span>
            <span className="text-muted-foreground text-xs">
              {t.wins}W · {t.losses}L · {t.open} open · {usd(t.invested, { compact: true })} put in
            </span>
          </span>
          <span className="text-right">
            <span className="block text-lg font-semibold tabular-nums">
              <Signed value={t.total}>{usd(t.total, { sign: true })}</Signed>
            </span>
            <span className="text-muted-foreground block text-xs tabular-nums">
              {t.roi === null ? "—" : `${pct(t.roi, 1, { sign: true })} return`}
            </span>
          </span>
          <ChevronDown
            className="text-muted-foreground size-4 shrink-0 transition-transform group-open:rotate-180"
            aria-hidden
          />
        </summary>
        <div className="border-t px-3 pt-2 pb-3">
          <dl className="grid grid-cols-2 gap-2 py-1 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Locked in</dt>
              <dd className="font-medium">
                <Signed value={t.realized}>{usd(t.realized, { sign: true })}</Signed>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Still open</dt>
              <dd className="font-medium">
                <Signed value={t.unrealized}>{usd(t.unrealized, { sign: true })}</Signed>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Trader page</dt>
              <dd>
                <Link
                  href={`/traders/${t.wallet}`}
                  className="text-primary font-medium hover:underline"
                >
                  View profile →
                </Link>
              </dd>
            </div>
          </dl>
          <ul className="mt-2 divide-y text-sm">
            {t.positions.map((pos) => (
              <li key={pos.id}>
                <Link
                  href={`/paper/positions/${pos.id}`}
                  className="hover:bg-muted/50 -mx-2 flex items-center gap-2 rounded-md px-2 py-1.5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-1">{pos.title}</span>
                    <span className="text-muted-foreground text-xs">
                      {pos.outcome}
                      {pos.kind === "hedge" ? " · hedge" : ""} ·{" "}
                      {STATUS_LABEL[pos.status] ?? pos.status} · {usd(pos.invested)} in
                    </span>
                  </span>
                  <span className="text-right tabular-nums">
                    <Signed value={pos.pnl}>{usd(pos.pnl, { sign: true })}</Signed>
                  </span>
                  <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </details>
    </li>
  );
}
