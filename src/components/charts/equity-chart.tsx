"use client";

/**
 * Paper equity over time with every buy and sell marked on the line.
 * - Real time axis (points are spaced by when they happened, not evenly).
 * - Markers: "B" badge for a buy (series-3), "S" badge for a sell or settlement (neutral
 *   gray, so a sale never reads as a loss) on the equity line (series-1). The letter is a
 *   second cue so identity never relies on color alone.
 * - Crosshair tooltip lists the trades at that moment. A range filter and zoom controls sit
 *   above (wheel / pinch / drag also zoom and pan, see ./zoom); a readable table (newest
 *   first, with change and trades per period) sits below.
 */
import { cn } from "cn";
import { useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";

import { cents, num, usd } from "@/lib/format";

import { useChartZoom, ZoomControls, ZoomHint, zoomSurface } from "./zoom";

export interface EquityPoint {
  t: string;
  equity: number;
}

export interface FillMarker {
  id: number;
  ts: string;
  side: string;
  kind: string;
  notional: number;
  shares: number;
  avgPrice: number;
  realizedPnl: number | null;
  title: string | null;
  outcome: string | null;
}

interface Row {
  ts: number;
  equity: number;
  buy?: number;
  sell?: number;
  fills?: FillMarker[];
}

const RANGES = [
  { key: "1d", label: "1D", ms: 86_400_000 },
  { key: "1w", label: "1W", ms: 7 * 86_400_000 },
  { key: "1m", label: "1M", ms: 30 * 86_400_000 },
  { key: "all", label: "All", ms: Infinity },
] as const;

const isBuy = (f: FillMarker) => f.side === "BUY";
const fillLabel = (f: FillMarker) =>
  f.kind === "settlement"
    ? f.side === "WIN"
      ? "Won"
      : f.side === "SPLIT"
        ? "50/50"
        : "Lost"
    : f.side === "BUY"
      ? "Bought"
      : "Sold";

/** Equity at time `ts`, linearly interpolated between snapshots. */
function equityAt(curve: Array<{ ts: number; equity: number }>, ts: number): number {
  if (curve.length === 0) return 0;
  if (ts <= curve[0].ts) return curve[0].equity;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (ts <= b.ts) {
      const w = b.ts === a.ts ? 1 : (ts - a.ts) / (b.ts - a.ts);
      return a.equity + w * (b.equity - a.equity);
    }
  }
  return curve.at(-1)!.equity;
}

function buildRows(curve: EquityPoint[], fills: FillMarker[]): Row[] {
  const base = curve
    .map((p) => ({ ts: Date.parse(p.t), equity: p.equity }))
    .filter((p) => Number.isFinite(p.ts))
    .sort((a, b) => a.ts - b.ts);
  const rows: Row[] = base.map((p) => ({ ...p }));
  // One marker row per minute and direction, holding every fill in it.
  const buckets = new Map<string, FillMarker[]>();
  for (const f of fills) {
    const ts = Date.parse(f.ts);
    if (!Number.isFinite(ts)) continue;
    const key = `${Math.floor(ts / 60_000)}|${isBuy(f) ? "b" : "s"}`;
    buckets.set(key, [...(buckets.get(key) ?? []), f]);
  }
  for (const [key, list] of buckets) {
    const ts = Date.parse(list[0].ts);
    const y = equityAt(base, ts);
    rows.push({ ts, equity: y, fills: list, ...(key.endsWith("b") ? { buy: y } : { sell: y }) });
  }
  return rows.sort((a, b) => a.ts - b.ts);
}

const fmtTime = (ts: number, spanMs: number) => {
  const d = new Date(ts);
  return spanMs <= 2 * 86_400_000
    ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};
const fmtFull = (ts: number) =>
  new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

function Tip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as Row | undefined;
  if (!row) return null;
  return (
    <div className="bg-popover text-popover-foreground max-w-72 rounded-lg border px-3 py-2 text-xs shadow-md">
      <p className="text-muted-foreground">{fmtFull(row.ts)}</p>
      <p className="mt-0.5 font-medium tabular-nums">Equity {usd(row.equity)}</p>
      {row.fills?.slice(0, 5).map((f) => (
        <p key={f.id} className="mt-1.5 leading-snug">
          <span className="font-semibold">{fillLabel(f)}</span>{" "}
          <span className="text-muted-foreground">
            {num(f.shares, 1)} {f.outcome ?? ""} @ {cents(f.avgPrice)} · {usd(f.notional)}
          </span>
          {f.realizedPnl !== null && (
            <span className="font-medium tabular-nums">
              {" "}
              ({usd(f.realizedPnl, { sign: true })})
            </span>
          )}
          <br />
          <span className="text-muted-foreground line-clamp-1">{f.title}</span>
        </p>
      ))}
      {(row.fills?.length ?? 0) > 5 && (
        <p className="text-muted-foreground mt-1">+{row.fills!.length - 5} more</p>
      )}
    </div>
  );
}

