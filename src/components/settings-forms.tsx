"use client";

import { cn } from "cn";
import { Lock, LockOpen } from "lucide-react";
import { useState, useTransition } from "react";
import { useFormStatus } from "react-dom";

import {
  lockAction,
  removeFollowAction,
  setFollowAction,
  setWeightAction,
  type ActionResult,
} from "@/app/actions";
import { FormMessage } from "@/components/forms";
import { parseWeight } from "@/components/settings/fields";
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
              const v = parseWeight(e.currentTarget.value);
              if (v === null) e.currentTarget.value = String(weight);
              else if (v !== weight) start(async () => setState(await setWeightAction(wallet, v)));
            }}
          />
        </label>
        <Switch
          aria-label={enabled ? "Stop copying" : "Start copying"}
          checked={enabled}
          disabled={pending}
          onCheckedChange={(on) => start(async () => setState(await setFollowAction(wallet, on)))}
        />
        {/* Always takes its space (hidden while copying) so every row's controls line up. */}
        <Button
          size="sm"
          variant="ghost"
          className={cn("text-muted-foreground hover:text-no w-20", enabled && "invisible")}
          disabled={pending || enabled}
          aria-hidden={enabled}
          tabIndex={enabled ? -1 : undefined}
          title="Remove from this list. Open copies still close when this trader sells."
          onClick={() => start(async () => setState(await removeFollowAction(wallet)))}
        >
          Remove
        </Button>
      </div>
      {state && !state.ok && <FormMessage state={state} />}
    </div>
  );
}

export function LockButton() {
  return (
    <form action={lockAction}>
      <LockSubmit />
    </form>
  );
}

/** The padlock closes while locking. */
function LockSubmit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" size="sm" disabled={pending} className="group">
      {pending ? (
        <Lock
          aria-hidden
          className="animate-in zoom-in-75 spin-in-12 duration-300 motion-reduce:animate-none"
        />
      ) : (
        <LockOpen aria-hidden className="transition-transform group-hover:-rotate-12" />
      )}
      {pending ? "Locking…" : "Lock"}
    </Button>
  );
}
