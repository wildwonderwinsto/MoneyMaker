import Link from "next/link";
import { Suspense } from "react";

import { NavLinks, NavList } from "@/components/nav-links";
import { ThemeToggle } from "@/components/theme-toggle";

function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <path
        d="M8 22v-4M13 22v-8M18 22v-6M23 22V9"
        stroke="white"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SiteHeader() {
  return (
    <header className="bg-card/90 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 pt-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <Logo />
          <span className="text-lg">MoneyMaker</span>
        </Link>
        <span className="bg-yes/10 text-yes rounded-full px-2.5 py-0.5 text-xs font-semibold">
          Paper mode
        </span>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </div>
      <div className="mx-auto max-w-7xl px-2 sm:px-4">
        <Suspense fallback={<NavList />}>
          <NavLinks />
        </Suspense>
      </div>
    </header>
  );
}
