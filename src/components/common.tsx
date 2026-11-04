/** Small presentational building blocks shared by every page. */
import { cn } from "cn";
import { BadgeCheck, CircleSlash, Crown, Eye } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import type { ScoreTier } from "@/lib/db/schema";
import { hashString } from "@/lib/scoring/stats";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="text-muted-foreground mt-1 max-w-3xl text-sm">{description}</p>
        )}
      </div>
      {actions}
    </div>
  );
}

const TIER_META: Record<ScoreTier, { label: string; icon: typeof Crown; className: string }> = {
  elite: { label: "Elite", icon: Crown, className: "bg-primary/10 text-primary" },
  verified: { label: "Verified", icon: BadgeCheck, className: "bg-yes/10 text-yes" },
  watchlist: { label: "Watchlist", icon: Eye, className: "bg-muted text-muted-foreground" },
  rejected: { label: "Rejected", icon: CircleSlash, className: "bg-no/10 text-no" },
};

export function TierBadge({ tier }: { tier: ScoreTier }) {
  const { label, icon: Icon, className } = TIER_META[tier];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold",
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}

/** Profile picture, or a deterministic gradient generated from the wallet address. */
export function Avatar({
  wallet,
  src,
  size = 40,
  className,
}: {
  wallet: string;
  src?: string | null;
  size?: number;
  className?: string;
}) {
  if (src) {
    return (
      // External images from arbitrary hosts at avatar size: optimization not worth it.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className={cn("shrink-0 rounded-full object-cover", className)}
        style={{ width: size, height: size }}
      />
    );
  }
  const h = hashString(wallet);
  const a = h % 360;
  const b = (a + 40 + ((h >> 9) % 80)) % 360;
  return (
    <span
      aria-hidden
      className={cn("inline-block shrink-0 rounded-full", className)}
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, oklch(0.7 0.15 ${a}), oklch(0.55 0.18 ${b}))`,
      }}
    />
  );
}

export function MarketThumb({ src, size = 40 }: { src?: string | null; size?: number }) {
  if (!src)
    return <span className="bg-muted shrink-0 rounded-md" style={{ width: size, height: size }} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-md object-cover"
      style={{ width: size, height: size }}
    />
  );
}

/** KPI tile: one headline number, a label, and optional context. */
export function StatTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "gain" | "loss";
}) {
  return (
    <Card className="gap-0 py-4">
      <CardContent className="px-4">
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</p>
        <p
          className={cn(
            "mt-1 text-2xl font-semibold tabular-nums",
            tone === "gain" && "text-gain",
            tone === "loss" && "text-loss",
          )}
        >
          {value}
        </p>
        {hint && <p className="text-muted-foreground mt-1 text-xs">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function EmptyState({
  title,
  children,
  icon: Icon,
}: {
  title: string;
  children?: React.ReactNode;
  icon?: typeof Crown;
}) {
  return (
    <div className="bg-card flex flex-col items-center rounded-xl border border-dashed px-6 py-12 text-center">
      {Icon && <Icon className="text-muted-foreground mb-3 size-8" aria-hidden />}
      <p className="font-medium">{title}</p>
      {children && <div className="text-muted-foreground mt-1 max-w-md text-sm">{children}</div>}
    </div>
  );
}

/** Signed money/percent text: sign + color (+ arrow for screen readers via sign). */
export function Signed({ value, children }: { value: number | null; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "tabular-nums",
        value !== null && value > 0 && "text-gain",
        value !== null && value < 0 && "text-loss",
      )}
    >
      {children}
    </span>
  );
}
