"use client";

import {
  CartesianGrid,
  Line,
  LineChart as RLineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";

import { pct, usd } from "@/lib/format";

export type ValueFormat = "usd" | "pct";

export interface Series {
  key: string;
  label: string;
  /** CSS color, normally a validated role variable such as var(--series-1). */
  color: string;
}

const fmt = (v: number, f: ValueFormat) => (f === "usd" ? usd(v, { compact: true }) : pct(v));

const fmtX = (t: string) => {
  const d = new Date(t);
  return Number.isNaN(d.getTime())
    ? t
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

function ChartTooltip({
  active,
  payload,
  label,
  format,
}: TooltipContentProps & { format: ValueFormat }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-popover text-popover-foreground rounded-lg border px-3 py-2 text-xs shadow-md">
      <p className="text-muted-foreground mb-1">{fmtX(String(label))}</p>
      {payload.map((p) => (
        <p key={String(p.dataKey)} className="flex items-center gap-2">
          <span className="inline-block h-0.5 w-3 rounded" style={{ background: p.color }} />
          <span className="text-muted-foreground">{p.name}</span>
          <span className="ml-auto font-medium tabular-nums">{fmt(Number(p.value), format)}</span>
        </p>
      ))}
    </div>
  );
}

/**
 * Line chart for change over time. One series → no legend (the card title names it);
 * two or more → a legend plus a direct label at each line's end. Hover shows a crosshair
 * tooltip. A data table is always available beneath the plot.
 */
export function LineChart({
  data,
  series,
  format = "usd",
  height = 260,
  baseline,
}: {
  data: Array<Record<string, string | number>>;
  series: Series[];
  format?: ValueFormat;
  height?: number;
  /** Optional reference value drawn as a dashed line (e.g. starting balance). */
  baseline?: number;
}) {
  const last = data.at(-1);
  return (
    <figure className="w-full">
      {series.length > 1 && (
        <figcaption className="text-muted-foreground mb-2 flex flex-wrap gap-4 text-xs">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </figcaption>
      )}
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <RLineChart
            data={data}
            margin={{ top: 8, right: series.length > 1 ? 120 : 12, bottom: 0, left: 0 }}
          >
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="t"
              tickFormatter={fmtX}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              minTickGap={32}
            />
            <YAxis
              tickFormatter={(v: number) => fmt(v, format)}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={64}
              domain={["auto", "auto"]}
            />
            <Tooltip
              cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1, strokeDasharray: "3 3" }}
              content={(props) => <ChartTooltip {...props} format={format} />}
            />
            {baseline !== undefined && (
              <Line
                dataKey={() => baseline}
                name="Start"
                stroke="var(--muted-foreground)"
                strokeDasharray="4 4"
                strokeWidth={1}
                dot={false}
                activeDot={false}
                isAnimationActive={false}
                legendType="none"
              />
            )}
            {series.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 5, stroke: "var(--card)", strokeWidth: 2 }}
                isAnimationActive={false}
                label={
                  series.length > 1
                    ? (props: { x?: number | string; y?: number | string; index?: number }) =>
                        props.index === data.length - 1 && last ? (
                          <text
                            x={Number(props.x ?? 0) + 8}
                            y={Number(props.y ?? 0)}
                            dy={4}
                            fontSize={11}
                            fill="var(--foreground)"
                          >
                            {s.label}
                          </text>
                        ) : null
                    : undefined
                }
              />
            ))}
          </RLineChart>
        </ResponsiveContainer>
      </div>
      <details className="mt-2 text-xs">
        <summary className="text-muted-foreground hover:text-foreground cursor-pointer">
          Show data table
        </summary>
        <div className="mt-2 max-h-56 overflow-auto rounded-md border">
          <table className="w-full text-left tabular-nums">
            <thead className="bg-muted/50 sticky top-0">
              <tr>
                <th className="px-2 py-1 font-medium">Date</th>
                {series.map((s) => (
                  <th key={s.key} className="px-2 py-1 font-medium">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row, i) => (
                <tr key={i} className="border-t">
                  <td className="px-2 py-1">{fmtX(String(row.t))}</td>
                  {series.map((s) => (
                    <td key={s.key} className="px-2 py-1">
                      {fmt(Number(row[s.key]), format)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
