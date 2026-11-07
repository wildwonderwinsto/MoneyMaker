import "server-only";

import { createHmac } from "node:crypto";

import { cookies } from "next/headers";

import { safeEqual } from "@/lib/auth";
import { allowsOpenAccess, env } from "@/lib/env";

export const ADMIN_COOKIE = "mm_admin";

/** Cookie value derived from the password, so no session storage is needed. */
function token(password: string): string {
  return createHmac("sha256", password).update("moneymaker-admin-v1").digest("hex");
}

/**
 * Whether the current request may change state. Without ADMIN_PASSWORD, local development
 * on PGlite is open; production or any real Postgres is locked (fail closed).
 */
export async function isAdmin(): Promise<boolean> {
  const { ADMIN_PASSWORD } = env();
  if (!ADMIN_PASSWORD) return allowsOpenAccess(env());
  const value = (await cookies()).get(ADMIN_COOKIE)?.value;
  return value !== undefined && safeEqual(value, token(ADMIN_PASSWORD));
}

export async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) throw new Error("Unlock the dashboard with the admin password first.");
}

export async function checkPasswordAndSetCookie(password: string): Promise<boolean> {
  const { ADMIN_PASSWORD, NODE_ENV } = env();
  if (!ADMIN_PASSWORD || !safeEqual(password, ADMIN_PASSWORD)) return false;
  (await cookies()).set(ADMIN_COOKIE, token(ADMIN_PASSWORD), {
    httpOnly: true,
    secure: NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return true;
}

export async function clearAdminCookie(): Promise<void> {
  (await cookies()).delete(ADMIN_COOKIE);
}
