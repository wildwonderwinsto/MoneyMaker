"use client";

/**
 * Remote images (Polymarket market icons, profile pictures) that degrade gracefully.
 * A few hosts are slow, reject hotlinking, or the file was deleted: on error we show a
 * fallback instead of a broken-image icon. `referrerPolicy="no-referrer"` avoids
 * hotlink blocks; lazy loading keeps long lists fast on mobile.
 */
import { cn } from "cn";
import { useState } from "react";

import { hashString } from "@/lib/scoring/stats";

/** Only http(s) URLs are loaded (stray relative paths or data blobs are ignored). */
export function usableSrc(src: string | null | undefined): string | null {
  if (!src) return null;
  const s = src.trim();
  if (s.startsWith("//")) return `https:${s}`;
  return /^https?:\/\//i.test(s) ? s : null;
}

function GradientAvatar({
  wallet,
  size,
  className,
}: {
  wallet: string;
  size: number;
  className?: string;
}) {
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
  const url = usableSrc(src);
  const [failed, setFailed] = useState<string | null>(null);
  if (!url || failed === url)
    return <GradientAvatar wallet={wallet} size={size} className={className} />;
  return (
    // External images from arbitrary hosts at avatar size: optimization not worth it.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(url)}
      className={cn("bg-muted shrink-0 rounded-full object-cover", className)}
      style={{ width: size, height: size }}
    />
  );
}

/** Market icon, or a neutral tile with the question's first letter. */
export function MarketThumb({
  src,
  size = 40,
  label,
}: {
  src?: string | null;
  size?: number;
  /** Used for the fallback initial. */
  label?: string | null;
}) {
  const url = usableSrc(src);
  const [failed, setFailed] = useState<string | null>(null);
  if (!url || failed === url) {
    return (
      <span
        aria-hidden
        className="bg-muted text-muted-foreground flex shrink-0 items-center justify-center rounded-md font-semibold"
        style={{ width: size, height: size, fontSize: Math.max(10, size * 0.4) }}
      >
        {label?.trim()[0]?.toUpperCase() ?? ""}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(url)}
      className="bg-muted shrink-0 rounded-md object-cover"
      style={{ width: size, height: size }}
    />
  );
}
