"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";

import { checkPasswordAndSetCookie, clearAdminCookie, requireAdmin } from "@/lib/admin";
import { ensureDefaultAccount, resetAccount } from "@/lib/copy/account";
import { RiskConfigSchema } from "@/lib/copy/config";
import { notifyEngine } from "@/lib/copy/runner";
import { executeHedge, exitTrader, withEngineLease, type ExitResult } from "@/lib/copy/tick";
import { getDb } from "@/lib/db/client";
import { cursors, follows, hiddenTraders } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { usd } from "@/lib/format";
import { allowAttempt, clearAttempts, limiterKey } from "@/lib/rate-limit";
import { ScoringConfigSchema } from "@/lib/scoring/config";
import { getRiskConfig, writeSetting } from "@/lib/settings";

export interface ActionResult {
  ok: boolean;
  message: string;
}

const Wallet = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^0x[0-9a-f]{40}$/, "Not a valid wallet address");

/**
 * Every state-changing action runs through here: admin check first (the UI hiding a
 * control is not a security boundary), then the change, then a UI refresh.
 */
async function adminOnly(fn: () => Promise<string>): Promise<ActionResult> {
  try {
    await requireAdmin();
    const message = await fn();
    refresh();
    return { ok: true, message };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Something went wrong" };
  }
}

async function clientIp(): Promise<string> {
  return limiterKey(await headers());
}

export async function unlockAction(_prev: ActionResult | null, form: FormData) {
  if (!env().ADMIN_PASSWORD) {
    return {
      ok: false,
      message: "Changes are locked: ADMIN_PASSWORD isn't set on the server.",
    } satisfies ActionResult;
  }
  const ip = await clientIp();
  if (!allowAttempt(`unlock:${ip}`)) {
    return {
      ok: false,
      message: "Too many wrong passwords. Try again in 15 minutes.",
    } satisfies ActionResult;
  }
  const ok = await checkPasswordAndSetCookie(String(form.get("password") ?? ""));
  if (ok) {
    clearAttempts(`unlock:${ip}`);
    refresh();
  }
  return { ok, message: ok ? "Unlocked" : "Wrong password" } satisfies ActionResult;
}

export async function lockAction() {
  await clearAdminCookie();
  refresh();
}

export async function setFollowAction(wallet: string, enabled: boolean): Promise<ActionResult> {
  return adminOnly(async () => {
    const w = Wallet.parse(wallet);
    // One transaction: the engine must never see the re-follow with the old cursor (it
    // would replay every trade made while unfollowed).
    await getDb().transaction(async (tx) => {
      if (enabled) {
        // Re-following starts fresh from now instead of replaying missed trades.
        await tx.delete(cursors).where(eq(cursors.wallet, w));
        await tx.delete(hiddenTraders).where(eq(hiddenTraders.wallet, w));
      }
      await tx
        .insert(follows)
        .values({ wallet: w, enabled })
        .onConflictDoUpdate({ target: follows.wallet, set: { enabled } });
    });
    await notifyEngine();
    return enabled
      ? "Following — new trades will be paper-copied"
      : "Unfollowed — no new copies. Open copies still close when this trader sells.";
  });
}

/** Drop a paused trader from the follow list. Open copies still close on their sells. */
export async function removeFollowAction(wallet: string): Promise<ActionResult> {
  return adminOnly(async () => {
    const w = Wallet.parse(wallet);
    const removed = await getDb()
      .delete(follows)
      .where(and(eq(follows.wallet, w), eq(follows.enabled, false)))
      .returning({ wallet: follows.wallet });
    if (removed.length === 0) throw new Error("Pause copying before removing a trader");
    await notifyEngine();
    return "Removed from your list";
  });
}

function hideMessage(r: ExitResult): string {
  if (r.skipped) {
    return "Hidden and unfollowed. The engine was busy, so open copies weren't sold; they'll close when this trader sells.";
  }
  const parts = ["Hidden and unfollowed"];
  if (r.sold > 0) {
    parts.push(
      `sold ${r.sold} open position${r.sold === 1 ? "" : "s"} for ${usd(r.proceeds)} (${usd(r.pnl, { sign: true })})`,
    );
  }
  if (r.left > 0) {
    parts.push(
      `${r.left} couldn't be sold now and will close when this trader sells or the market resolves`,
    );
  }
  return parts.join(" · ");
}

export async function setWeightAction(wallet: string, weight: number): Promise<ActionResult> {
  return adminOnly(async () => {
    const w = Wallet.parse(wallet);
    const value = z.number().min(0).max(5).parse(weight);
    await getDb().update(follows).set({ weight: value }).where(eq(follows.wallet, w));
    return `Weight set to ${value}×`;
  });
}

export async function addFollowAction(_prev: ActionResult | null, form: FormData) {
  return setFollowAction(String(form.get("wallet") ?? ""), true);
}

/**
 * Say "no" to a trader: hide them from Top traders, delete the follow, and sell whatever
 * was copied from them (and its hedges) right away.
 */
export async function setHiddenAction(wallet: string, hidden: boolean): Promise<ActionResult> {
  return adminOnly(async () => {
    const w = Wallet.parse(wallet);
    const db = getDb();
    if (hidden) {
      await db.transaction(async (tx) => {
        await tx.insert(hiddenTraders).values({ wallet: w }).onConflictDoNothing();
        await tx.delete(follows).where(eq(follows.wallet, w));
        await tx.delete(cursors).where(eq(cursors.wallet, w));
      });
      const exit = await exitTrader(db, w);
      await notifyEngine();
      return hideMessage(exit);
    }
    await db.delete(hiddenTraders).where(eq(hiddenTraders.wallet, w));
    return "Restored to Top traders";
  });
}

export async function resetPaperAction(_prev: ActionResult | null, form: FormData) {
  return adminOnly(async () => {
    const balance = z.coerce.number().min(10).max(10_000_000).parse(form.get("balance"));
    const db = getDb();
    const account = await ensureDefaultAccount(db);
    await withEngineLease(db, (locked) => resetAccount(locked, account.id, balance));
    return `Paper account reset to $${balance.toLocaleString()}`;
  });
}

/**
 * Save a settings group. Takes a plain object (not FormData): the client form keeps its
 * own state, so React's automatic form reset can never revert a field after saving.
 */
export async function saveSettingsAction(
  kind: "risk" | "scoring",
  values: unknown,
): Promise<ActionResult> {
  return adminOnly(async () => {
    const schema = kind === "risk" ? RiskConfigSchema : ScoringConfigSchema;
    const parsed = schema.safeParse(values);
    if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
    await writeSetting(getDb(), kind, parsed.data);
    if (kind === "risk") await notifyEngine();
    return kind === "risk"
      ? "Saved — the copy engine uses these from its next trade"
      : "Saved — applies from the next daily scoring run";
  });
}

/** Buy the other side of a copied position to limit its loss (paper). */
export async function hedgeAction(
  positionId: number,
  mode: "lock" | "breakeven",
): Promise<ActionResult> {
  try {
    await requireAdmin();
    const id = z.number().int().positive().parse(positionId);
    const m = z.enum(["lock", "breakeven"]).parse(mode);
    const db = getDb();
    const [account, cfg] = await Promise.all([ensureDefaultAccount(db), getRiskConfig(db)]);
    // A manual hedge may use any available cash; the admin sees the cost first.
    const res = await withEngineLease(db, (locked) =>
      executeHedge(locked, account.id, id, m, cfg, { maxCost: Number.POSITIVE_INFINITY }),
    );
    if (res.ok) refresh();
    return { ok: res.ok, message: res.message };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Something went wrong" };
  }
}
