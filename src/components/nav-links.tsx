"use client";

import { cn } from "cn";
import { Activity, FlaskConical, LineChart, Settings, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Traders", icon: Users },
  { href: "/live", label: "Live", icon: Activity },
  { href: "/paper", label: "Paper trading", icon: LineChart },
  { href: "/backtest", label: "Backtest", icon: FlaskConical },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

/**
 * Highlights the current section. usePathname() suspends on dynamic routes under Cache
 * Components, so render this inside <Suspense fallback={<NavList />}>.
 */
export function NavLinks() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" || pathname.startsWith("/traders") : pathname.startsWith(href);
  return <NavList isActive={isActive} />;
}

/** The nav without an active highlight (also the Suspense fallback). */
export function NavList({ isActive = () => false }: { isActive?: (href: string) => boolean }) {
  return (
    <nav aria-label="Main" className="-mb-px flex gap-1 overflow-x-auto">
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
