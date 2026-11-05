"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";

import { checkPasswordAndSetCookie, clearAdminCookie, requireAdmin } from "@/lib/admin";
import { ensureDefaultAccount, resetAccount } from "@/lib/copy/account";
import { RiskConfigSchema } from "@/lib/copy/config";
import { notifyEngine } from "@/lib/copy/runner";
import { executeHedge } from "@/lib/copy/tick";
import { getDb } from "@/lib/db/client";
import { cursors, follows, hiddenTraders } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { allowAttempt, clearAttempts } from "@/lib/rate-limit";
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
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
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
    const db = getDb();
    await db
      .insert(follows)
      .values({ wallet: w, enabled })
      .onConflictDoUpdate({ target: follows.wallet, set: { enabled } });
    // Re-following starts fresh from now instead of replaying missed trades.
    if (enabled) {
      await db.delete(cursors).where(eq(cursors.wallet, w));
      await db.delete(hiddenTraders).where(eq(hiddenTraders.wallet, w));
    }
    await notifyEngine();
    return enabled ? "Following — new trades will be paper-copied" : "Unfollowed";
  });
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

/** Say "no" to a trader: hide them from Top traders and stop copying them. */
export async function setHiddenAction(wallet: string, hidden: boolean): Promise<ActionResult> {
  return adminOnly(async () => {
    const w = Wallet.parse(wallet);
    const db = getDb();
    if (hidden) {
      await db.insert(hiddenTraders).values({ wallet: w }).onConflictDoNothing();
      await db.update(follows).set({ enabled: false }).where(eq(follows.wallet, w));
      await notifyEngine();
      return "Hidden from Top traders (and no longer copied)";
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
    await resetAccount(db, account.id, balance);
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
    const res = await executeHedge(db, account.id, id, m, cfg, {
      maxCost: Number.POSITIVE_INFINITY,
    });
    if (res.ok) refresh();
    return { ok: res.ok, message: res.message };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Something went wrong" };
  }
}
