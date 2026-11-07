/**
 * TEMPORARY (audit #11): shows the client-IP headers exactly as this app receives them on
 * Render, and the key the password limiter derives from them, so the right header can be
 * confirmed. Admin only. Remove once the limiter key is settled.
 */
import { connection } from "next/server";

import { isAdmin } from "@/lib/admin";
import { limiterKey } from "@/lib/rate-limit";

const HEADERS = ["x-forwarded-for", "x-real-ip", "true-client-ip", "cf-connecting-ip", "forwarded"];

export async function GET(request: Request) {
  await connection(); // per request, never prerendered
  if (!(await isAdmin())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const seen = Object.fromEntries(HEADERS.map((h) => [h, request.headers.get(h)]));
  return Response.json(
    { ...seen, limiterKey: limiterKey(request.headers) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
