"use client";

import { cn } from "cn";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useId, useState, useTransition } from "react";

import type { ActionResult } from "@/app/actions";
import {
  createPortfolioAction,
  deletePortfolioAction,
  placeBetAction,
  refreshBetsAction,
  resetPortfolioAction,
  sellBetAction,
} from "@/app/custom-actions";
import { FormMessage } from "@/components/forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function CreatePortfolioForm() {
  const [state, action, pending] = useActionState(createPortfolioAction, null);
  const id = useId();
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          name="name"
          placeholder="My bets"
          maxLength={60}
          className="w-44"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-bal`}>Starting balance ($)</Label>
        <Input
          id={`${id}-bal`}
          name="balance"
          type="number"
          min={10}
          step={1}
          defaultValue={1000}
          className="w-32"
        />
      </div>
      <Button type="submit" variant="outline" disabled={pending}>
        New portfolio
      </Button>
      <div className="basis-full">
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export interface TicketOutcome {
  index: number;
  label: string;
  price: number | null;
}

/** Pick an outcome, enter dollars, buy at the live asks. */
export function BetTicket({
  portfolioId,
  conditionId,
  outcomes,
  cash,
}: {
  portfolioId: number;
  conditionId: string;
  outcomes: TicketOutcome[];
  cash: number;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const [amount, setAmount] = useState("10");
  const [state, setState] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const id = useId();
  const choice = outcomes.find((o) => o.index === picked);
  const dollars = Number(amount);
  const estShares = choice?.price && dollars > 0 ? dollars / choice.price : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {outcomes.map((o, i) => (
          <Button
            key={o.index}
            type="button"
            size="sm"
            variant={picked === o.index ? "default" : "outline"}
            onClick={() => {
              setPicked(o.index);
              setState(null);
            }}
            className={cn(
              picked !== o.index && outcomes.length === 2 && (i === 0 ? "text-yes" : "text-no"),
            )}
          >
            {o.label}
            {o.price !== null && (
              <span className="tabular-nums opacity-80">{Math.round(o.price * 100)}¢</span>
            )}
          </Button>
        ))}
      </div>
      {choice && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              setState(
                await placeBetAction({
                  portfolioId,
                  conditionId,
                  outcomeIndex: choice.index,
                  amount: dollars,
                }),
              );
            });
          }}
        >
          <div className="space-y-1">
            <Label htmlFor={id} className="text-xs">
              Amount ($) · {cash.toFixed(2)} cash
            </Label>
            <Input
              id={id}
              type="number"
              min={1}
              step="any"
              max={cash}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="h-8 w-28"
              required
            />
          </div>
          <Button type="submit" size="sm" disabled={pending || !(dollars >= 1)}>
            {pending ? "Buying…" : `Buy ${choice.label}`}
          </Button>
          {estShares !== null && choice.price !== null && (
            <span className="text-muted-foreground pb-1.5 text-xs tabular-nums">
              ≈ {estShares.toFixed(1)} shares · +${(estShares - dollars).toFixed(2)} if it wins
              (before fees)
            </span>
          )}
        </form>
      )}
      <FormMessage state={state} />
    </div>
  );
}

export function SellBetButton({ betId, label }: { betId: number; label: string }) {
  const [state, setState] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => {
          if (!confirm(`Sell ${label} at the best bids now?`)) return;
          start(async () => setState(await sellBetAction(betId)));
        }}
      >
        {pending ? "Selling…" : "Sell"}
      </Button>
      {state && !state.ok && <FormMessage state={state} />}
    </span>
  );
}

export function RefreshPricesButton() {
  const [state, setState] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <span className="inline-flex items-center gap-2">
      {state && !state.ok && <FormMessage state={state} />}
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => start(async () => setState(await refreshBetsAction()))}
      >
        <RefreshCw className={cn(pending && "animate-spin")} aria-hidden />
        Update prices
      </Button>
    </span>
  );
}

export function PortfolioControls({
  id,
  name,
  balance,
}: {
  id: number;
  name: string;
  balance: number;
}) {
  const router = useRouter();
  const [value, setValue] = useState(String(balance));
  const [state, setState] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const inputId = useId();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={inputId}>Starting balance ($)</Label>
          <Input
            id={inputId}
            type="number"
            min={10}
            step={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-36"
          />
        </div>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => {
            if (!confirm(`Reset “${name}”? Every bet in it will be erased.`)) return;
            start(async () => setState(await resetPortfolioAction(id, Number(value))));
          }}
        >
          Reset
        </Button>
        <Button
          variant="outline"
          className="text-loss"
          disabled={pending}
          onClick={() => {
            if (!confirm(`Delete “${name}” and all its bets? This can't be undone.`)) return;
            start(async () => {
              const r = await deletePortfolioAction(id);
              if (r.ok) router.push("/paper#personal-bets");
              else setState(r);
            });
          }}
        >
          Delete portfolio
        </Button>
      </div>
      <FormMessage state={state} />
    </div>
  );
}
