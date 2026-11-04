import { LineChart as LineChartIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { AutoRefresh } from "@/components/auto-refresh";
import { LineChart } from "@/components/charts/line-chart";
import { EmptyState, MarketThumb, PageHeader, Signed, StatTile } from "@/components/common";
import { ResetPaperForm } from "@/components/forms";
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
import { cents, num, pct, timeAgo, traderName, usd } from "@/lib/format";
import { getPaperOverview } from "@/lib/queries";

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
  const p = await getPaperOverview();
  const unrealized = p.open.reduce(
    (a, x) => a + x.shares * (x.currentPrice ?? x.avgPrice) - x.costBasis,
    0,
  );
  const realized = p.closed.reduce((a, x) => a + x.realizedPnl, 0);
  const curve = [
    ...p.equityCurve,
    { t: new Date().toISOString(), equity: Math.round(p.equity * 100) / 100 },
  ];

  return (
    <div className="space-y-6">
      <AutoRefresh seconds={30} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
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

      <Card>
        <CardHeader>
          <CardTitle>Equity</CardTitle>
          <CardDescription>
            Cash + open positions at market prices (snapshots every 15 min)
          </CardDescription>
        </CardHeader>
        <CardContent>
          {curve.length < 2 ? (
            <p className="text-muted-foreground text-sm">
              The curve appears after the first ticks.
            </p>
          ) : (
            <LineChart
              data={curve}
              series={[{ key: "equity", label: "Equity", color: "var(--series-1)" }]}
              baseline={p.account.startingBalance}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Open positions</CardTitle>
        </CardHeader>
        <CardContent>
          {p.open.length === 0 ? (
            <EmptyState title="No open positions" icon={LineChartIcon}>
              Follow traders on the{" "}
              <Link href="/" className="underline">
                Traders
              </Link>{" "}
              page. Their next qualifying trade will be copied here.
            </EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Market</TableHead>
                  <TableHead>Copied from</TableHead>
                  <TableHead className="text-right">Shares</TableHead>
                  <TableHead className="text-right">Avg → now</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead className="text-right">P&L</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.open.map((x) => {
                  const value = x.shares * (x.currentPrice ?? x.avgPrice);
                  const pnl = value - x.costBasis;
                  return (
                    <TableRow key={x.id}>
                      <TableCell>
                        <div className="flex max-w-[360px] items-center gap-2">
                          <MarketThumb src={x.image} size={28} />
                          <span className="truncate">
                            {x.title} <span className="text-muted-foreground">· {x.outcome}</span>
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Link href={`/traders/${x.sourceWallet}`} className="hover:underline">
                          {traderName({ wallet: x.sourceWallet })}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{num(x.shares, 1)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {cents(x.avgPrice)} → {cents(x.currentPrice)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{usd(value)}</TableCell>
                      <TableCell className="text-right">
                        <Signed value={pnl}>
                          {usd(pnl, { sign: true })} ({pct(pnl / x.costBasis, 1, { sign: true })})
                        </Signed>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Results by trader</CardTitle>
            <CardDescription>Which leaders are actually making you money</CardDescription>
          </CardHeader>
          <CardContent>
            {p.byTrader.length === 0 ? (
              <p className="text-muted-foreground text-sm">No copied trades yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Trader</TableHead>
                    <TableHead className="text-right">Positions</TableHead>
                    <TableHead className="text-right">Realized</TableHead>
                    <TableHead className="text-right">Open P&L</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {p.byTrader.map((t) => (
                    <TableRow key={t.wallet}>
                      <TableCell>
                        <Link href={`/traders/${t.wallet}`} className="hover:underline">
                          {traderName({ name: t.name, wallet: t.wallet })}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{t.trades}</TableCell>
                      <TableCell className="text-right">
                        <Signed value={t.realized}>{usd(t.realized, { sign: true })}</Signed>
                      </TableCell>
                      <TableCell className="text-right">
                        <Signed value={t.openValue - t.openCost}>
                          {usd(t.openValue - t.openCost, { sign: true })}
                        </Signed>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent fills</CardTitle>
            <CardDescription>Simulated against the live order book</CardDescription>
          </CardHeader>
          <CardContent>
            {p.fills.length === 0 ? (
              <p className="text-muted-foreground text-sm">No fills yet.</p>
            ) : (
              <ul className="divide-y text-sm">
                {p.fills.map(({ fill: f, title, outcome }) => (
                  <li key={f.id} className="flex items-center gap-3 py-2">
                    <span
                      className={
                        f.side === "BUY" || f.side === "WIN"
                          ? "text-yes w-12 text-xs font-semibold"
                          : "text-no w-12 text-xs font-semibold"
                      }
                    >
                      {f.side}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {title} <span className="text-muted-foreground">· {outcome}</span>
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {num(f.shares, 1)} @ {cents(f.avgPrice)}
                    </span>
                    <span className="w-20 text-right tabular-nums">{usd(f.notional)}</span>
                    <span className="text-muted-foreground w-16 text-right text-xs">
                      {timeAgo(f.ts)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>
            Start over with a fresh balance, for example after changing risk rules.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResetPaperForm current={p.account.startingBalance} />
        </CardContent>
      </Card>
    </div>
  );
}
