import "server-only";

import { createHmac } from "node:crypto";

import { cookies } from "next/headers";

import { safeEqual } from "@/lib/auth";
import { allowsOpenAccess, env } from "@/lib/env";

export const ADMIN_COOKIE = "mm_admin";

/** How long an unlock lasts (the cookie's lifetime, and enforced on the signed value). */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * Cookie value `<issued epoch s>.<HMAC of it, keyed by the password>`, so no session
 * storage is needed. The issue time is signed, so a copied cookie stops working after
 * MAX_AGE_SECONDS whatever its browser-side expiry says; changing ADMIN_PASSWORD revokes
 * every cookie at once.
 */
function token(password: string, issued: number): string {
  const mac = createHmac("sha256", password).update(`moneymaker-admin-v2.${issued}`);
  return `${issued}.${mac.digest("hex")}`;
}

function validToken(value: string, password: string): boolean {
  const issued = Number(value.split(".")[0]);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(issued) || issued > now + 60 || now - issued > MAX_AGE_SECONDS) {
    return false;
  }
  return safeEqual(value, token(password, issued));
}

/**
 * Whether the current request may change state. Without ADMIN_PASSWORD, local development
 * on PGlite is open; production or any real Postgres is locked (fail closed).
 */
export async function isAdmin(): Promise<boolean> {
  const { ADMIN_PASSWORD } = env();
  if (!ADMIN_PASSWORD) return allowsOpenAccess(env());
  const value = (await cookies()).get(ADMIN_COOKIE)?.value;
  return value !== undefined && validToken(value, ADMIN_PASSWORD);
}

export async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) throw new Error("Unlock the dashboard with the admin password first.");
}

export async function checkPasswordAndSetCookie(password: string): Promise<boolean> {
  const { ADMIN_PASSWORD, NODE_ENV } = env();
  if (!ADMIN_PASSWORD || !safeEqual(password, ADMIN_PASSWORD)) return false;
  (await cookies()).set(ADMIN_COOKIE, token(ADMIN_PASSWORD, Math.floor(Date.now() / 1000)), {
    httpOnly: true,
    secure: NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  return true;
}

export async function clearAdminCookie(): Promise<void> {
  (await cookies()).delete(ADMIN_COOKIE);
}
