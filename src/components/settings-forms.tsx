"use client";

import { useActionState, useTransition } from "react";

import {
  lockAction,
  saveRiskAction,
  saveScoringAction,
  setFollowAction,
  setWeightAction,
} from "@/app/actions";
import { FormMessage } from "@/components/forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export interface FieldSpec {
  name: string;
  label: string;
  help?: string;
  step?: number;
  /** Values are stored exactly as entered (fractions like 0.1 mean 10%). */
  kind?: "number" | "boolean" | "select";
  options?: string[];
}

function Field({ spec, value }: { spec: FieldSpec; value: unknown }) {
  const id = `f-${spec.name}`;
  if (spec.kind === "boolean") {
    return (
      <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
        <div>
          <Label htmlFor={id}>{spec.label}</Label>
          {spec.help && <p className="text-muted-foreground mt-1 text-xs">{spec.help}</p>}
        </div>
        <Switch id={id} name={spec.name} defaultChecked={Boolean(value)} />
      </div>
    );
  }
  return (
    <div className="space-y-1 rounded-lg border p-3">
      <Label htmlFor={id}>{spec.label}</Label>
      {spec.kind === "select" ? (
        <select
          id={id}
          name={spec.name}
          defaultValue={String(value)}
          className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
        >
          {spec.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <Input
          id={id}
          name={spec.name}
          type="number"
          step={spec.step ?? "any"}
          defaultValue={String(value)}
        />
      )}
      {spec.help && <p className="text-muted-foreground text-xs">{spec.help}</p>}
    </div>
  );
}

export function SettingsForm({
  kind,
  fields,
  values,
}: {
  kind: "scoring" | "risk";
  fields: FieldSpec[];
  values: Record<string, unknown>;
}) {
  const [state, action, pending] = useActionState(
    kind === "scoring" ? saveScoringAction : saveRiskAction,
    null,
  );
  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {fields.map((f) => (
          <Field key={f.name} spec={f} value={values[f.name]} />
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          Save
        </Button>
        <FormMessage state={state} />
      </div>
    </form>
  );
}

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
  return (
    <div className="flex items-center gap-3">
      <Input
        aria-label="Sizing weight"
        type="number"
        min={0}
        max={5}
        step={0.25}
        defaultValue={weight}
        className="h-8 w-20"
        disabled={pending}
        onBlur={(e) => {
          const v = Number(e.currentTarget.value);
          if (v !== weight) start(async () => void (await setWeightAction(wallet, v)));
        }}
      />
      <Switch
        aria-label={enabled ? "Stop copying" : "Start copying"}
        checked={enabled}
        disabled={pending}
        onCheckedChange={(on) => start(async () => void (await setFollowAction(wallet, on)))}
      />
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
