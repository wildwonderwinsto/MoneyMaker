"use client";

import { cn } from "cn";
import { Activity, FlaskConical, LineChart, Settings, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Traders", short: "Traders", icon: Users },
  { href: "/live", label: "Live", short: "Live", icon: Activity },
  { href: "/paper", label: "Paper trading", short: "Paper", icon: LineChart },
  { href: "/backtest", label: "Backtest", short: "Backtest", icon: FlaskConical },
  { href: "/settings", label: "Settings", short: "Settings", icon: Settings },
] as const;

const activeFor = (pathname: string) => (href: string) =>
  href === "/" ? pathname === "/" || pathname.startsWith("/traders") : pathname.startsWith(href);

/**
 * Highlights the current section. usePathname() suspends on dynamic routes under Cache
 * Components, so render these inside <Suspense fallback={<NavList />}>.
 */
export function NavLinks() {
  return <NavList isActive={activeFor(usePathname())} />;
}

export function MobileNavLinks() {
  return <MobileNav isActive={activeFor(usePathname())} />;
}

/** Desktop tabs under the header (also the Suspense fallback). */
export function NavList({ isActive = () => false }: { isActive?: (href: string) => boolean }) {
  return (
    <nav aria-label="Main" className="-mb-px hidden gap-1 overflow-x-auto sm:flex">
      {LINKS.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          aria-current={isActive(href) ? "page" : undefined}
          className={cn(
            "flex items-center gap-2 border-b-2 px-3 py-3 text-sm font-medium whitespace-nowrap transition-colors",
            isActive(href)
              ? "border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground border-transparent",
          )}
        >
          <Icon className="size-4" aria-hidden />
          {label}
        </Link>
      ))}
    </nav>
  );
}

/** Bottom tab bar on phones: thumb-reachable, always visible. */
export function MobileNav({ isActive = () => false }: { isActive?: (href: string) => boolean }) {
  return (
    <nav
      aria-label="Main"
      className="bg-card/95 fixed inset-x-0 bottom-0 z-40 border-t pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
    >
      <ul className="grid grid-cols-5">
        {LINKS.map(({ href, short, icon: Icon }) => (
          <li key={href}>
            <Link
              href={href}
              aria-current={isActive(href) ? "page" : undefined}
              className={cn(
                "flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium transition-colors",
                isActive(href) ? "text-primary" : "text-muted-foreground",
              )}
            >
              <Icon className="size-5" aria-hidden />
              {short}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
