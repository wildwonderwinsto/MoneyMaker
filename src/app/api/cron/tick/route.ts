/**
 * Copy-engine heartbeat. cron-job.org POSTs here every minute with
 * `Authorization: Bearer <CRON_SECRET>`; the call also keeps the free Render instance awake.
 * POST only: it changes state, so a GET (link, prefetch, crawler) must never run a tick.
 *
 * When the in-process loop is running (see src/instrumentation.ts) it already ticks every
 * 15–60 s, so this only runs a tick itself if the loop looks stalled. Without the loop
 * (ENGINE_LOOP=off) every call runs a tick, as before.
 */
import { bearerToken, safeEqual } from "@/lib/auth";
import { getRunner } from "@/lib/copy/runner";
import { runTick } from "@/lib/copy/tick";
import { getDb } from "@/lib/db/client";
import { allowsOpenAccess, env } from "@/lib/env";

async function handle(request: Request): Promise<Response> {
  const { CRON_SECRET } = env();
  if (!CRON_SECRET) {
    if (!allowsOpenAccess(env())) {
      return Response.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
    }
  } else {
    const token = bearerToken(request.headers.get("authorization"));
    if (!token || !safeEqual(token, CRON_SECRET)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const runner = getRunner();
    if (runner.isRunning) {
      const last = runner.lastTickStartedAt;
      const stalled = last === null || Date.now() - last > runner.intervalSeconds * 2_000 + 30_000;
      if (!stalled) {
        return Response.json({
          loop: true,
          intervalSeconds: runner.intervalSeconds,
          last: runner.lastStats,
          stream: runner.streamStatus,
        });
      }
      const stats = await runner.tick();
      await runner.publishStatus().catch(() => undefined);
      return Response.json(
        { loop: true, recovered: true, ...stats },
        { status: stats.errors.length ? 207 : 200 },
      );
    }
    const stats = await runTick(getDb());
    return Response.json(stats, { status: stats.errors.length ? 207 : 200 });
  } catch (err) {
    console.error("tick failed", err);
    return Response.json({ error: "Tick failed" }, { status: 500 });
  }
}

export const POST = handle;
