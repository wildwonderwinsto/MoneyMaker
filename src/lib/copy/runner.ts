/**
 * In-process engine loop (started from src/instrumentation.ts on the Node server).
 *
 * - Runs a tick every 15, 30 or 60 seconds (Settings → Speed), finer than cron-job.org's
 *   1-minute minimum. cron-job.org keeps pinging /api/cron/tick: that keeps the free
 *   Render instance awake and runs a tick itself if this loop ever stalls.
 * - Listens to Polymarket's real-time feed and copies followed traders within seconds.
 * - Every piece of engine work goes through ONE queue, so nothing overlaps in-process;
 *   the database lease protects against other processes (e.g. `npm run job -- tick`).
 *   A tick's copy phase and housekeeping phase are queued separately, so a real-time
 *   trade never waits behind settlement or price marking.
 */
import type { Db } from "@/lib/db/client";
import { getDb } from "@/lib/db/client";
import { follows } from "@/lib/db/schema";
import { PROCESS_ID, releaseLease } from "@/lib/lease";
import { getRiskConfig } from "@/lib/settings";
import { eq } from "drizzle-orm";

import type { LeaderTrade } from "./engine";
import { writeEngineStatus } from "./status";
import { TradeStream } from "./stream";
import { LEASE, runStreamBatch, runTick, type TickStats } from "./tick";

type Log = (msg: string) => void;

export class EngineRunner {
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stream: TradeStream;
  private started = false;
  private streamEnabled = false;
  intervalSeconds = 30;
  nextTickAt: number | null = null;
  lastTickStartedAt: number | null = null;
  lastStats: TickStats | null = null;

  constructor(
    private readonly db: () => Db,
    private readonly log: Log = (m) => console.log(`[engine] ${m}`),
  ) {
    this.stream = new TradeStream({
      onTrades: (trades) => void this.onStreamTrades(trades),
      log: this.log,
    });
  }

  get isRunning() {
    return this.started;
  }

  get streamStatus() {
    return { ...this.stream.status, enabled: this.streamEnabled };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.log("loop started");
    this.releaseOnShutdown();
    void this.refresh().finally(() => this.schedule(0));
  }

  /**
   * Render sends SIGTERM on every deploy/restart. Release our lease at once so the next
   * instance can copy immediately instead of waiting for it to expire.
   */
  private releaseOnShutdown() {
    const onSignal = (signal: NodeJS.Signals) => {
      this.stop();
      void releaseLease(this.db(), LEASE, PROCESS_ID)
        .catch(() => undefined)
        .finally(() => {
          // Next.js normally owns shutdown; exit only if nobody else will.
          if (process.listenerCount(signal) === 0) process.exit(0);
        });
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  }

  stop() {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.stream.stop();
  }

  /** Serialize engine work. A failure never blocks later work. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private schedule(delayMs: number) {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextTickAt = Date.now() + delayMs;
    this.timer = setTimeout(() => void this.loopOnce(), delayMs);
    this.timer.unref?.();
  }

  private async loopOnce() {
    const startedAt = Date.now();
    try {
      await this.tick();
    } catch (err) {
      this.log(`tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Keep a steady cadence: the next tick is due `interval` after this one started.
    this.schedule(Math.max(1_000, startedAt + this.intervalSeconds * 1000 - Date.now()));
    await this.publishStatus().catch(() => undefined);
  }

  /** Run one full tick now (queued behind any work in progress). */
  async tick(): Promise<TickStats> {
    this.lastTickStartedAt = Date.now();
    const copy = await this.enqueue(() => runTick(this.db(), Date.now(), { housekeeping: false }));
    const house = await this.enqueue(() => runTick(this.db(), Date.now(), { copy: false }));
    await this.refresh().catch(() => undefined);
    const stats: TickStats = {
      ...copy,
      settled: house.settled,
      hedged: house.hedged,
      errors: [...copy.errors, ...house.errors],
      durationMs: copy.durationMs + house.durationMs,
      skipped: copy.skipped ?? house.skipped,
    };
    this.lastStats = stats;
    if (stats.errors.length) this.log(`tick errors: ${stats.errors.slice(0, 3).join(" | ")}`);
    return stats;
  }

  private async onStreamTrades(trades: LeaderTrade[]) {
    try {
      const stats = await this.enqueue(() => runStreamBatch(this.db(), trades));
      if (stats.copied || stats.closed) {
        this.log(
          `real-time: ${stats.copied} copied, ${stats.closed} closed in ${stats.durationMs}ms`,
        );
      }
      await writeEngineStatus(this.db(), { lastStreamBatchAt: new Date().toISOString() });
    } catch (err) {
      this.log(`real-time batch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Re-read settings and the follow list (call after either changes). */
  async refresh() {
    const db = this.db();
    const [cfg, leaders] = await Promise.all([
      getRiskConfig(db),
      db.select({ wallet: follows.wallet }).from(follows).where(eq(follows.enabled, true)),
    ]);
    this.stream.setFollowed(leaders.map((l) => l.wallet));
    const wantStream = cfg.realtime && leaders.length > 0;
    if (wantStream && !this.streamEnabled) this.stream.start();
    if (!wantStream && this.streamEnabled) this.stream.stop();
    this.streamEnabled = wantStream;

    if (cfg.tickIntervalSeconds !== this.intervalSeconds) {
      this.intervalSeconds = cfg.tickIntervalSeconds;
      // Pull the next tick in if the new interval is shorter.
      if (this.nextTickAt && this.lastTickStartedAt) {
        const due = this.lastTickStartedAt + this.intervalSeconds * 1000;
        if (due < this.nextTickAt) this.schedule(Math.max(1_000, due - Date.now()));
      }
    }
  }

  async publishStatus() {
    await writeEngineStatus(this.db(), {
      lastTickAt: new Date().toISOString(),
      lastTickMs: this.lastStats?.durationMs ?? null,
      nextTickAt: this.nextTickAt ? new Date(this.nextTickAt).toISOString() : null,
      intervalSeconds: this.intervalSeconds,
      loopAliveAt: new Date().toISOString(),
      stream: { ...this.stream.status, enabled: this.streamEnabled },
    });
  }
}

const globalForEngine = globalThis as unknown as { __mmEngine?: EngineRunner };

/** The process-wide runner (created on first use; started by instrumentation). */
export function getRunner(): EngineRunner {
  globalForEngine.__mmEngine ??= new EngineRunner(getDb);
  return globalForEngine.__mmEngine;
}

/** Start the loop once per process. */
export function startEngine() {
  getRunner().start();
}

/** Tell a running loop that follows or settings changed (no-op if no loop runs here). */
export async function notifyEngine() {
  const runner = globalForEngine.__mmEngine;
  if (runner?.isRunning) await runner.refresh().catch(() => undefined);
}
