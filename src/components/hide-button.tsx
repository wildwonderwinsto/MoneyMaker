"use client";

import { EyeOff, RotateCcw } from "lucide-react";
import { useState, useTransition } from "react";

import { setHiddenAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Admin: say "no" to a trader (hide + stop copying), or restore a hidden one. */
export function HideButton({
  wallet,
  hidden,
  size = "sm",
}: {
  wallet: string;
  hidden: boolean;
  size?: "sm" | "default";
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const button = (
    <Button
      size={size}
      variant="ghost"
      disabled={pending}
      className={hidden ? undefined : "text-muted-foreground hover:text-no"}
      title={
        hidden
          ? "Show this trader in Top traders again"
          : "Not interested: hide from Top traders, unfollow, and sell what was copied from them"
      }
      onClick={() =>
        start(async () => {
          setError(null);
          const res = await setHiddenAction(wallet, !hidden);
          if (!res.ok) setError(res.message);
        })
      }
    >
      {hidden ? <RotateCcw aria-hidden /> : <EyeOff aria-hidden />}
      {hidden ? "Restore" : "No"}
    </Button>
  );
  if (!error) return button;
  return (
    <Tooltip open>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom">{error}</TooltipContent>
    </Tooltip>
  );
}
