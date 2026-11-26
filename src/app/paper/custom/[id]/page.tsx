import { ArrowLeft, ExternalLink, Search, Ticket } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";

import { EquityChart } from "@/components/charts/equity-chart";
import { EmptyState, MarketThumb, PageHeader, Signed, StatTile } from "@/components/common";
import {
  BetTicket,
  PortfolioControls,
  RefreshPricesButton,
  SellBetButton,
} from "@/components/custom-bets";
import { UnlockForm } from "@/components/forms";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { isAdmin } from "@/lib/admin";
import { getPortfolioDetail, type CustomBet, type PortfolioDetail } from "@/lib/custom/bets";
import { searchMarkets, syncBets } from "@/lib/custom/polymarket";
import { getDb } from "@/lib/db/client";
import { cents, num, pct, polymarketMarketUrl, timeAgo, usd } from "@/lib/format";

export const metadata: Metadata = { title: "Personal bets" };

const toneOf = (x: number) => (x > 0 ? "gain" : x < 0 ? "loss" : undefined);

type Props = PageProps<"/paper/custom/[id]">;

export default function PersonalBetsPage({ params, searchParams }: Props) {
  return (
    <Suspense fallback={<Skeleton className="h-[600px] rounded-xl" />}>
      <PortfolioView params={params} searchParams={searchParams} />
    </Suspense>
  );
}

function betUrl(b: Pick<CustomBet, "eventSlug" | "slug">) {
  if (b.eventSlug && b.slug) return `https://polymarket.com/event/${b.eventSlug}/${b.slug}`;
  return b.slug ? polymarketMarketUrl(b.slug) : null;
}

