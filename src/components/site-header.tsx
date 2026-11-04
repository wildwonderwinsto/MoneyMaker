import { Eye, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { MobileNav, MobileNavLinks, NavLinks, NavList } from "@/components/nav-links";
import { ThemeToggle } from "@/components/theme-toggle";
import { isAdmin } from "@/lib/admin";

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

/** Who is looking: the admin (can change things) or a visitor (view only). */
async function AccessChip() {
  await connection();
  const admin = await isAdmin();
  return (
    <Link
      href="/settings#access"
      className={
        admin
          ? "bg-yes/10 text-yes inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold"
          : "bg-muted text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold"
      }
      title={
        admin ? "Admin: you can change settings" : "View only: unlock in Settings to make changes"
      }
    >
      {admin ? (
        <ShieldCheck className="size-3.5" aria-hidden />
      ) : (
        <Eye className="size-3.5" aria-hidden />
      )}
      {admin ? "Admin" : "View only"}
    </Link>
  );
}

export function SiteHeader() {
  return (
    <>
      <header className="bg-card/90 sticky top-0 z-40 border-b backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-2.5 sm:gap-3 sm:px-6 sm:pt-3 sm:pb-0">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <Logo />
            <span className="text-lg">MoneyMaker</span>
          </Link>
          <span className="bg-primary/10 text-primary hidden rounded-full px-2.5 py-0.5 text-xs font-semibold min-[400px]:inline">
            Paper
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Suspense fallback={null}>
              <AccessChip />
            </Suspense>
            <ThemeToggle />
          </div>
        </div>
        <div className="mx-auto max-w-7xl px-2 sm:px-4">
          <Suspense fallback={<NavList />}>
            <NavLinks />
          </Suspense>
        </div>
      </header>
      <Suspense fallback={<MobileNav />}>
        <MobileNavLinks />
      </Suspense>
    </>
  );
}
