import Link from "next/link";

import { Sparkline } from "@/components/charts/sparkline";
import { Avatar, Signed, TierBadge } from "@/components/common";
import { FollowButton } from "@/components/follow-button";
import { HideButton } from "@/components/hide-button";
import { LockedAction } from "@/components/locked-action";
import { Card } from "@/components/ui/card";
import { pct, traderName, usd } from "@/lib/format";
import type { TraderListItem } from "@/lib/queries";

function cumulative(monthly: Array<{ pnl: number }> | undefined): number[] {
  let sum = 0;
  return (monthly ?? []).map((m) => (sum += m.pnl));
}

export function TraderCard({ t, admin }: { t: TraderListItem; admin: boolean }) {
  const metrics = t.metrics as {
    monthlyPnl?: Array<{ month: string; pnl: number }>;
    resolvedWinRate?: number | null;
    nCopyReplays?: number;
    copyReplayDays?: number | null;
  };
  const curve = cumulative(metrics.monthlyPnl);
  const name = traderName(t);
  const passed = t.checks.filter((c) => c.ok).length;

  return (
    <Card className="hover:border-primary/40 gap-0 py-0 transition-colors">
      <Link href={`/traders/${t.wallet}`} className="block p-4 pb-3">
        <div className="flex items-start gap-3">
          <Avatar wallet={t.wallet} src={t.profileImage} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{name}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <TierBadge tier={t.tier} />
              {t.primaryCategory && (
                <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs capitalize">
                  {t.primaryCategory}
                </span>
              )}
            </div>
          </div>
          <div className="text-right">
            <p className="text-3xl leading-none font-semibold tabular-nums">
              {Math.round(t.score)}
            </p>
            <p className="text-muted-foreground text-xs">score</p>
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div>
            <dt className="text-muted-foreground text-xs">Win rate vs. expected</dt>
            <dd className="font-medium tabular-nums">
              {pct(metrics.resolvedWinRate, 0)}{" "}
              <span className="text-muted-foreground font-normal">
                / {pct(t.expectedWinRate, 0)}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Return on risk</dt>
            <dd className="font-medium">
              <Signed value={t.roi}>{pct(t.roi, 1, { sign: true })}</Signed>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Profitable months</dt>
            <dd className="font-medium tabular-nums">{pct(t.profitableMonthsPct, 0)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Copied 2 min late (cautious)</dt>
            <dd className="font-medium">
              <Signed value={t.copyAdjRoi}>{pct(t.copyAdjRoi, 1, { sign: true })}</Signed>
              {typeof metrics.nCopyReplays === "number" && metrics.nCopyReplays > 0 && (
                <span className="text-muted-foreground text-xs font-normal">
                  {" "}
                  · {metrics.nCopyReplays} trades
                  {typeof metrics.copyReplayDays === "number" &&
                    `, ${Math.max(1, Math.round(metrics.copyReplayDays))} days`}
                </span>
              )}
            </dd>
          </div>
        </dl>

        <div className="mt-3 flex items-end justify-between gap-2">
          <div className="text-muted-foreground text-xs">
            <p>
              {usd(t.totalPnl, { compact: true, sign: true })} over {t.nResolved} markets
            </p>
            <p>
              Passed {passed}/{t.checks.length} checks
            </p>
          </div>
          <Sparkline values={curve} label={`Cumulative profit trend for ${name}`} />
        </div>
      </Link>
      <div className="flex items-center justify-between gap-2 border-t px-4 py-2.5">
        <Link
          href={`/traders/${t.wallet}`}
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          Why this score →
        </Link>
        {admin ? (
          <div className="flex items-center gap-1">
            <HideButton wallet={t.wallet} hidden={!!t.hidden} />
            {!t.hidden && <FollowButton wallet={t.wallet} following={!!t.following} />}
          </div>
        ) : t.following ? (
          <span className="bg-yes/10 text-yes rounded-full px-2.5 py-1 text-xs font-semibold">
            Following
          </span>
        ) : (
          <LockedAction label="Follow" />
        )}
      </div>
    </Card>
  );
}
