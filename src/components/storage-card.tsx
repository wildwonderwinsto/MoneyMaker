/**
 * Supabase database storage: how full the free plan is and which tables use the space.
 * - Headline number + meter (fill carries state: accent → warning → danger, with an icon
 *   and label so state never relies on color alone).
 * - Ranked single-hue bars per table, direct-labeled with size and row count; the rest
 *   fold into "Everything else". Hover a row for data vs. index split.
 */
import { cn } from "cn";
import { AlertTriangle, CheckCircle2, Database, OctagonAlert } from "lucide-react";

import { StartOver } from "@/components/start-over";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { bytes, num, pct } from "@/lib/format";
import type { StorageStats } from "@/lib/queries";

const TOP = 6;

const LABELS: Record<string, [string, string]> = {
  trader_trades: ["Trader trades", "No longer written (nothing read it); empty after cleanup"],
  trader_positions: ["Trader positions", "Open and closed positions per trader"],
  leaderboard_snapshots: ["Leaderboard history", "Daily leaderboard snapshots (kept 90 days)"],
  signals: ["Signals", "Every followed trade the engine saw, with its decision"],
  markets: ["Markets", "Cached market details and results"],
  trader_pnl_daily: ["Daily trader P&L", "Profit per trader per day"],
  trader_scores: ["Trader scores", "Daily verification results"],
  traders: ["Traders", "Profiles of discovered traders"],
  equity_snapshots: ["Equity history", "Paper equity every 5 minutes"],
  paper_fills: ["Paper fills", "Simulated buys, sells and settlements"],
  paper_positions: ["Paper positions", "Copied positions"],
  backtest_runs: ["Backtests", "Saved backtest results"],
  monthly_selections: ["Monthly picks", "Traders selected each month"],
  job_runs: ["Job runs", "Background job history"],
};
const labelOf = (name: string) =>
  LABELS[name] ?? [name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), null];

function level(used: number) {
  if (used >= 0.9)
    return {
      label: "Almost full",
      icon: OctagonAlert,
      fill: "bg-no",
      text: "text-no",
      track: "bg-no/15",
      note: "Supabase makes the database read-only at the limit. Lower the retention windows or upgrade the plan.",
    };
  if (used >= 0.7)
    return {
      label: "Getting full",
      icon: AlertTriangle,
      fill: "bg-amber-500",
      text: "text-amber-600 dark:text-amber-400",
      track: "bg-amber-500/15",
      note: "Old trades and leaderboard history are pruned daily; if it keeps growing, shorten those windows.",
    };
  return {
    label: "Plenty of room",
    icon: CheckCircle2,
    fill: "bg-series-1",
    text: "text-yes",
    track: "bg-series-1/15",
    note: "Old trades and leaderboard history are pruned daily, so usage levels off over time.",
  };
}

export function StorageCard({ stats }: { stats: StorageStats }) {
  const used = stats.limit > 0 ? stats.bytes / stats.limit : 0;
  const lv = level(used);
  const Icon = lv.icon;
  const top = stats.tables.slice(0, TOP);
  const rest = stats.tables.slice(TOP);
  const restBytes = rest.reduce((a, t) => a + t.bytes, 0) + stats.otherBytes;
  const rows = [
    ...top.map((t) => {
      const [label, help] = labelOf(t.name);
      return {
        key: t.name,
        label,
        help,
        bytes: t.bytes,
        detail: `${num(t.rows)} rows`,
        hover: `${t.name}: ${bytes(t.bytes - t.indexBytes)} data + ${bytes(t.indexBytes)} indexes`,
      };
    }),
    ...(restBytes > 0
      ? [
          {
            key: "_rest",
            label: "Everything else",
            help: `${rest.length} smaller table${rest.length === 1 ? "" : "s"} and Postgres system data`,
            bytes: restBytes,
            detail: null,
            hover: `${bytes(restBytes - stats.otherBytes)} in small tables + ${bytes(stats.otherBytes)} system`,
          },
        ]
      : []),
  ];
  const max = Math.max(1, ...rows.map((r) => r.bytes));

  return (
    <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
      <CardHeader className="px-4 sm:px-6">
        <CardTitle className="flex items-center gap-2">
          <Database className="size-4" aria-hidden /> Database storage
        </CardTitle>
        <CardDescription>
          Supabase free plan: {bytes(stats.limit)} per project. {lv.note}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 px-4 sm:px-6">
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
            <p className="tabular-nums">
              <span className="text-2xl font-semibold tracking-tight sm:text-3xl">
                {bytes(stats.bytes)}
              </span>
              <span className="text-muted-foreground ml-1.5 text-sm">
                of {bytes(stats.limit)} used
              </span>
            </p>
            <p className="flex items-center gap-1.5 text-sm">
              <Icon className={cn("size-4", lv.text)} aria-hidden />
              <span className="font-medium">{lv.label}</span>
              <span className="text-muted-foreground tabular-nums">
                · {pct(used, used < 0.1 ? 1 : 0)} · {bytes(Math.max(0, stats.limit - stats.bytes))}{" "}
                free
              </span>
            </p>
          </div>
          <div
            role="meter"
            aria-label="Database storage used"
            aria-valuemin={0}
            aria-valuemax={stats.limit}
            aria-valuenow={stats.bytes}
            aria-valuetext={`${bytes(stats.bytes)} of ${bytes(stats.limit)} (${pct(used, 1)})`}
            className={cn("h-2 w-full overflow-hidden rounded-full", lv.track)}
          >
            <div
              className={cn("h-full rounded-full transition-[width]", lv.fill)}
              style={{ width: `${Math.min(100, Math.max(used > 0 ? 0.75 : 0, used * 100))}%` }}
            />
          </div>
        </div>

        <div>
          <p className="text-muted-foreground mb-3 text-xs font-medium tracking-wide uppercase">
            Biggest tables
          </p>
          <ul className="space-y-3.5">
            {rows.map((r) => (
              <li key={r.key} title={r.hover} className="group">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium">{r.label}</span>
                    {r.help && (
                      <span className="text-muted-foreground hidden text-xs sm:inline">
                        {" "}
                        · {r.help}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {bytes(r.bytes)}
                    {r.detail && (
                      <span className="text-muted-foreground ml-1.5 text-xs">{r.detail}</span>
                    )}
                  </span>
                </div>
                <div className="bg-muted mt-1.5 h-1.5 w-full rounded-r-[4px]">
                  <div
                    className={cn(
                      "h-full rounded-r-[4px] transition-opacity group-hover:opacity-80",
                      r.key === "_rest" ? "bg-muted-foreground/40" : "bg-series-1",
                    )}
                    style={{ width: `${Math.max(0.5, (r.bytes / max) * 100)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
        {/* Only admins see this card (visitors get job status only). */}
        <StartOver />
      </CardContent>
    </Card>
  );
}
