"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";

import { axisUsd, usd } from "@/lib/format";

function BarTooltip({ active, payload, label }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  const v = Number(payload[0].value);
  return (
    <div className="bg-popover text-popover-foreground rounded-lg border px-3 py-2 text-xs shadow-md">
      <p className="text-muted-foreground">{label}</p>
      <p className="font-medium tabular-nums">
        {v >= 0 ? "Profit" : "Loss"} {usd(v, { sign: true, compact: true })}
      </p>
    </div>
  );
}

/**
 * Monthly profit/loss (polarity → diverging blue/red poles, validated palette).
 * Bars are anchored to the zero line and rounded only at their data end.
 */
export function PnlBars({
  data,
  height = 200,
}: {
  data: Array<{ month: string; pnl: number }>;
  height?: number;
}) {
  return (
    <figure className="w-full">
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            barCategoryGap={2}
          >
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="month"
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              minTickGap={8}
            />
            <YAxis
              tickFormatter={axisUsd}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={52}
            />
            <ReferenceLine y={0} stroke="var(--muted-foreground)" />
            <Tooltip
              cursor={{ fill: "var(--muted)", opacity: 0.5 }}
              content={(p) => <BarTooltip {...p} />}
            />
            <Bar dataKey="pnl" name="Monthly P&L" isAnimationActive={false} maxBarSize={28}>
              {data.map((d) => (
                <Cell
                  key={d.month}
                  fill={d.pnl >= 0 ? "var(--gain)" : "var(--loss)"}
                  // Round the end away from zero.
                  radius={(d.pnl >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4]) as unknown as number}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="text-muted-foreground mt-2 flex gap-4 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="bg-gain inline-block size-2.5 rounded-sm" /> Profitable month
        </span>
        <span className="flex items-center gap-1.5">
          <span className="bg-loss inline-block size-2.5 rounded-sm" /> Losing month
        </span>
      </figcaption>
    </figure>
  );
}
