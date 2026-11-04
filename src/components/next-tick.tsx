"use client";

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
 * Live countdown to the engine's next poll. The server passes the scheduled time; the
 * page auto-refreshes, which brings the next one. Shows "checking now" while overdue.
 */
export function NextTick({ at, intervalSeconds }: { at: string | null; intervalSeconds: number }) {
  const now = useSyncExternalStore(subscribe, getNow, getServerNow);

  if (!at) return <span>every {intervalSeconds}s (via cron)</span>;
  const target = Date.parse(at);
  if (now === null) return <span className="tabular-nums">soon</span>;
  const left = Math.ceil((target - now) / 1000);
  const pct = Math.min(100, Math.max(0, 100 - (left / intervalSeconds) * 100));
  return (
    <span className="inline-flex items-center gap-2">
      <span className="tabular-nums">{left > 0 ? `in ${left}s` : "checking now…"}</span>
      <span
        className="bg-muted relative inline-block h-1.5 w-16 overflow-hidden rounded-full"
        role="progressbar"
        aria-label="Time until next check"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span
          className="bg-primary absolute inset-y-0 left-0 rounded-full transition-[width] duration-1000 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </span>
    </span>
  );
}
