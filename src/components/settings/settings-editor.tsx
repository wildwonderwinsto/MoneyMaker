"use client";

/**
 * Grouped settings editor. Keeps its own state (no <form action>), so React's automatic
 * form reset can never revert a field after saving — the cause of "proportional won't
 * switch to fixed". Values are validated with the same schema as the server, field by
 * field, before anything is sent. Visitors get the same layout, read-only.
 */
import { cn } from "cn";
import { Lock, Minus, Plus, RotateCcw } from "lucide-react";
import { useMemo, useState, useTransition } from "react";

import { saveSettingsAction, type ActionResult } from "@/app/actions";
import { FormMessage } from "@/components/forms";
import { LockedAction } from "@/components/locked-action";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_RISK_CONFIG, RiskConfigSchema } from "@/lib/copy/config";
import { DEFAULT_SCORING_CONFIG, ScoringConfigSchema } from "@/lib/scoring/config";

import {
  fromDisplay,
  humanIssue,
  RISK_GROUPS,
  SCORING_GROUPS,
  toDisplay,
  UNIT_SUFFIX,
  type Ctx,
  type Field,
  type Group,
} from "./fields";

type Values = Record<string, unknown>;
type Draft = Record<string, string | boolean | number>;

const SPEC = {
  risk: { groups: RISK_GROUPS, schema: RiskConfigSchema, defaults: DEFAULT_RISK_CONFIG },
  scoring: {
    groups: SCORING_GROUPS,
    schema: ScoringConfigSchema,
    defaults: DEFAULT_SCORING_CONFIG,
  },
} as const;

const allFields = (groups: Group[]) => groups.flatMap((g) => g.fields);

/** Stored values → what the inputs show. */
function toDraft(groups: Group[], values: Values): Draft {
  const d: Draft = {};
  for (const f of allFields(groups)) {
    const v = values[f.name];
    if (f.kind === "number") d[f.name] = String(toDisplay(f.unit, Number(v)));
    else if (f.kind === "boolean") d[f.name] = Boolean(v);
    else d[f.name] = v as string | number;
  }
  return d;
}

/** What the inputs show → stored values (fields not on screen keep their saved value). */
function fromDraft(groups: Group[], draft: Draft, base: Values): Values {
  const out: Values = { ...base };
  for (const f of allFields(groups)) {
    const v = draft[f.name];
    if (f.kind === "number") {
      const s = String(v).trim();
      out[f.name] = s === "" ? Number.NaN : fromDisplay(f.unit, Number(s));
    } else out[f.name] = v;
  }
  return out;
}

