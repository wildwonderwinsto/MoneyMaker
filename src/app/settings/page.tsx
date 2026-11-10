import { Lock, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { Avatar, PageHeader, TierBadge } from "@/components/common";
import { AddFollowForm, UnlockForm } from "@/components/forms";
import { FollowRowControls, LockButton } from "@/components/settings-forms";
import { SettingsEditor } from "@/components/settings/settings-editor";
import { StorageCard } from "@/components/storage-card";
import { LockedAction } from "@/components/locked-action";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { isAdmin } from "@/lib/admin";
import { ensureDefaultAccount, loadAccountState } from "@/lib/copy/account";
import { getDb } from "@/lib/db/client";
import { env } from "@/lib/env";
import { timeAgo, traderName } from "@/lib/format";
import { getFollowList, getSettings, getSettingsDiagnostics } from "@/lib/queries";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Who to copy, how fast, how much to risk, and how strict trader verification is. Every setting explains what it does."
      />
      <Suspense fallback={<Skeleton className="h-[600px] rounded-xl" />}>
        <SettingsContent />
      </Suspense>
    </>
  );
}

async function SettingsContent() {
  await connection();
  const db = getDb();
  const admin = await isAdmin();
  const [settings, followList, { runs, storage }, account] = await Promise.all([
    getSettings(),
    getFollowList(),
    getSettingsDiagnostics(admin),
    ensureDefaultAccount(db),
  ]);
  const { equity } = await loadAccountState(db, account.id);
  const passwordSet = Boolean(env().ADMIN_PASSWORD);

  return (
    <div className="space-y-4 sm:space-y-6">
      <Card id="access" className="scroll-mt-24 gap-4 py-4 sm:gap-6 sm:py-6">
        <CardHeader className="px-4 sm:px-6">
          <CardTitle className="flex items-center gap-2">
            {/* Keyed by state: the icon pops in again each time it locks or unlocks. */}
            <span
              key={admin ? "open" : "locked"}
              className="animate-in zoom-in-50 spin-in-12 fade-in inline-flex duration-500 motion-reduce:animate-none"
            >
              {admin ? <ShieldCheck className="text-yes size-4" /> : <Lock className="size-4" />}
            </span>
            {admin ? "Unlocked" : "View only"}
          </CardTitle>
          <CardDescription>
            {admin
              ? passwordSet
                ? "You can change settings, follow or hide traders, hedge and reset on this device."
                : "No ADMIN_PASSWORD is set, so changes are open (local development only)."
              : passwordSet
                ? "Visitors can look but not change anything. Enter the admin password to make changes."
                : "Changes are locked because ADMIN_PASSWORD is not set on the server."}
          </CardDescription>
          {admin && passwordSet && (
            <CardAction className="self-center">
              <LockButton />
            </CardAction>
          )}
        </CardHeader>
        {!admin && (
          <CardContent className="px-4 sm:px-6">
            {passwordSet ? (
              <UnlockForm />
            ) : (
              <p className="text-muted-foreground text-sm">
                In Render, open the service → Environment, add <code>ADMIN_PASSWORD</code> (at least
                8 characters) and save. After the redeploy, come back here and enter it to unlock.
              </p>
            )}
          </CardContent>
        )}
      </Card>

      <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
        <CardHeader className="px-4 sm:px-6">
          <CardTitle>Following</CardTitle>
          <CardDescription>
            {admin
              ? "Weight scales the copy size for that trader (1 = normal, 2 = double, 0.5 = half). The switch pauses new copies; open ones still close when that trader sells."
              : "Traders being copied."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-4 sm:px-6">
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
                <li key={f.wallet} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                  <Avatar wallet={f.wallet} size={28} />
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/traders/${f.wallet}`}
                      className="block truncate font-medium hover:underline"
                    >
                      {traderName({ name, wallet: f.wallet })}
                    </Link>
                    <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                      {tier && <TierBadge tier={tier} />}
                      since {timeAgo(f.createdAt)}
                    </p>
                  </div>
                  {admin ? (
                    <FollowRowControls wallet={f.wallet} enabled={f.enabled} weight={f.weight} />
                  ) : (
                    <span className="text-muted-foreground text-sm tabular-nums">
                      {f.enabled ? "Copying" : "Paused"} · {f.weight}×
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {admin ? <AddFollowForm /> : <LockedAction label="Add or change traders" />}
        </CardContent>
      </Card>

      <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
        <CardHeader className="px-4 sm:px-6">
          <CardTitle>Copy engine: speed, sizing &amp; risk</CardTitle>
          <CardDescription>
            Saved changes apply from the engine&apos;s very next trade. Examples use your current
            paper equity.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-3 sm:px-6">
          <SettingsEditor kind="risk" values={settings.risk} admin={admin} ctx={{ equity }} />
        </CardContent>
      </Card>

      <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
        <CardHeader className="px-4 sm:px-6">
          <CardTitle>Trader verification rules</CardTitle>
          <CardDescription>
            What a trader must pass to be Verified. Applied at the next daily scoring run.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-3 sm:px-6">
          <SettingsEditor kind="scoring" values={settings.scoring} admin={admin} ctx={{ equity }} />
        </CardContent>
      </Card>

      {storage && <StorageCard stats={storage} />}

      <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
        <CardHeader className="px-4 sm:px-6">
          <CardTitle>Background jobs</CardTitle>
          <CardDescription>The daily pipeline runs on GitHub Actions.</CardDescription>
        </CardHeader>
        <CardContent className="px-4 sm:px-6">
          {runs.length === 0 ? (
            <p className="text-muted-foreground text-sm">No runs yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {runs.map((r) => (
                <li key={r.id} className="flex items-center gap-3 py-2">
                  <span
                    className={
                      r.status === "ok"
                        ? "text-yes w-14 shrink-0 font-medium"
                        : r.status === "error"
                          ? "text-no w-14 shrink-0 font-medium"
                          : "text-muted-foreground w-14 shrink-0"
                    }
                  >
                    {r.status}
                  </span>
                  <span className="w-20 shrink-0 font-medium">{r.job}</span>
                  <span className="text-muted-foreground min-w-0 flex-1 truncate">
                    {"error" in r && r.error ? r.error.split("\n")[0] : ""}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {timeAgo(r.startedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
