"use client";

import { Check, Plus } from "lucide-react";
import { useOptimistic, useState, useTransition } from "react";

import { setFollowAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function FollowButton({
  wallet,
  following,
  size = "sm",
}: {
  wallet: string;
  following: boolean;
  size?: "sm" | "default";
}) {
  const [optimistic, setOptimistic] = useOptimistic(following);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const toggle = () =>
    startTransition(async () => {
      setError(null);
      setOptimistic(!optimistic);
      const res = await setFollowAction(wallet, !optimistic);
      if (!res.ok) setError(res.message);
    });

  const button = (
    <Button
      size={size}
      variant={optimistic ? "outline" : "default"}
      onClick={toggle}
      disabled={pending}
      aria-pressed={optimistic}
    >
      {optimistic ? <Check aria-hidden /> : <Plus aria-hidden />}
      {optimistic ? "Following" : "Follow"}
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
