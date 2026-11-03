/**
 * Copy-engine heartbeat. cron-job.org calls this every minute with
 * `Authorization: Bearer <CRON_SECRET>`; the call also keeps the free Render instance awake.
 */
import { bearerToken, safeEqual } from "@/lib/auth";
import { runTick } from "@/lib/copy/tick";
import { getDb } from "@/lib/db/client";
import { env } from "@/lib/env";

async function handle(request: Request): Promise<Response> {
  const { CRON_SECRET, NODE_ENV } = env();
  if (!CRON_SECRET) {
    if (NODE_ENV === "production") {
      return Response.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
    }
  } else {
    const token = bearerToken(request.headers.get("authorization"));
    if (!token || !safeEqual(token, CRON_SECRET)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const stats = await runTick(getDb());
    return Response.json(stats, { status: stats.errors.length ? 207 : 200 });
  } catch (err) {
    console.error("tick failed", err);
    return Response.json({ error: "Tick failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
