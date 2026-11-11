"use client";

import { cn } from "cn";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createContext,
  use,
  useState,
  useTransition,
  type ComponentProps,
  type ReactNode,
} from "react";

/**
 * Instant feedback for filters that need the server (e.g. the Traders tier/category tabs).
 * Navigating inside a transition keeps the current page on screen; meanwhile the clicked tab
 * shows as selected right away and PendingArea dims the results, so a click never looks
 * ignored while the server renders the new list.
 */
const Ctx = createContext<{
  pending: boolean;
  /** The tab being loaded, and which row of tabs it belongs to. */
  target: { group: string; href: string } | null;
  go: (group: string, href: string) => void;
}>({ pending: false, target: null, go: () => {} });

export function PendingNavProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [target, setTarget] = useState<{ group: string; href: string } | null>(null);
  const go = (group: string, href: string) => {
    setTarget({ group, href });
    start(() => router.push(href, { scroll: false }));
  };
  return <Ctx value={{ pending, target: pending ? target : null, go }}>{children}</Ctx>;
}

/** For controls other than tabs (e.g. a dropdown) that navigate the same way. */
export function usePendingNav() {
  return use(Ctx);
}

/**
 * A filter tab. Still a real link (open in new tab, etc.); plain clicks go through `go`.
 * Other anchor props (e.g. from a tooltip trigger wrapping it) pass through to the link.
 */
export function NavTab({
  group,
  href,
  selected,
  className,
  activeClassName,
  inactiveClassName,
  children,
  onClick,
  ...rest
}: Omit<ComponentProps<"a">, "href" | "className" | "children"> & {
  /** Tabs in the same row share a group; only that row follows a pending click. */
  group: string;
  href: string;
  selected: boolean;
  className?: string;
  activeClassName: string;
  inactiveClassName: string;
  children: ReactNode;
}) {
  const { target, go } = use(Ctx);
  // While a navigation is in flight, the tab being loaded is the selected one in its row.
  const active = target?.group === group ? target.href === href : selected;
  return (
    <Link
      {...rest}
      href={href}
      role="tab"
      aria-selected={active}
      scroll={false}
      onClick={(e) => {
        onClick?.(e);
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        if (!active) go(group, href);
      }}
      className={cn(className, active ? activeClassName : inactiveClassName)}
    >
      {children}
    </Link>
  );
}

/** Dims its content while a filter change is loading. */
export function PendingArea({ children }: { children: ReactNode }) {
  const { pending } = use(Ctx);
  return (
    <div
      aria-busy={pending}
      className={cn("transition-opacity duration-150", pending && "pointer-events-none opacity-50")}
    >
      {children}
    </div>
  );
}
