"use client";

import { cn } from "cn";
import { useSyncExternalStore } from "react";

/** One shared 1-second clock for every countdown on the page. */
let clockNow = Date.now();
const listeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;
function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!clockTimer) {
    clockNow = Date.now();
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      listeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}
const getNow = () => clockNow;
// Server render and hydration: no clock yet, so the markup always matches.
const getServerNow = () => null;

/**
 * Live countdown to the engine's next poll. The server passes when the last check finished
 * (`from`) and when the next starts (`at`); the bar fills over exactly that wait. The
 * interval runs start to start, so a check that takes 6 s leaves a ~9 s wait in a 15 s
 * interval; measuring against the full interval made the bar start half full. The page
 * refreshes when the check lands (LiveSync), which brings the next pair of times.
 */
export function NextTick({
  at,
  from,
  intervalSeconds,
}: {
  at: string | null;
  from: string | null;
  intervalSeconds: number;
}) {
  const now = useSyncExternalStore(subscribe, getNow, getServerNow);

  if (!at) return <span>every {intervalSeconds}s (via cron)</span>;
  const target = Date.parse(at);
  if (now === null) return <span className="tabular-nums">soon</span>;
  const start = from ? Date.parse(from) : target - intervalSeconds * 1000;
  // Guard against clock skew between this device and the server.
  const wait = Math.max(1000, Math.min(target - start, intervalSeconds * 1000));
  const leftMs = target - now;
  const left = Math.ceil(leftMs / 1000);
  const overdue = left <= 0;
  const pct = overdue ? 100 : Math.min(100, Math.max(0, 100 - (leftMs / wait) * 100));
  return (
    <span className="inline-flex items-center gap-2">
      <span className="w-28 whitespace-nowrap tabular-nums">
        {overdue ? "checking now…" : `in ${left}s`}
      </span>
      <span
        className="bg-muted relative inline-block h-1.5 w-20 overflow-hidden rounded-full"
        role="progressbar"
        aria-label="Time until next check"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        {/* Keyed per cycle: a new cycle starts a fresh bar instead of sliding backwards. */}
        <span
          key={at}
          className={cn(
            "bg-primary absolute inset-y-0 left-0 rounded-full",
            overdue ? "animate-pulse" : "transition-[width] duration-1000 ease-linear",
          )}
          style={{ width: `${pct}%` }}
        />
      </span>
    </span>
  );
}
