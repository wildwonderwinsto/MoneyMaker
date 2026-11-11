"use client";

import { cn } from "cn";
import { HandCoins } from "lucide-react";
import { useState, useTransition } from "react";

import { sellAllAction, type ActionResult } from "@/app/actions";
import { Button } from "@/components/ui/button";

export const sellAllConfirm = (open: number) =>
  `Sell all ${open} open position${open === 1 ? "" : "s"} now at the best prices buyers are offering? Your sell floor still applies, and anything that can't be sold stays open. You keep following the same traders, so their new trades will still be copied.`;

/** Admin: sell every open paper position (copies and hedges) right now. */
export function SellAllButton({ open }: { open: number }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button
        size="sm"
        variant="outline"
        disabled={pending || open === 0}
        className="hover:text-no"
        onClick={() => {
          if (!window.confirm(sellAllConfirm(open))) return;
          start(async () => {
            setResult(null);
            setResult(await sellAllAction());
          });
        }}
      >
        <HandCoins aria-hidden />
        {pending ? "Selling…" : "Sell all"}
      </Button>
      {result && (
        <p
          role="status"
          className={cn("max-w-72 text-right text-xs", result.ok ? "text-yes" : "text-no")}
        >
          {result.message}
        </p>
      )}
    </div>
  );
}
