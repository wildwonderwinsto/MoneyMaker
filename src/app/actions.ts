"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { z } from "zod";

import { checkPasswordAndSetCookie, clearAdminCookie, requireAdmin } from "@/lib/admin";
import { ensureDefaultAccount, resetAccount } from "@/lib/copy/account";
import { RiskConfigSchema } from "@/lib/copy/config";
import { getDb } from "@/lib/db/client";
import { cursors, follows } from "@/lib/db/schema";
import { ScoringConfigSchema } from "@/lib/scoring/config";
import { writeSetting } from "@/lib/settings";

export interface ActionResult {
  ok: boolean;
  message: string;
}

const Wallet = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^0x[0-9a-f]{40}$/, "Not a valid wallet address");

async function guarded(fn: () => Promise<string>): Promise<ActionResult> {
  try {
    const message = await fn();
    refresh();
    return { ok: true, message };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Something went wrong" };
  }
}

export async function unlockAction(_prev: ActionResult | null, form: FormData) {
  const ok = await checkPasswordAndSetCookie(String(form.get("password") ?? ""));
  if (ok) refresh();
  return { ok, message: ok ? "Unlocked" : "Wrong password" } satisfies ActionResult;
}

export async function lockAction() {
  await clearAdminCookie();
  refresh();
}

export async function setFollowAction(wallet: string, enabled: boolean): Promise<ActionResult> {
  return guarded(async () => {
    await requireAdmin();
    const w = Wallet.parse(wallet);
    const db = getDb();
    await db
      .insert(follows)
      .values({ wallet: w, enabled })
      .onConflictDoUpdate({ target: follows.wallet, set: { enabled } });
    // Re-following starts fresh from now instead of replaying missed trades.
    if (enabled) await db.delete(cursors).where(eq(cursors.wallet, w));
    return enabled ? "Following — new trades will be paper-copied" : "Unfollowed";
  });
}

export async function setWeightAction(wallet: string, weight: number): Promise<ActionResult> {
  return guarded(async () => {
    await requireAdmin();
    const w = Wallet.parse(wallet);
    const value = z.number().min(0).max(5).parse(weight);
    await getDb().update(follows).set({ weight: value }).where(eq(follows.wallet, w));
    return `Weight set to ${value}×`;
  });
}

export async function addFollowAction(_prev: ActionResult | null, form: FormData) {
  return setFollowAction(String(form.get("wallet") ?? ""), true);
}

export async function resetPaperAction(_prev: ActionResult | null, form: FormData) {
  return guarded(async () => {
    await requireAdmin();
    const balance = z.coerce.number().min(10).max(10_000_000).parse(form.get("balance"));
    const db = getDb();
    const account = await ensureDefaultAccount(db);
    await resetAccount(db, account.id, balance);
    return `Paper account reset to $${balance.toLocaleString()}`;
  });
}

/** Parse a settings form: numeric inputs → numbers, checkboxes → booleans. */
function formToObject(form: FormData, booleans: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith("$")) continue; // React action metadata
    const s = String(value);
    out[key] = s !== "" && !Number.isNaN(Number(s)) ? Number(s) : s;
  }
  for (const key of booleans) out[key] = form.get(key) === "on";
  return out;
}

export async function saveScoringAction(_prev: ActionResult | null, form: FormData) {
  return guarded(async () => {
    await requireAdmin();
    const parsed = ScoringConfigSchema.safeParse(formToObject(form, []));
    if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
    await writeSetting(getDb(), "scoring", parsed.data);
    return "Scoring rules saved — they apply from the next daily run";
  });
}

export async function saveRiskAction(_prev: ActionResult | null, form: FormData) {
  return guarded(async () => {
    await requireAdmin();
    const parsed = RiskConfigSchema.safeParse(formToObject(form, ["copySells"]));
    if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
    await writeSetting(getDb(), "risk", parsed.data);
    return "Risk rules saved — they apply from the next tick";
  });
}