type DotProps = { cx?: number; cy?: number; value?: number | null; payload?: Row };

/**
 * Trade marker: a lettered badge ("B" buy, "S" sell / settlement). A sale isn't a loss,
 * so sells use a neutral color, not one that reads as red; the result is in the tooltip.
 * Hovered (`active`), the badge grows and gets an outline instead of a separate dot.
 */
const Badge = ({
  cx,
  cy,
  value,
  letter,
  fill,
  active,
}: DotProps & {
  letter: string;
  fill: string;
  active?: boolean;
}) => {
  if (value == null || cx == null || cy == null) return null;
  const r = active ? 9 : 7;
  return (
    <g pointerEvents="none">
      <rect
        x={cx - r}
        y={cy - r}
        width={r * 2}
        height={r * 2}
        rx={r * 0.45}
        fill={fill}
        stroke={active ? "var(--foreground)" : "var(--card)"}
        strokeWidth={active ? 2 : 1.5}
      />
      <text
        x={cx}
        y={cy}
        dy="0.35em"
        textAnchor="middle"
        fontSize={active ? 11 : 9}
        fontWeight={700}
        fill="#fff"
      >
        {letter}
      </text>
    </g>
  );
};
const BUY_FILL = "var(--series-3)";
const SELL_FILL = "var(--muted-foreground)";
const Buy = (p: DotProps) => <Badge {...p} letter="B" fill={BUY_FILL} />;
const Sell = (p: DotProps) => <Badge {...p} letter="S" fill={SELL_FILL} />;
const BuyActive = (p: DotProps) => <Badge {...p} letter="B" fill={BUY_FILL} active />;
const SellActive = (p: DotProps) => <Badge {...p} letter="S" fill={SELL_FILL} active />;
/** The equity line's hover dot, hidden on trade rows so it never covers the badge. */
const EquityDot = ({ cx, cy, payload }: DotProps) =>
  cx == null || cy == null || payload?.fills ? null : (
    <circle cx={cx} cy={cy} r={5} fill="var(--series-1)" stroke="var(--card)" strokeWidth={2} />
  );

const LegendBadge = ({ letter, fill }: { letter: string; fill: string }) => (
  <svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden>
    <rect x={-6} y={-6} width={12} height={12} rx={2.7} fill={fill} />
    <text dy="0.35em" textAnchor="middle" fontSize={9} fontWeight={700} fill="#fff">
      {letter}
    </text>
  </svg>
);

