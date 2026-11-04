"use client";

import { cn } from "cn";
import { Info } from "lucide-react";
import { useRef, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Explanation } from "@/lib/explain";

/**
 * Text with a detailed explanation that opens on hover (mouse) or tap (touch), and on
 * keyboard focus + Enter. Hover uses a short delay so moving across a list doesn't flicker.
 */
export function HoverExplain({
  explanation,
  children,
  className,
}: {
  explanation: Explanation;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Runs only inside pointer events (never during render).
  function hover(e: React.PointerEvent, next: boolean, delay: number) {
    if (e.pointerType !== "mouse") return; // touch uses tap
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), delay);
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          "decoration-muted-foreground/50 hover:text-foreground inline cursor-help text-left underline decoration-dotted underline-offset-4",
          className,
        )}
        onPointerEnter={(e) => hover(e, true, 150)}
        onPointerLeave={(e) => hover(e, false, 200)}
      >
        {children}
        <Info className="ml-1 inline size-3.5 -translate-y-px opacity-60" aria-hidden />
        <span className="sr-only"> (explain)</span>
      </PopoverTrigger>
      <PopoverContent
        onPointerEnter={(e) => hover(e, true, 0)}
        onPointerLeave={(e) => hover(e, false, 200)}
      >
        <p className="font-semibold">{explanation.title}</p>
        <div className="text-muted-foreground mt-2 space-y-2 leading-relaxed">
          {explanation.body.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
        {explanation.setting && (
          <p className="bg-muted mt-3 rounded-md px-2.5 py-1.5 text-xs">
            <span className="text-muted-foreground">Setting: </span>
            {explanation.setting}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