export function SettingsEditor({
  kind,
  values,
  admin,
  ctx,
}: {
  kind: "risk" | "scoring";
  values: Values;
  admin: boolean;
  ctx: Ctx;
}) {
  const { groups, schema, defaults } = SPEC[kind];
  const [saved, setSaved] = useState<Values>(values);
  const [draft, setDraft] = useState<Draft>(() => toDraft(groups, values));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [state, setState] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();

  const current = useMemo(() => fromDraft(groups, draft, saved), [groups, draft, saved]);
  const dirty = useMemo(
    () =>
      allFields(groups).some(
        (f) => JSON.stringify(current[f.name]) !== JSON.stringify(saved[f.name]),
      ),
    [groups, current, saved],
  );

  const set = (name: string, v: string | boolean | number) => {
    setDraft((d) => ({ ...d, [name]: v }));
    setErrors((e) => {
      if (!e[name]) return e;
      const rest = { ...e };
      delete rest[name];
      return rest;
    });
    setState(null);
  };

  const save = () => {
    const parsed = schema.safeParse(current);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "");
        const field = allFields(groups).find((f) => f.name === key);
        errs[key] = Number.isNaN(current[key])
          ? "Enter a number"
          : humanIssue(
              issue.message,
              field,
              field?.kind === "number" ? toDisplay(field.unit, Number(current[key])) : undefined,
            );
      }
      setErrors(errs);
      setState({ ok: false, message: "Fix the highlighted fields." });
      return;
    }
    start(async () => {
      const res = await saveSettingsAction(kind, parsed.data, saved);
      setState(res);
      if (res.ok) {
        setSaved(parsed.data as Values);
        setDraft(toDraft(groups, parsed.data as Values));
      }
    });
  };

  return (
    <div className="space-y-4">
      {!admin && (
        <div className="bg-muted text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3 py-2 text-sm">
          <span className="flex flex-1 items-center gap-2">
            <Lock className="size-4 shrink-0" aria-hidden /> View only. Unlock to change anything.
          </span>
          <LockedAction label="Unlock to edit" variant="default" />
        </div>
      )}
      {groups.map((g) => (
        <section key={g.id} className="rounded-xl border" aria-labelledby={`${kind}-${g.id}`}>
          <header className="border-b px-3 py-3 sm:px-4">
            <h3 id={`${kind}-${g.id}`} className="font-semibold">
              {g.title}
            </h3>
            <p className="text-muted-foreground mt-0.5 text-sm">{g.description}</p>
          </header>
          <div className="divide-y">
            {g.fields
              .filter((f) => !f.showIf || f.showIf(current))
              .map((f) => (
                <FieldRow
                  key={f.name}
                  id={`${kind}-${f.name}`}
                  field={f}
                  draft={draft}
                  current={current}
                  ctx={ctx}
                  admin={admin}
                  error={errors[f.name]}
                  onChange={set}
                />
              ))}
          </div>
        </section>
      ))}
      {admin && (
        <div className="bg-card/95 sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 -mx-1 flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2.5 shadow-sm backdrop-blur sm:bottom-3">
          <Button onClick={save} disabled={pending || !dirty}>
            {pending ? "Saving…" : "Save changes"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              setDraft(toDraft(groups, defaults as Values));
              setErrors({});
              setState(null);
            }}
          >
            <RotateCcw aria-hidden /> Defaults
          </Button>
          {dirty && !state && (
            <span className="text-muted-foreground text-sm">Unsaved changes</span>
          )}
          <FormMessage state={state} />
        </div>
      )}
    </div>
  );
}

/**
 * Number field with − / + buttons and the unit in a fixed slot, so values line up from
 * row to row. Native browser spinners are hidden (they overlapped the value).
 */