export function EquityChart({
  curve,
  fills,
  baseline,
  height = 280,
}: {
  curve: EquityPoint[];
  fills: FillMarker[];
  baseline?: number;
  height?: number;
}) {
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("all");
  const all = useMemo(() => buildRows(curve, fills), [curve, fills]);
  const rows = useMemo(() => {
    const r = RANGES.find((x) => x.key === range)!;
    if (!Number.isFinite(r.ms) || all.length === 0) return all;
    const end = all.at(-1)!.ts;
    const cut = all.filter((x) => x.ts >= end - r.ms);
    return cut.length >= 2 ? cut : all.slice(-2);
  }, [all, range]);
  const min = rows[0]?.ts ?? 0;
  const max = rows.at(-1)?.ts ?? 0;
  const plotRef = useRef<HTMLDivElement>(null);
  const zoom = useChartZoom(plotRef, {
    min,
    max,
    // Down to 1/200th of the range, but never under 5 minutes.
    minSpan: Math.max((max - min) / 200, 5 * 60_000),
    inset: { left: 60, right: 8 },
  });
  // Zoomed: the points inside the window plus the line's value at each edge, so the line
  // runs edge to edge and the y-axis fits only what is visible.
  const view = useMemo(() => {
    if (!zoom.zoomed) return rows;
    const inside = rows.filter((r) => r.ts > zoom.lo && r.ts < zoom.hi);
    return [
      { ts: zoom.lo, equity: equityAt(rows, zoom.lo) },
      ...inside,
      { ts: zoom.hi, equity: equityAt(rows, zoom.hi) },
    ];
  }, [rows, zoom.zoomed, zoom.lo, zoom.hi]);
  const span = zoom.hi - zoom.lo;
  const buys = view.reduce((a, r) => a + (r.buy !== undefined ? r.fills!.length : 0), 0);
  const sells = view.reduce((a, r) => a + (r.sell !== undefined ? r.fills!.length : 0), 0);

  return (
    <figure className="w-full">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <figcaption className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-0.5 w-4 rounded"
              style={{ background: "var(--series-1)" }}
            />
            Equity
          </span>
          <span className="flex items-center gap-1.5">
            <LegendBadge letter="B" fill={BUY_FILL} />
            Buy ({buys})
          </span>
          <span className="flex items-center gap-1.5">
            <LegendBadge letter="S" fill={SELL_FILL} />
            Sell / settled ({sells})
          </span>
        </figcaption>
        <div className="flex items-center gap-2">
          <ZoomControls zoom={zoom} />
          <div
            className="bg-muted flex gap-0.5 rounded-md p-0.5"
            role="group"
            aria-label="Time range"
          >
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => {
                  setRange(r.key);
                  zoom.reset();
                }}
                aria-pressed={range === r.key}
                className={cn(
                  "rounded px-2.5 py-2 text-xs font-medium transition-colors sm:py-1",
                  range === r.key
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div ref={plotRef} className={zoomSurface(zoom)} style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={view} margin={{ top: 10, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="ts"
              type="number"
              scale="time"
              domain={[zoom.lo, zoom.hi]}
              allowDataOverflow
              tickFormatter={(v: number) => fmtTime(v, span)}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              tickFormatter={(v: number) => usd(v, { compact: true })}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={60}
              domain={["auto", "auto"]}
            />
            <Tooltip
              cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1, strokeDasharray: "3 3" }}
              content={(props) => <Tip {...props} />}
            />
            {baseline !== undefined && (
              <ReferenceLine
                y={baseline}
                stroke="var(--muted-foreground)"
                strokeDasharray="4 4"
                strokeWidth={1}
                label={{
                  value: "Start",
                  position: "insideTopLeft",
                  fill: "var(--muted-foreground)",
                  fontSize: 11,
                }}
              />
            )}
            <Line
              type="monotone"
              dataKey="equity"
              name="Equity"
              stroke="var(--series-1)"
              strokeWidth={2}
              dot={false}
              activeDot={<EquityDot />}
              isAnimationActive={false}
            />
            <Line
              dataKey="buy"
              name="Buy"
              stroke="none"
              dot={<Buy />}
              activeDot={<BuyActive />}
              isAnimationActive={false}
              legendType="none"
            />
            <Line
              dataKey="sell"
              name="Sell"
              stroke="none"
              dot={<Sell />}
              activeDot={<SellActive />}
              isAnimationActive={false}
              legendType="none"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {max > min && <ZoomHint />}
      <EquityTable rows={all} />
    </figure>
  );
}

/** Newest first: equity at each snapshot, the change since the one before, and trades. */
function EquityTable({ rows }: { rows: Row[] }) {
  const table = useMemo(() => {
    const out: Array<{
      ts: number;
      equity: number;
      change: number | null;
      buys: number;
      sells: number;
      realized: number;
    }> = [];
    let prev: number | null = null;
    let buys = 0;
    let sells = 0;
    let realized = 0;
    for (const r of rows) {
      if (r.fills) {
        for (const f of r.fills) {
          if (isBuy(f)) buys++;
          else sells++;
          realized += f.realizedPnl ?? 0;
        }
        continue;
      }
      out.push({
        ts: r.ts,
        equity: r.equity,
        change: prev === null ? null : r.equity - prev,
        buys,
        sells,
        realized,
      });
      prev = r.equity;
      buys = 0;
      sells = 0;
      realized = 0;
    }
    return out.reverse();
  }, [rows]);
  if (table.length === 0) return null;
  return (
    <details className="mt-3 text-xs">
      <summary className="text-muted-foreground hover:text-foreground cursor-pointer">
        Show data table ({table.length} snapshots)
      </summary>
      <p className="text-muted-foreground mt-2">
        Equity = cash + open positions at the midpoint price (selling now would usually get a bit
        less). Each row is one snapshot; “Change” is since the row below it, and “Trades” counts
        what happened in between.
      </p>
      <div className="mt-2 max-h-72 overflow-auto rounded-md border">
        <table className="w-full text-left tabular-nums">
          <thead className="bg-muted/80 sticky top-0 backdrop-blur">
            <tr>
              <th className="px-2.5 py-1.5 font-medium">When</th>
              <th className="px-2.5 py-1.5 text-right font-medium">Equity</th>
              <th className="px-2.5 py-1.5 text-right font-medium">Change</th>
              <th className="px-2.5 py-1.5 text-right font-medium">Trades</th>
            </tr>
          </thead>
          <tbody>
            {table.map((r) => (
              <tr key={r.ts} className="border-t">
                <td className="px-2.5 py-1.5 whitespace-nowrap">{fmtFull(r.ts)}</td>
                <td className="px-2.5 py-1.5 text-right">{usd(r.equity)}</td>
                <td
                  className={cn(
                    "px-2.5 py-1.5 text-right",
                    r.change !== null && r.change > 0.005 && "text-gain",
                    r.change !== null && r.change < -0.005 && "text-loss",
                  )}
                >
                  {r.change === null ? "—" : usd(r.change, { sign: true })}
                </td>
                <td className="text-muted-foreground px-2.5 py-1.5 text-right whitespace-nowrap">
                  {r.buys + r.sells === 0
                    ? "—"
                    : [
                        r.buys && `${r.buys} buy${r.buys > 1 ? "s" : ""}`,
                        r.sells && `${r.sells} sell${r.sells > 1 ? "s" : ""}`,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
