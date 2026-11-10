import { cn } from "cn";
import { ExternalLink, Shield } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";

import { Avatar, MarketThumb, Signed, StatTile } from "@/components/common";
import { HedgeButton } from "@/components/hedge-buttons";
import { HoverExplain } from "@/components/hover-explain";
import { LockedAction } from "@/components/locked-action";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { isAdmin } from "@/lib/admin";
import { ensureDefaultAccount } from "@/lib/copy/account";
import type { HedgeQuote } from "@/lib/copy/hedge";
import { quoteHedge } from "@/lib/copy/tick";
import { getDb } from "@/lib/db/client";
import { explain } from "@/lib/explain";
import { cents, num, pct, polymarketMarketUrl, timeAgo, traderName, usd } from "@/lib/format";
import { chronological } from "@/lib/live";
import { getPosition, type PositionDetail } from "@/lib/queries";
import { getRiskConfig } from "@/lib/settings";

export const metadata: Metadata = { title: "Position" };

export default function PositionPage({ params }: PageProps<"/paper/positions/[id]">) {
  return (
    <Suspense fallback={<Skeleton className="h-[600px] rounded-xl" />}>
      <PositionDetailView params={params} />
    </Suspense>
  );
}

const STATUS: Record<string, { label: string; className: string }> = {
  open: { label: "Open", className: "bg-primary/10 text-primary" },
  closed: { label: "Sold", className: "bg-muted text-muted-foreground" },
  settled: { label: "Settled", className: "bg-muted text-muted-foreground" },
};

async function PositionDetailView({
  params,
}: {
  params: PageProps<"/paper/positions/[id]">["params"];
}) {
  await connection();
  const { id } = await params;
  const positionId = Number(id);
  if (!Number.isInteger(positionId) || positionId <= 0) notFound();
  const [data, admin] = await Promise.all([getPosition(positionId), isAdmin()]);
  if (!data) notFound();
  const { position: p, market, leader, hedge, hedgedPosition } = data;
  const value = p.shares * (p.currentPrice ?? p.avgPrice);
  const unrealized = p.status === "open" ? value - p.costBasis : 0;
  const total = p.realizedPnl + unrealized;
  const invested = data.fills.filter((f) => f.side === "BUY").reduce((a, f) => a + f.notional, 0);
  const url =
    market?.eventSlug && p.slug
      ? `https://polymarket.com/event/${market.eventSlug}/${p.slug}`
      : p.slug
        ? polymarketMarketUrl(p.slug)
        : null;
  const status = STATUS[p.status] ?? STATUS.open;

  return (
    <div className="space-y-4 sm:space-y-6">
      <Link href="/paper" className="text-muted-foreground hover:text-foreground text-sm">
        ← Paper trading
      </Link>

      <div className="flex items-start gap-3">
        <MarketThumb src={p.image} size={56} label={p.title} />
        <div className="min-w-0 flex-1">
          <h1 className="text-lg leading-snug font-semibold tracking-tight sm:text-2xl">
            {p.title}
          </h1>
          <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-2 text-sm">
            <span
              className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", status.className)}
            >
              {status.label}
            </span>
            <span className="text-foreground font-medium">{p.outcome}</span>
            {p.kind === "hedge" && (
              <span className="text-primary inline-flex items-center gap-1 text-xs font-semibold">
                <Shield className="size-3.5" aria-hidden /> Hedge
              </span>
            )}
            <span>opened {timeAgo(p.openedAt)}</span>
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="hover:text-foreground inline-flex items-center gap-1"
              >
                Polymarket <ExternalLink className="size-3" aria-hidden />
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-4">
        <StatTile
          label="Profit / loss"
          value={usd(total, { sign: true })}
          tone={total > 0 ? "gain" : total < 0 ? "loss" : undefined}
          hint={
            invested > 0
              ? `${pct(total / invested, 1, { sign: true })} on ${usd(invested)} put in`
              : undefined
          }
        />
        <StatTile
          label={p.status === "open" ? "Value now" : "Locked in"}
          value={p.status === "open" ? usd(value) : usd(p.realizedPnl, { sign: true })}
          hint={p.status === "open" ? `${num(p.shares, 1)} shares` : undefined}
        />
        <StatTile
          label="Paid → now"
          value={`${cents(p.avgPrice)} → ${cents(p.currentPrice)}`}
          hint="average price per share"
        />
        <StatTile
          label={p.kind === "hedge" ? "Protects" : "Copied from"}
          value={
            p.kind === "hedge" && hedgedPosition ? (
              <Link
                href={`/paper/positions/${hedgedPosition.id}`}
                className="text-base hover:underline"
              >
                {hedgedPosition.outcome} position →
              </Link>
            ) : (
              <Link
                href={`/traders/${p.sourceWallet}`}
                className="flex items-center gap-2 text-base hover:underline"
              >
                <Avatar wallet={p.sourceWallet} src={leader?.profileImage} size={22} />
                <span className="truncate">
                  {traderName({ name: leader?.name, wallet: p.sourceWallet })}
                </span>
              </Link>
            )
          }
        />
      </div>

      {p.status === "open" && p.kind === "copy" && (
        <Suspense fallback={<Skeleton className="h-64 rounded-xl" />}>
          <HedgePanel positionId={p.id} hedge={hedge} admin={admin} />
        </Suspense>
      )}

      <Timeline data={data} />
    </div>
  );
}

