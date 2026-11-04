"use client";

import { cn } from "cn";
import { useActionState } from "react";

import { addFollowAction, resetPaperAction, unlockAction, type ActionResult } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function FormMessage({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  return (
    <p
      role="status"
      className={cn("text-sm whitespace-pre-line", state.ok ? "text-yes" : "text-no")}
    >
      {state.message}
    </p>
  );
}

export function ResetPaperForm({ current }: { current: number }) {
  const [state, action, pending] = useActionState(resetPaperAction, null);
  return (
    <form
      action={action}
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        if (!confirm("Reset the paper account? All paper positions and history will be erased.")) {
          e.preventDefault();
        }
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="balance">Starting balance ($)</Label>
        <Input
          id="balance"
          name="balance"
          type="number"
          min={10}
          step={1}
          defaultValue={current}
          className="w-36"
        />
      </div>
      <Button type="submit" variant="outline" disabled={pending}>
        Reset paper account
      </Button>
      <div className="basis-full">
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function AddFollowForm() {
  const [state, action, pending] = useActionState(addFollowAction, null);
  return (
    <form action={action} className="space-y-2">
      <Label htmlFor="wallet">Follow any Polymarket wallet</Label>
      <div className="flex gap-2">
        <Input id="wallet" name="wallet" placeholder="0x…" className="font-mono" required />
        <Button type="submit" disabled={pending}>
          Follow
        </Button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function UnlockForm() {
  const [state, action, pending] = useActionState(unlockAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <Label htmlFor="password">Admin password</Label>
        <Input id="password" name="password" type="password" className="w-56" required />
      </div>
      <Button type="submit" disabled={pending}>
        Unlock
      </Button>
      <div className="basis-full">
        <FormMessage state={state} />
      </div>
    </form>
  );
}