function NumberStepper({
  id,
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  unit,
  invalid,
  describedBy,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  step?: number;
  min?: number;
  max?: number;
  unit: string;
  invalid: boolean;
  describedBy?: string;
}) {
  const n = Number(value);
  const decimals = (String(step).split(".")[1] ?? "").length;
  const nudge = (dir: 1 | -1) => {
    const base = Number.isFinite(n) && value !== "" ? n : (min ?? 0);
    let next = Math.round((base + dir * step) / step) * step;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    onChange(String(Number(next.toFixed(decimals))));
  };
  const atMin = min !== undefined && Number.isFinite(n) && value !== "" && n <= min;
  const atMax = max !== undefined && Number.isFinite(n) && value !== "" && n >= max;
  const btn =
    "text-muted-foreground hover:bg-muted hover:text-foreground flex w-9 shrink-0 items-center justify-center transition-colors disabled:pointer-events-none disabled:opacity-30";
  return (
    <div
      aria-invalid={invalid}
      className={cn(
        "border-input dark:bg-input/30 flex h-9 w-full items-stretch overflow-hidden rounded-md border bg-transparent shadow-xs transition-[color,box-shadow]",
        "focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        className={cn(btn, "border-input border-r")}
        onClick={() => nudge(-1)}
        disabled={atMin}
        aria-label={`Decrease ${label}`}
      >
        <Minus className="size-3.5" />
      </button>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        className="min-w-0 flex-1 [appearance:textfield] bg-transparent pr-1.5 pl-2 text-right text-base tabular-nums outline-none md:text-sm [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <span
        aria-hidden
        className="text-muted-foreground flex w-9 shrink-0 items-center text-xs font-medium"
      >
        {unit}
      </span>
      <button
        type="button"
        tabIndex={-1}
        className={cn(btn, "border-input border-l")}
        onClick={() => nudge(1)}
        disabled={atMax}
        aria-label={`Increase ${label}`}
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}

function FieldRow({
  id,
  field: f,
  draft,
  current,
  ctx,
  admin,
  error,
  onChange,
}: {
  id: string;
  field: Field;
  draft: Draft;
  current: Values;
  ctx: Ctx;
  admin: boolean;
  error?: string;
  onChange: (name: string, v: string | boolean | number) => void;
}) {
  const example = f.kind !== "boolean" && f.example ? f.example(current, ctx) : null;

  if (f.kind === "boolean") {
    const on = Boolean(draft[f.name]);
    return (
      <div className="flex items-start justify-between gap-4 px-3 py-3 sm:px-4">
        <div className="min-w-0">
          <Label htmlFor={id} className="font-medium">
            {f.label}
          </Label>
          <p className="text-muted-foreground mt-1 text-sm leading-normal">{f.help}</p>
        </div>
        {admin ? (
          <Switch id={id} checked={on} onCheckedChange={(v) => onChange(f.name, v)} />
        ) : (
          <span
            className={cn(
              "shrink-0 text-sm font-medium",
              on ? "text-yes" : "text-muted-foreground",
            )}
          >
            {on ? "On" : "Off"}
          </span>
        )}
      </div>
    );
  }

  if (f.kind === "choice") {
    const value = draft[f.name];
    const selected = f.options.find((o) => o.value === value);
    return (
      <div className="space-y-2 px-3 py-3 sm:px-4">
        <div>
          <p className="text-sm font-medium" id={`${id}-label`}>
            {f.label}
          </p>
          {f.help && <p className="text-muted-foreground mt-1 text-sm leading-normal">{f.help}</p>}
        </div>
        {admin ? (
          <div
            role="radiogroup"
            aria-labelledby={`${id}-label`}
            className={cn(
              "grid gap-2",
              // Options with descriptions stack on phones; short ones (15s/30s/1m) stay in a row.
              !f.options.some((o) => o.help)
                ? "grid-cols-3"
                : f.options.length === 2
                  ? "sm:grid-cols-2"
                  : "sm:grid-cols-3",
            )}
          >
            {f.options.map((o) => {
              const active = o.value === value;
              return (
                <button
                  key={String(o.value)}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onChange(f.name, o.value)}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                    active
                      ? "border-primary bg-primary/5 ring-primary ring-1"
                      : "hover:bg-muted/50",
                  )}
                >
                  <span className="font-medium">{o.label}</span>
                  {o.help && (
                    <span className="text-muted-foreground mt-0.5 block text-xs leading-snug">
                      {o.help}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-sm">
            <span className="font-medium">{selected?.label ?? String(value)}</span>
            {selected?.help && <span className="text-muted-foreground"> · {selected.help}</span>}
          </p>
        )}
        {example && <p className="bg-muted/60 rounded-md px-2.5 py-1.5 text-xs">{example}</p>}
      </div>
    );
  }

  const unit = UNIT_SUFFIX[f.unit];
  const prefix = unit === "$";
  return (
    <div className="grid grid-cols-1 gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_11rem] sm:items-start sm:gap-6 sm:px-4">
      <div className="min-w-0">
        <Label htmlFor={id} className="font-medium">
          {f.label}
        </Label>
        <p className="text-muted-foreground mt-1 text-sm leading-normal">{f.help}</p>
        {example && <p className="bg-muted/60 mt-2 rounded-md px-2.5 py-1.5 text-xs">{example}</p>}
      </div>
      <div>
        {admin ? (
          <NumberStepper
            id={id}
            label={f.label}
            value={String(draft[f.name] ?? "")}
            onChange={(v) => onChange(f.name, v)}
            step={f.step}
            min={f.min}
            max={f.max}
            unit={prefix ? "USD" : unit}
            invalid={!!error}
            describedBy={error ? `${id}-err` : undefined}
          />
        ) : (
          <p className="text-right text-sm font-medium tabular-nums sm:pt-1">
            {prefix ? `$${draft[f.name]}` : `${draft[f.name]}${unit ? ` ${unit}` : ""}`}
          </p>
        )}
        {error && (
          <p id={`${id}-err`} className="text-no mt-1 text-xs sm:text-right">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
