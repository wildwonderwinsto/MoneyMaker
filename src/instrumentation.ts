/**
 * Runs once when the Next.js server starts. Starts the copy engine's in-process loop
 * (sub-minute ticks + Polymarket's real-time trade feed) on the Node.js runtime.
 * Set ENGINE_LOOP=off to rely on /api/cron/tick alone.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.ENGINE_LOOP === "off") return;
  const { startEngine } = await import("./lib/copy/runner");
  startEngine();
}
