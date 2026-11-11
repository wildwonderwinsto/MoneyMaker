"use client";

import { useSyncExternalStore } from "react";

const subscribeNever = () => () => {};

/**
 * A clock time in the viewer's own time zone. Pages are drawn on the server first (UTC on
 * Render), where the viewer's zone isn't known: printed there, a 9:15 AM trade read
 * "3:15 PM" with nothing to say it was UTC. So the server (and the matching first browser
 * render) prints the time in UTC and says so; the viewer's local time replaces it as soon
 * as the page is live.
 */
export function LocalTime({ ts, date = false }: { ts: string | number; date?: boolean }) {
  const hydrated = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
  const text = new Date(ts).toLocaleString("en-US", {
    ...(date && { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    ...(!hydrated && { timeZone: "UTC" }),
  });
  return <time dateTime={new Date(ts).toISOString()}>{hydrated ? text : `${text} UTC`}</time>;
}
