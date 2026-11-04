import { Lock, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { PageHeader, TierBadge } from "@/components/common";
import { AddFollowForm, UnlockForm } from "@/components/forms";
import {
  FollowRowControls,
  LockButton,
  SettingsForm,
  type FieldSpec,
} from "@/components/settings-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { isAdmin } from "@/lib/admin";
import { env } from "@/lib/env";
import { timeAgo, traderName } from "@/lib/format";
import { getFollowList, getJobRuns, getSettings } from "@/lib/queries";

export const metadata: Metadata = { title: "Settings" };

const RISK_FIELDS: FieldSpec[] = [
  {
    name: "sizingMode",
    label: "Sizing mode",
    kind: "select",
    options: ["proportional", "fixed"],
    help: "Proportional mirrors the leader's conviction; fixed always uses the same $ amount.",
  },
  { name: "fixedUsd", label: "Fixed size ($)", help: "Used in fixed mode." },
  { name: "proportionalMultiplier", label: "Proportional multiplier", step: 0.1 },
  {
    name: "minCopyUsd",
    label: "Minimum copy size ($)",
    help: "Floor for meaningful whale trades.",
  },
  { name: "minLeaderUsd", label: "Ignore leader trades under ($)" },
  { name: "maxPositionPct", label: "Max per market (fraction of equity)", step: 0.01 },
  { name: "maxTraderExposurePct", label: "Max per trader (fraction of equity)", step: 0.01 },
  {
    name: "maxDailyLossPct",
    label: "Daily loss limit (fraction)",
    step: 0.01,
    help: "No new positions after this loss today.",
  },
  { name: "maxEntryPrice", label: "Max entry price (0–1)", step: 0.01 },
  { name: "minEntryPrice", label: "Min entry price (0–1)", step: 0.01 },
  {
    name: "maxPriceDrift",
    label: "Max price move vs. leader (0–1)",
    step: 0.005,
    help: "0.03 = 3¢",
  },
  { name: "minMinutesToEnd", label: "Skip markets ending within (min)" },
  { name: "maxSignalAgeSeconds", label: "Ignore signals older than (s)" },
  { name: "takerFeeBps", label: "Taker fee (bps)" },
  { name: "copySells", label: "Mirror leader sells", kind: "boolean" },
];

const SCORING_FIELDS: FieldSpec[] = [
  { name: "minResolved", label: "Min resolved markets" },
  { name: "minEvents", label: "Min distinct events" },
  { name: "minZ", label: "Min skill z-score", step: 0.1 },
  { name: "fdrQ", label: "False discovery rate", step: 0.01 },
  { name: "minRoiShrunk", label: "Min return (adjusted)", step: 0.01 },
  { name: "maxTopMarketShare", label: "Max biggest-win share", step: 0.01 },
  { name: "maxTop3Share", label: "Max top-3 share", step: 0.01 },
  { name: "minMonths", label: "Min active months" },
  { name: "minProfitableMonthsPct", label: "Min profitable months", step: 0.05 },
  { name: "minRecoveryFactor", label: "Min recovery factor", step: 0.1 },
  { name: "copyDelaySeconds", label: "Copy delay to simulate (s)" },
  { name: "copySlippage", label: "Copy slippage (0–1)", step: 0.005 },
  { name: "maxTradesPerDay", label: "Max trades/day (bot filter)" },
  { name: "minMedianHoldHours", label: "Min median hold (hours)", step: 0.5 },
  { name: "oosDays", label: "Recent window (days)" },
  { name: "maxDaysSinceTrade", label: "Must have traded within (days)" },
  { name: "eliteScore", label: "Elite score threshold" },
  { name: "simulations", label: "Monte Carlo simulations" },
];

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Who to copy, how much to risk, and how strict the trader verification is."
      />
      <Suspense fallback={<Skeleton className="h-[600px] rounded-xl" />}>
        <SettingsContent />
      </Suspense>
    </>
  );
}

async function SettingsContent() {
  await connection();
  const [admin, settings, followList, runs] = await Promise.all([
    isAdmin(),
    getSettings(),
    getFollowList(),
    getJobRuns(8),
  ]);
  const passwordSet = Boolean(env().ADMIN_PASSWORD);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {admin ? <ShieldCheck className="text-yes size-4" /> : <Lock className="size-4" />}
            {admin ? "Unlocked" : "Locked"}
          </CardTitle>
          <CardDescription>
            {admin
              ? passwordSet
                ? "You can change settings and follow traders on this device."
                : "No ADMIN_PASSWORD is set, so changes are open (local development only)."
              : "Enter the admin password to follow traders or change settings."}
          </CardDescription>
        </CardHeader>
        <CardContent>{admin ? passwordSet && <LockButton /> : <UnlockForm />}</CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Following</CardTitle>
          <CardDescription>
            Weight scales copy size for that trader (1 = normal). The switch pauses copying.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {followList.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Not following anyone yet. Pick verified traders on the{" "}
              <Link href="/" className="underline">
                Traders
              </Link>{" "}
              page.
            </p>
          ) : (
            <ul className="divide-y">
              {followList.map(({ follow: f, name, tier }) => (
                <li key={f.wallet} className="flex flex-wrap items-center gap-3 py-2.5">
                  <Link href={`/traders/${f.wallet}`} className="font-medium hover:underline">
                    {traderName({ name, wallet: f.wallet })}
                  </Link>
                  {tier && <TierBadge tier={tier} />}
                  <span className="text-muted-foreground text-xs">
                    since {timeAgo(f.createdAt)}
                  </span>
                  <div className="ml-auto">
                    <FollowRowControls wallet={f.wallet} enabled={f.enabled} weight={f.weight} />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <AddFollowForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Risk & sizing</CardTitle>
          <CardDescription>Applied by the copy engine on its next tick.</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingsForm kind="risk" fields={RISK_FIELDS} values={settings.risk} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Trader verification rules</CardTitle>
          <CardDescription>Applied at the next daily scoring run.</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingsForm kind="scoring" fields={SCORING_FIELDS} values={settings.scoring} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Background jobs</CardTitle>
          <CardDescription>The daily pipeline runs on GitHub Actions.</CardDescription>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="text-muted-foreground text-sm">No runs yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {runs.map((r) => (
                <li key={r.id} className="flex items-center gap-3 py-2">
                  <span
                    className={
                      r.status === "ok"
                        ? "text-yes w-16 font-medium"
                        : r.status === "error"
                          ? "text-no w-16 font-medium"
                          : "text-muted-foreground w-16"
                    }
                  >
                    {r.status}
                  </span>
                  <span className="w-24 font-medium">{r.job}</span>
                  <span className="text-muted-foreground flex-1 truncate">
                    {r.error ? r.error.split("\n")[0] : ""}
                  </span>
                  <span className="text-muted-foreground text-xs">{timeAgo(r.startedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
