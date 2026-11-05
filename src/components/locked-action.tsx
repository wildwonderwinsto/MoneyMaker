"use client";

import { Lock } from "lucide-react";

import { UnlockForm } from "@/components/forms";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * What visitors see in place of any control that changes something: the same button with a
 * lock. Clicking it asks for the admin password right there; once unlocked the page
 * refreshes and the real control takes its place. (The server still re-checks admin on
 * every action; this is only the UI.)
 */
export function LockedAction({
  label,
  size = "sm",
  variant = "outline",
  className,
}: {
  label: string;
  size?: "sm" | "default";
  variant?: "outline" | "default" | "ghost";
  className?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size={size} variant={variant} className={className}>
          <Lock aria-hidden />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <p className="font-medium">Admin password needed</p>
        <p className="text-muted-foreground mt-1 mb-3 text-xs leading-relaxed">
          Visitors can look around but not change anything. Unlocking lasts 30 days on this device.
        </p>
        <UnlockForm />
      </PopoverContent>
    </Popover>
  );
}
