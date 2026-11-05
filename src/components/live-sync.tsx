"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Keeps the Live page in step with the copy engine: polls a tiny fingerprint endpoint and
 * re-renders the page the moment a new trade or engine check lands, instead of on a fixed
 * timer that drifts out of step. Pauses while the tab is hidden; falls back to a plain
 * refresh every `fallbackSeconds` if the endpoint is unreachable.
 */
export function LiveSync({
  pollSeconds = 3,
  fallbackSeconds = 30,
}: {
  pollSeconds?: number;
  fallbackSeconds?: number;
}) {
  const router = useRouter();
  const version = useRef<string | null>(null);
  const lastRefresh = useRef(0);

  useEffect(() => {
    let stopped = false;
    let busy = false;
    lastRefresh.current = Date.now();
    const refresh = () => {
      lastRefresh.current = Date.now();
      router.refresh();
    };
    const check = async () => {
      if (busy || stopped || document.visibilityState !== "visible") return;
      busy = true;
      try {
        const res = await fetch("/api/live/version", { cache: "no-store" });
        const { v } = (await res.json()) as { v: string | null };
        if (v === null) throw new Error("unavailable");
        if (version.current !== null && v !== version.current) refresh();
        version.current = v;
      } catch {
        if (Date.now() - lastRefresh.current > fallbackSeconds * 1000) refresh();
      } finally {
        busy = false;
      }
    };
    void check();
    const id = setInterval(check, pollSeconds * 1000);
    // Coming back to the tab: catch up immediately.
    const onVisible = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router, pollSeconds, fallbackSeconds]);

  return null;
}