function Timeline({ data }: { data: PositionDetail }) {
  type Item = { ts: Date; key: string; kind: "trader" | "ours"; node: React.ReactNode };
  const items: Item[] = [
    ...data.fills.map((f) => ({
      ts: f.ts,
      key: `f${f.id}`,
      kind: "ours" as const,
      node: (
        <>
          <p className="font-medium">
            {f.kind === "settlement"
              ? f.side === "WIN"
                ? "Market settled: won"
                : f.side === "SPLIT"
                  ? "Market settled 50/50"
                  : "Market settled: lost"
              : f.side === "BUY"
                ? "We bought"
                : "We sold"}{" "}
            <span className="text-muted-foreground font-normal">
              {num(f.shares, 1)} @ {cents(f.avgPrice)} · {usd(f.notional)}
            </span>
          </p>
          {f.realizedPnl !== null && (
            <p className="text-xs">
              <Signed value={f.realizedPnl}>{usd(f.realizedPnl, { sign: true })}</Signed>
              <span className="text-muted-foreground"> locked in</span>
            </p>
          )}
          {f.slippageBps !== null && f.kind === "trade" && (
            <p className="text-muted-foreground text-xs">
              {f.slippageBps > 0
                ? `${num(f.slippageBps / 100, 1)}% worse`
                : `${num(-f.slippageBps / 100, 1)}% better`}{" "}
              than the trader&apos;s price
            </p>
          )}
        </>
      ),
    })),
    ...data.leaderTrades.map((s) => ({
      ts: s.leaderTs,
      key: `s${s.id}`,
      kind: "trader" as const,
      node: (
        <>
          <p>
            <span className="font-medium">Trader {s.side === "BUY" ? "bought" : "sold"}</span>{" "}
            <span className="text-muted-foreground">
              {num(s.leaderSize, 1)} @ {cents(s.leaderPrice)} · {usd(s.leaderUsdc)}
            </span>
          </p>
          <p className="text-muted-foreground text-xs">
            <HoverExplain
              explanation={explain({
                reason: s.reason,
                code: s.reasonCode,
                details: s.details,
                outcome: s.outcome,
                retries: s.retries,
              })}
            >
              {s.reason}
            </HoverExplain>
          </p>
        </>
      ),
    })),
  ];
  const story = chronological(items);
  const p = data.position;
  const value = p.shares * (p.currentPrice ?? p.avgPrice);

  return (
    <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
      <CardHeader className="px-4 sm:px-6">
        <CardTitle>What happened</CardTitle>
        <CardDescription>
          The trader&apos;s trades in this outcome and our copies of them, oldest first.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4 sm:px-6">
        {story.length === 0 ? (
          <p className="text-muted-foreground text-sm">No trades recorded.</p>
        ) : (
          <ol className="relative space-y-4 border-l pl-4">
            {story.map((it) => (
              <li key={it.key} className="relative text-sm">
                <span
                  className="bg-border absolute top-1.5 -left-[21px] size-2.5 rounded-full ring-4 ring-[var(--card)]"
                  aria-hidden
                />
                <p className="text-muted-foreground text-xs">
                  {it.ts.toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </p>
                {it.node}
              </li>
            ))}
            <li className="relative text-sm">
              <span
                className={cn(
                  "absolute top-1.5 -left-[21px] size-2.5 rounded-full ring-4 ring-[var(--card)]",
                  p.status === "open"
                    ? "bg-primary animate-pulse motion-reduce:animate-none"
                    : "bg-muted-foreground",
                )}
                aria-hidden
              />
              {p.status === "open" ? (
                <p>
                  <span className="font-medium">Still open</span>{" "}
                  <span className="text-muted-foreground">
                    {num(p.shares, 1)} shares, worth {usd(value)} at the midpoint (
                    <Signed value={value - p.costBasis}>
                      {usd(value - p.costBasis, { sign: true })}
                    </Signed>
                    )
                  </span>
                </p>
              ) : (
                <p>
                  <span className="font-medium">Closed</span>{" "}
                  <span className="text-muted-foreground">
                    {p.closedAt ? `${timeAgo(p.closedAt)} · ` : ""}result{" "}
                    <Signed value={p.realizedPnl}>{usd(p.realizedPnl, { sign: true })}</Signed>
                  </span>
                </p>
              )}
            </li>
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function Scenario({ label, value, base }: { label: string; value: number; base: number }) {
  const better = value - base;
  return (
    <div className="flex items-baseline justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right tabular-nums">
        <Signed value={value}>{usd(value, { sign: true })}</Signed>
        {Math.abs(better) > 0.005 && (
          <span className="text-muted-foreground ml-1 text-xs">
            ({better > 0 ? "+" : "−"}
            {usd(Math.abs(better))} vs. no hedge)
          </span>
        )}
      </span>
    </div>
  );
}

function QuoteCard({
  q,
  title,
  blurb,
  ours,
  other,
  positionId,
  admin,
}: {
  q: HedgeQuote;
  title: string;
  blurb: string;
  ours: string;
  other: string;
  positionId: number;
  admin: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3 sm:p-4">
      <div>
        <p className="font-semibold">{title}</p>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{blurb}</p>
      </div>
      {q.ok ? (
        <>
          <p className="text-sm">
            Buy <strong>{num(q.shares, 1)}</strong> {other} shares at about{" "}
            <strong>{cents(q.avgPrice)}</strong> for <strong>{usd(q.cost)}</strong>.
          </p>
          <div className="bg-muted/50 space-y-1 rounded-md p-2.5">
            <Scenario
              label={`If ${ours} wins`}
              value={q.pnlIfOursWins}
              base={q.unhedgedIfOursWins}
            />
            <Scenario
              label={`If ${other} wins`}
              value={q.pnlIfOppositeWins}
              base={q.unhedgedIfOppositeWins}
            />
          </div>
          <div className="mt-auto">
            {admin ? (
              <HedgeButton
                positionId={positionId}
                mode={q.mode}
                label={`${title} for ${usd(q.cost)}`}
                confirmText={`Buy ${num(q.shares, 1)} ${other} shares for about ${usd(q.cost)} (paper)? The final price comes from the order book at that moment.`}
              />
            ) : (
              <LockedAction label={`${title} for ${usd(q.cost)}`} className="w-full" />
            )}
          </div>
        </>
      ) : (
        <p className="text-muted-foreground text-sm">Not possible right now: {q.reason}.</p>
      )}
    </div>
  );
}

async function HedgePanel({
  positionId,
  hedge,
  admin,
}: {
  positionId: number;
  hedge: PositionDetail["hedge"];
  admin: boolean;
}) {
  if (hedge && hedge.status === "open") {
    return (
      <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
        <CardHeader className="px-4 sm:px-6">
          <CardTitle className="flex items-center gap-2">
            <Shield className="text-primary size-4" aria-hidden /> Hedged
          </CardTitle>
          <CardDescription>
            This position is protected by {num(hedge.shares, 1)} {hedge.outcome} shares bought for{" "}
            {usd(hedge.costBasis)}. If the trader sells, the hedge is sold in step.{" "}
            <Link href={`/paper/positions/${hedge.id}`} className="underline">
              View the hedge
            </Link>
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const db = getDb();
  const [account, cfg] = await Promise.all([ensureDefaultAccount(db), getRiskConfig(db)]);
  // The admin may use any available cash for a manual hedge; show what that costs.
  // Visitors only see cached prices: their page loads never call Polymarket (UI-17).
  const q = await quoteHedge(db, account.id, positionId, cfg, {
    maxCost: Number.POSITIVE_INFINITY,
    cachedOnly: !admin,
  }).catch(() => ({ ok: false, message: "Couldn't load the order book" }) as const);
  const ours = q.ok ? (q.position?.outcome ?? "your side") : "your side";
  const other = q.ok ? (q.opposite?.outcome ?? "the other side") : "the other side";
  return (
    <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
      <CardHeader className="px-4 sm:px-6">
        <CardTitle className="flex items-center gap-2">
          <Shield className="size-4" aria-hidden /> Cancel out a loss (hedge)
        </CardTitle>
        <CardDescription>
          In a Yes/No market exactly one side pays $1 a share. Buying the other side can lock in a
          result or make a flip cost nothing. Live prices from the order book; nothing is bought
          until you confirm.
          {cfg.autoHedge !== "off" &&
            ` Auto-hedge is on (${cfg.autoHedge === "lock" ? "lock in" : "break even"} when a copy is down ${pct(cfg.hedgeTriggerLossPct, 0)}).`}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4 sm:px-6">
        {!q.ok ? (
          <p className="text-muted-foreground text-sm">{q.message}</p>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              <QuoteCard
                q={q.lock!}
                title="Lock in"
                blurb="Buy as many of the other side as you hold. Both results become the same, so the loss can't grow (it also can't recover)."
                ours={ours}
                other={other}
                positionId={positionId}
                admin={admin}
              />
              <QuoteCard
                q={q.breakeven!}
                title="Break even if it flips"
                blurb="Buy enough of the other side that you lose nothing if the market goes against you. If your side still wins, you keep less."
                ours={ours}
                other={other}
                positionId={positionId}
                admin={admin}
              />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