async function PortfolioView({ params, searchParams }: Props) {
  await connection();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const portfolioId = Number(id);
  if (!Number.isInteger(portfolioId) || portfolioId <= 0) notFound();

  // Personal bets are private: visitors get the unlock form, never the bets.
  if (!(await isAdmin())) {
    return (
      <Card className="mx-auto max-w-md">
        <CardHeader>
          <CardTitle>Admin password needed</CardTitle>
          <CardDescription>Personal bets are only visible once unlocked.</CardDescription>
        </CardHeader>
        <CardContent>
          <UnlockForm />
        </CardContent>
      </Card>
    );
  }

  const db = getDb();
  await syncBets(db);
  const d = await getPortfolioDetail(db, portfolioId);
  if (!d) notFound();
  const q = typeof sp.q === "string" ? sp.q.slice(0, 200) : "";

  return (
    <div className="space-y-4 sm:space-y-6">
      <Link
        href="/paper#personal-bets"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" aria-hidden /> Paper trading
      </Link>
      <PageHeader
        title={d.portfolio.name}
        description="Your own paper bets on any Polymarket market, kept apart from the copy engine. Buys and sells fill against the live order book (slippage and taker fees included); bets settle at $1 or $0 when the market resolves."
        actions={<RefreshPricesButton />}
      />

      <div className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label="Equity"
          value={usd(d.equity)}
          hint={`Started with ${usd(d.portfolio.startingBalance)}`}
        />
        <StatTile
          label="Total return"
          value={pct(d.totalReturn, 2, { sign: true })}
          tone={toneOf(d.totalReturn)}
          hint={d.portfolio.resetAt ? `since reset ${timeAgo(d.portfolio.resetAt)}` : "all time"}
        />
        <StatTile label="Cash" value={usd(d.portfolio.cash)} hint={`${d.openCount} open bets`} />
        <StatTile
          label="Unrealized P&L"
          value={usd(d.unrealized, { sign: true })}
          tone={toneOf(d.unrealized)}
          hint={`Realized ${usd(d.realized, { sign: true })}`}
        />
        <StatTile
          label="Win rate"
          value={d.winRate === null ? "—" : pct(d.winRate, 0)}
          hint={`${d.finished.length} finished bets`}
        />
      </div>

      <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
        <CardHeader className="px-3 sm:px-6">
          <CardTitle className="flex items-center gap-2">
            <Search className="size-4" aria-hidden /> Place a bet
          </CardTitle>
          <CardDescription>
            Search Polymarket by keywords, or paste a polymarket.com link. Pick an outcome and an
            amount; the shown price is the latest midpoint, and the buy fills at the live asks.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-3 sm:px-6">
          <form className="flex gap-2" action={`/paper/custom/${portfolioId}`}>
            <Input
              name="q"
              defaultValue={q}
              placeholder="e.g. bitcoin, fed decision, or https://polymarket.com/event/…"
              aria-label="Search Polymarket"
            />
            <Button type="submit">Search</Button>
          </form>
          {q && (
            <Suspense key={q} fallback={<Skeleton className="h-40 rounded-lg" />}>
              <SearchResults q={q} portfolioId={portfolioId} cash={d.portfolio.cash} />
            </Suspense>
          )}
        </CardContent>
      </Card>

      <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
        <CardHeader className="px-3 sm:px-6">
          <CardTitle>Open bets</CardTitle>
          <CardDescription>
            Marked at the midpoint (selling now would usually get a bit less).
          </CardDescription>
        </CardHeader>
        <CardContent className="px-3 sm:px-6">
          {d.open.length === 0 ? (
            <EmptyState title="No open bets" icon={Ticket}>
              Search for a market above to place one.
            </EmptyState>
          ) : (
            <ul className="divide-y">
              {d.open.map((b) => (
                <OpenBet key={b.id} b={b} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {d.curve.length >= 1 && (
        <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
          <CardHeader className="px-3 sm:px-6">
            <CardTitle>Equity</CardTitle>
            <CardDescription>
              Cash + open bets at midpoint prices, recorded when you place, sell or view. B marks a
              buy, S a sale or settlement.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-3 sm:px-6">
            <EquityChart
              curve={[
                ...d.curve,
                { t: new Date().toISOString(), equity: Math.round(d.equity * 100) / 100 },
              ]}
              fills={d.fills.map((f) => ({
                id: f.id,
                ts: f.ts.toISOString(),
                side: f.side,
                kind: f.kind,
                notional: f.notional,
                shares: f.shares,
                avgPrice: f.avgPrice,
                realizedPnl: f.realizedPnl,
                title: f.title,
                outcome: f.outcome,
              }))}
              baseline={d.portfolio.startingBalance}
            />
          </CardContent>
        </Card>
      )}

      <FinishedBets d={d} />

      <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
        <CardHeader className="px-3 sm:px-6">
          <CardTitle>Portfolio</CardTitle>
          <CardDescription>Start this portfolio over, or delete it.</CardDescription>
        </CardHeader>
        <CardContent className="px-3 sm:px-6">
          <PortfolioControls
            id={d.portfolio.id}
            name={d.portfolio.name}
            balance={d.portfolio.startingBalance}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function OpenBet({ b }: { b: CustomBet }) {
  const value = b.shares * (b.currentPrice ?? b.avgPrice);
  const pnl = value - b.costBasis;
  const url = betUrl(b);
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1 py-2.5 md:grid-cols-[auto_minmax(0,1fr)_8rem_7rem_8rem_auto]">
      <MarketThumb src={b.image} size={32} label={b.title ?? ""} />
      <span className="min-w-0">
        <span className="line-clamp-2 text-sm font-medium md:line-clamp-1">
          {url ? (
            <a href={url} target="_blank" rel="noreferrer" className="hover:underline">
              {b.title} <ExternalLink className="inline size-3" aria-hidden />
            </a>
          ) : (
            b.title
          )}
        </span>
        <span className="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
          <span className="text-foreground font-medium">{b.outcome}</span>
          <span className="tabular-nums">{num(b.shares, 1)} sh</span>
          <span>{usd(b.costBasis)} in</span>
          {b.realizedPnl !== 0 && (
            <span>
              sold part: <Signed value={b.realizedPnl}>{usd(b.realizedPnl, { sign: true })}</Signed>
            </span>
          )}
          <span>{timeAgo(b.openedAt)}</span>
        </span>
      </span>
      <span className="text-muted-foreground hidden text-right text-sm tabular-nums md:block">
        {cents(b.avgPrice)} → {cents(b.currentPrice)}
      </span>
      <span className="hidden text-right text-sm tabular-nums md:block">{usd(value)}</span>
      <span className="text-right text-sm">
        <Signed value={pnl}>{usd(pnl, { sign: true })}</Signed>
        <span className="text-muted-foreground block text-xs tabular-nums">
          {b.costBasis > 0 ? pct(pnl / b.costBasis, 1, { sign: true }) : "—"}
          <span className="md:hidden">
            {" "}
            · {cents(b.avgPrice)}→{cents(b.currentPrice)}
          </span>
        </span>
      </span>
      <SellBetButton betId={b.id} label={`${num(b.shares, 1)} ${b.outcome} shares`} />
    </li>
  );
}

const ENDED: Record<string, string> = { closed: "Sold", settled: "Settled" };

function FinishedBets({ d }: { d: PortfolioDetail }) {
  if (d.finished.length === 0) return null;
  return (
    <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
      <CardHeader className="px-3 sm:px-6">
        <CardTitle>Finished bets</CardTitle>
        <CardDescription>Sold or settled, latest first.</CardDescription>
        <CardAction className="text-sm tabular-nums">
          <Signed value={d.realized}>{usd(d.realized, { sign: true })}</Signed>
        </CardAction>
      </CardHeader>
      <CardContent className="px-3 sm:px-6">
        <ul className="divide-y text-sm">
          {d.finished.map((b) => {
            const bought = d.fills
              .filter((f) => f.betId === b.id && f.side === "BUY")
              .reduce((a, f) => a + f.notional, 0);
            const won =
              b.status === "settled"
                ? b.currentPrice === 1
                  ? "won"
                  : b.currentPrice === 0
                    ? "lost"
                    : "50/50"
                : null;
            return (
              <li key={b.id} className="flex items-center gap-3 py-2">
                <MarketThumb src={b.image} size={24} label={b.title ?? ""} />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-1">
                    {b.title} <span className="text-muted-foreground">· {b.outcome}</span>
                  </span>
                  <span className="text-muted-foreground block text-xs">
                    {ENDED[b.status] ?? b.status}
                    {won && `: ${won}`} · {usd(bought)} in · {timeAgo(b.closedAt)}
                  </span>
                </span>
                <span className="text-right tabular-nums">
                  <Signed value={b.realizedPnl}>{usd(b.realizedPnl, { sign: true })}</Signed>
                  <span className="text-muted-foreground block text-xs">
                    {bought > 0 ? pct(b.realizedPnl / bought, 1, { sign: true }) : "—"}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

async function SearchResults({
  q,
  portfolioId,
  cash,
}: {
  q: string;
  portfolioId: number;
  cash: number;
}) {
  let events: Awaited<ReturnType<typeof searchMarkets>>;
  try {
    events = await searchMarkets(q);
  } catch {
    return <p className="text-loss text-sm">Couldn&apos;t reach Polymarket. Try again shortly.</p>;
  }
  if (events.length === 0) {
    return <p className="text-muted-foreground text-sm">No open markets match “{q}”.</p>;
  }
  return (
    <ul className="space-y-3">
      {events.map((e) => (
        <li key={e.id} className="rounded-lg border">
          <details className="group" open={events.length === 1}>
            <summary className="hover:bg-muted/40 flex cursor-pointer list-none items-center gap-3 rounded-lg p-3">
              <MarketThumb src={e.image} size={32} label={e.title} />
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 font-medium">{e.title}</span>
                <span className="text-muted-foreground text-xs">
                  {e.markets.length === 1
                    ? e.markets[0].outcomes
                        .map((o) => `${o.label} ${o.price === null ? "—" : cents(o.price)}`)
                        .join(" · ")
                    : `${e.markets.length} markets`}
                </span>
              </span>
            </summary>
            <ul className="divide-y border-t">
              {e.markets.map((m) => (
                <li key={m.conditionId} className="space-y-2 px-3 py-3">
                  <p className="text-sm">
                    {m.label ? (
                      <>
                        <span className="font-medium">{m.label}</span>{" "}
                        <span className="text-muted-foreground">· {m.question}</span>
                      </>
                    ) : (
                      <span className="font-medium">{m.question}</span>
                    )}
                    {m.endDate && (
                      <span className="text-muted-foreground text-xs">
                        {" "}
                        · ends{" "}
                        {new Date(m.endDate).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                          timeZone: "UTC",
                        })}
                      </span>
                    )}
                  </p>
                  <BetTicket
                    portfolioId={portfolioId}
                    conditionId={m.conditionId}
                    outcomes={m.outcomes.map(({ index, label, price }) => ({
                      index,
                      label,
                      price,
                    }))}
                    cash={cash}
                  />
                </li>
              ))}
            </ul>
          </details>
        </li>
      ))}
    </ul>
  );
}
