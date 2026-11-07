/**
 * Runs once when the Next.js server starts. Starts the copy engine's in-process loop
 * (sub-minute ticks + Polymarket's real-time trade feed) on the Node.js runtime.
 * Set ENGINE_LOOP=off to rely on /api/cron/tick alone.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  // Refuse to serve a real database with the dashboard unlocked (e.g. a production URL in a
  // local .env); admin actions would also fail closed, but stop here so it's obvious.
  const { allowsOpenAccess, env } = await import("./lib/env");
  if (!env().ADMIN_PASSWORD && !allowsOpenAccess(env())) {
    throw new Error(
      "Refusing to start: DATABASE_URL is not PGlite and ADMIN_PASSWORD is not set. " +
        "Set ADMIN_PASSWORD, or use DATABASE_URL=pglite:./.data/pglite for local development.",
    );
  }
  if (process.env.ENGINE_LOOP === "off") return;
  const { startEngine } = await import("./lib/copy/runner");
  startEngine();
}
