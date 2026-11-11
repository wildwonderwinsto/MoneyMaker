"use client";

import { cn } from "cn";
import { useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

export interface FeedFilter {
  value: string;
  label: string;
}

export interface FeedItem {
  key: string;
  /** Matched against the filter value ("all" matches everything). */
  decision: string;
  section: string;
  node: ReactNode;
}

/** Set `?show=` without a server round trip (replaceState syncs with useSearchParams). */
function useSelectFilter() {
  const params = useSearchParams();
  return (value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value === "all") next.delete("show");
    else next.set("show", value);
    const q = next.toString();
    window.history.replaceState(null, "", q ? `?${q}` : window.location.pathname);
  };
}

/** A button elsewhere on the page (e.g. the 24-hour summary) that switches the feed's filter. */
export function FilterButton({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: ReactNode;
}) {
  const select = useSelectFilter();
  return (
    <button type="button" className={className} onClick={() => select(value)}>
      {children}
    </button>
  );
}

/**
 * The Live feed's filter tabs and list. Every card is rendered on the server once; switching
 * tabs only hides and shows them here and updates `?show=` in the URL (history.replaceState
 * syncs with the Next.js router), so it is instant instead of a server round trip.
 */
export function LiveFeed({
  filters,
  items,
  empty,
}: {
  filters: readonly FeedFilter[];
  items: FeedItem[];
  empty: ReactNode;
}) {
  const params = useSearchParams();
  const show = params.get("show");
  const filter = filters.some((f) => f.value === show) ? show! : "all";
  const visible = filter === "all" ? items : items.filter((i) => i.decision === filter);
  const count = (v: string) =>
    v === "all" ? items.length : items.filter((i) => i.decision === v).length;

  const select = useSelectFilter();

  const sections: Array<[string, FeedItem[]]> = [];
  for (const item of visible) {
    const last = sections.at(-1);
    if (last && last[0] === item.section) last[1].push(item);
    else sections.push([item.section, [item]]);
  }

  return (
    <>
      <div
        className="bg-muted flex w-full gap-1 rounded-lg p-1 sm:w-fit"
        role="tablist"
        aria-label="Show"
      >
        {filters.map((f) => (
          <button
            key={f.value}
            type="button"
            role="tab"
            aria-selected={f.value === filter}
            onClick={() => select(f.value)}
            className={cn(
              // Phones: the count sits under the label, so four tabs with counts up to 200
              // fit a 320px screen (side by side they spilled past it and forced a zoom-out).
              "flex min-w-0 flex-1 flex-col items-center rounded-md px-1.5 py-1 text-center text-sm font-medium transition-colors sm:flex-none sm:flex-row sm:px-3 sm:py-1.5",
              f.value === filter
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {f.label}
            <span className="text-muted-foreground text-xs tabular-nums sm:ml-1.5">
              {count(f.value)}
            </span>
          </button>
        ))}
      </div>

      {visible.length === 0
        ? empty
        : sections.map(([label, list]) => (
            <section key={label} className="space-y-3" aria-label={label}>
              <h2 className="text-muted-foreground px-1 pt-2 text-xs font-medium tracking-wide uppercase">
                {label} <span className="tabular-nums">· {list.length}</span>
              </h2>
              {list.map((i) => (
                <div key={i.key}>{i.node}</div>
              ))}
            </section>
          ))}
    </>
  );
}
