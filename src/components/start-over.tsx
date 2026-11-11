"use client";

import { Trash2 } from "lucide-react";
import { useId, useState, useTransition } from "react";

import { startOverAction, type ActionResult } from "@/app/actions";
import { FormMessage } from "@/components/forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Kept in sync with START_OVER_CONFIRM (src/lib/start-over.ts), which the server checks. */
const CONFIRM = "delete everything";

/**
 * Settings → Storage → Start over: delete all data, keep settings. Opens a panel that says
 * exactly what goes and what stays; the button only works once the phrase is typed.
 */
export function StartOver() {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const ready = text.trim().toLowerCase() === CONFIRM;

  if (!open) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">Start over</p>
          <p className="text-muted-foreground text-xs">
            Delete all data and begin again. Settings are kept.
          </p>
        </div>
        <Button variant="outline" size="sm" className="hover:text-no" onClick={() => setOpen(true)}>
          <Trash2 aria-hidden /> Start over…
        </Button>
        {result && (
          <div className="basis-full">
            <FormMessage state={result} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="border-destructive/40 bg-destructive/5 space-y-3 rounded-lg border p-3 sm:p-4">
      <p className="text-sm font-medium">Delete everything and start over?</p>
      <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-xs leading-normal">
        <li>
          <span className="text-foreground">Deleted:</span> every trader, score and position; the
          follow and hidden lists; the paper account&apos;s trades and history (it goes back to its
          starting balance); live signals; backtests and the saved monthly picks (the
          backtest&apos;s track record starts again); market data and job history.
        </li>
        <li>
          <span className="text-foreground">Kept:</span> your copy-engine and scoring settings.
        </li>
        <li>There&apos;s no undo. The next daily run discovers traders again.</li>
      </ul>
      <div className="space-y-1">
        <Label htmlFor={id} className="text-xs">
          Type <span className="font-mono">{CONFIRM}</span> to confirm
        </Label>
        <Input
          id={id}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className="max-w-72"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="destructive"
          size="sm"
          disabled={!ready || pending}
          onClick={() =>
            start(async () => {
              const r = await startOverAction(text);
              setResult(r);
              if (r.ok) {
                setOpen(false);
                setText("");
              }
            })
          }
        >
          <Trash2 aria-hidden /> {pending ? "Deleting…" : "Delete everything"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setText("");
          }}
        >
          Cancel
        </Button>
      </div>
      {result && !result.ok && <FormMessage state={result} />}
    </div>
  );
}
