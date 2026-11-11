"use client";

import { CheckIcon } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import { Fragment } from "react";

import { NavTab, usePendingNav } from "@/components/pending-nav";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface TierTabItem {
  value: string;
  label: string;
  group: "tiers" | "lists";
  help: string;
  count: number;
  href: string;
}

const GROUP = "tier";

/**
 * The Traders page's tier tabs: tiers best first, a gap, then the lists. Each tab shows its
 * count and explains itself on hover. Below `lg` the row would overflow, so it becomes a
 * dropdown (with each explanation under its option, since touch has no hover).
 */
export function TierTabs({ tabs, selected }: { tabs: TierTabItem[]; selected: string }) {
  const { target, go } = usePendingNav();
  const groups = (["tiers", "lists"] as const)
    .map((g) => tabs.filter((t) => t.group === g))
    .filter((g) => g.length > 0);
  // While a tab is loading it already counts as chosen (as NavTab does).
  const pending = target?.group === GROUP ? tabs.find((t) => t.href === target.href) : undefined;
  const value = pending?.value ?? selected;

  return (
    <>
      <div className="hidden items-center gap-2 lg:flex" role="tablist" aria-label="Tier">
        {groups.map((list) => (
          <div key={list[0].group} className="bg-muted flex gap-1 rounded-lg p-1">
            {list.map((t) => (
              <Tooltip key={t.value}>
                <TooltipTrigger asChild>
                  <NavTab
                    group={GROUP}
                    href={t.href}
                    selected={t.value === selected}
                    className="rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap transition-colors"
                    activeClassName="bg-card text-foreground shadow-sm"
                    inactiveClassName="text-muted-foreground hover:text-foreground"
                  >
                    {t.label}{" "}
                    <span className="text-muted-foreground tabular-nums">({t.count})</span>
                  </NavTab>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6} className="max-w-64 text-pretty">
                  {t.help}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        ))}
      </div>

      <div className="w-full lg:hidden">
        <Select
          value={value}
          onValueChange={(v) => {
            const t = tabs.find((x) => x.value === v);
            if (t && v !== value) go(GROUP, t.href);
          }}
        >
          <SelectTrigger className="bg-card w-full" aria-label="Tier">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" className="w-(--radix-select-trigger-width)">
            {groups.map((list, i) => (
              <Fragment key={list[0].group}>
                {i > 0 && <SelectSeparator />}
                <SelectGroup>
                  {list.map((t) => (
                    <SelectPrimitive.Item
                      key={t.value}
                      value={t.value}
                      className="focus:bg-accent focus:text-accent-foreground relative flex w-full cursor-default flex-col items-start gap-0.5 rounded-sm py-2 pr-8 pl-2 text-sm outline-hidden select-none"
                    >
                      <span className="absolute top-2.5 right-2 flex size-3.5 items-center justify-center">
                        <SelectPrimitive.ItemIndicator>
                          <CheckIcon className="size-4" />
                        </SelectPrimitive.ItemIndicator>
                      </span>
                      <SelectPrimitive.ItemText>
                        <span>
                          <span className="font-medium">{t.label}</span>{" "}
                          <span className="text-muted-foreground tabular-nums">({t.count})</span>
                        </span>
                      </SelectPrimitive.ItemText>
                      <span className="text-muted-foreground text-xs leading-snug">{t.help}</span>
                    </SelectPrimitive.Item>
                  ))}
                </SelectGroup>
              </Fragment>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  );
}
