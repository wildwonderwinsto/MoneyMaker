"use client";

import { cn } from "cn";
import { HandCoins, TrendingUp } from "lucide-react";
import { useState, useTransition } from "react";

import { sellAllAction, type ActionResult } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Admin: sell open paper positions (copies and hedges) right now. The button opens a panel
 * with the two ways to do it, everything or only what's in profit; choosing one there is
 * the confirmation.
 */
export function SellAllButton({ open }: { open: number }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [panel, setPanel] = useState(false);
  const sell = (profitOnly: boolean) => {
    setPanel(false);
    start(async () => {
      setResult(null);
      setResult(await sellAllAction(profitOnly));
    });
  };
  return (
    <div className="flex flex-col items-end gap-1.5">
      <Popover open={panel} onOpenChange={setPanel}>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || open === 0}
            className="hover:text-no"
          >
            <HandCoins aria-hidden />
            {pending ? "Selling…" : "Sell all"}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end">
          <p className="font-medium">
            Sell {open} open position{open === 1 ? "" : "s"} now?
          </p>
          <p className="text-muted-foreground mt-1 mb-3 text-xs leading-relaxed">
            Sold at the best prices buyers are offering. Your sell floor still applies, and anything
            that can&apos;t be sold stays open. You keep following the same traders, so their new
            trades will still be copied.
          </p>
          <div className="space-y-2">
            <Button
              variant="outline"
              className="hover:text-no w-full justify-start"
              onClick={() => sell(false)}
            >
              <HandCoins aria-hidden />
              Sell all
            </Button>
            <Button
              variant="outline"
              className="hover:text-yes w-full justify-start"
              onClick={() => sell(true)}
            >
              <TrendingUp aria-hidden />
              Sell profit only
            </Button>
          </div>
          <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
            Profit only sells just the positions that would bring in more than they cost, after
            fees. A hedged position counts together with its hedge.
          </p>
        </PopoverContent>
      </Popover>
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
