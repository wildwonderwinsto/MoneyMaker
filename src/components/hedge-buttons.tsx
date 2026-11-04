"use client";

import { Shield } from "lucide-react";
import { useState, useTransition } from "react";

import { hedgeAction, type ActionResult } from "@/app/actions";
import { FormMessage } from "@/components/forms";
import { Button } from "@/components/ui/button";

/** Admin-only: buy the hedge after a confirmation that restates the cost. */
export function HedgeButton({
  positionId,
  mode,
  label,
  confirmText,
  disabled,
}: {
  positionId: number;
  mode: "lock" | "breakeven";
  label: string;
  confirmText: string;
  disabled?: boolean;
}) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<ActionResult | null>(null);
  return (
    <div className="space-y-2">
      <Button
        variant={mode === "lock" ? "default" : "outline"}
        className="w-full"
        disabled={disabled || pending}
        onClick={() => {
          if (!confirm(confirmText)) return;
          start(async () => setState(await hedgeAction(positionId, mode)));
        }}
      >
        <Shield aria-hidden /> {pending ? "Hedging…" : label}
      </Button>
      <FormMessage state={state} />
    </div>
  );
}
