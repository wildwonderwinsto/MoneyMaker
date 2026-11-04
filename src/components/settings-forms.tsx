"use client";

import { useState, useTransition } from "react";

import { lockAction, setFollowAction, setWeightAction, type ActionResult } from "@/app/actions";
import { FormMessage } from "@/components/forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

/** Admin-only controls for one followed trader: sizing weight and on/off. */
export function FollowRowControls({
  wallet,
  enabled,
  weight,
}: {
  wallet: string;
  enabled: boolean;
  weight: number;
}) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<ActionResult | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-3">
        <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
          Weight
          <Input
            aria-label="Sizing weight"
            type="number"
            inputMode="decimal"
            min={0}
            max={5}
            step={0.25}
            defaultValue={weight}
            className="h-8 w-20 text-right tabular-nums"
            disabled={pending}
            onBlur={(e) => {
              const v = Number(e.currentTarget.value);
              if (v !== weight) start(async () => setState(await setWeightAction(wallet, v)));
            }}
          />
        </label>
        <Switch
          aria-label={enabled ? "Stop copying" : "Start copying"}
          checked={enabled}
          disabled={pending}
          onCheckedChange={(on) => start(async () => setState(await setFollowAction(wallet, on)))}
        />
      </div>
      {state && !state.ok && <FormMessage state={state} />}
    </div>
  );
}

export function LockButton() {
  return (
    <form action={lockAction}>
      <Button type="submit" variant="outline" size="sm">
        Lock
      </Button>
    </form>
  );
}
