import { FlaskConical, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";

import { LineChart } from "@/components/charts/line-chart";
import { EmptyState, PageHeader, Signed, StatTile } from "@/components/common";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { num, pct, timeAgo } from "@/lib/format";
import { getBacktests } from "@/lib/queries";
import type { BacktestMonth, BacktestResult } from "@/lib/scoring/backtest";

export const metadata: Metadata = { title: "Backtest" };

export default function BacktestPage() {
  return (
    <>
      <PageHeader
        title="Backtest"
        description="Would the selection method have worked? Each month, traders are scored using only data available at the time. Then their next month of bets is copied, with slippage and Polymarket's taker fee. The comparison is against the naive approach: copying last month's top earners."
      />
      <Suspense fallback={<Skeleton className="h-[500px] rounded-xl" />}>
        <BacktestContent />
      </Suspense>
    </>
  );
}

type Summary = BacktestResult["summary"] & { months: BacktestMonth[] };

async function BacktestContent() {
  await connection();
  const runs = await getBacktests(10);
  const run = runs[0];
  if (!run) {
    return (
      <EmptyState title="No backtest yet" icon={FlaskConical}>
        It runs automatically after each daily scoring job, or with{" "}
        <code>npm run job -- backtest</code>.
      </EmptyState>
    );
  }
  const s = run.summary as unknown as Summary;
  const params = run.params as { months?: number; topK?: number; traders?: number };
  const byT = new Map(run.baselineCurve.map((p) => [p.t, p.equity]));
  const data = run.strategyCurve.map((p) => ({
    t: p.t.replace(/-end$/, ""),
    strategy: p.equity,
    baseline: byT.get(p.t) ?? 0,
  }));
  const cashMonths = s.months.filter((m) => m.strategyPicks.length === 0).length;
  const recordedMonths = s.recordedMonths ?? 0;
  // Recorded picks rebuilt from their own activity (#9); partial = the row cap cut the month.
  const pickMonths = s.recordedPickMonths ?? 0;
  const partialPickMonths = s.partialPickMonths ?? 0;

  return (
    <div className="space-y-4 sm:space-y-6">
      {cashMonths === s.months.length && (
        <div className="bg-card flex gap-3 rounded-xl border p-4 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" aria-label="Caution" />
          <div className="text-muted-foreground space-y-1">
            <p className="text-foreground font-medium">
              Not enough history to judge the method yet
            </p>
            <p>
              No trader passed every check using only what was known at the start of each month, so
              the strategy stayed in cash ({pct(0, 1)}). That doesn&apos;t mean it lost: most of
              today&apos;s top traders didn&apos;t yet have a record long enough to pass the sample
              size and luck checks. From now on each month&apos;s picks are recorded as they happen,
              so this page builds a real track record. Paper trading is the test in the meantime.
            </p>
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-4">
        <StatTile
          label="Strategy return"
          value={pct(s.strategyTotalReturn, 1, { sign: true })}
          tone={s.strategyTotalReturn >= 0 ? "gain" : "loss"}
          hint={`Max drawdown ${pct(s.strategyMaxDrawdown, 1)}`}
        />
        <StatTile
          label="Naive baseline"
          value={pct(s.baselineTotalReturn, 1, { sign: true })}
          tone={s.baselineTotalReturn >= 0 ? "gain" : "loss"}
          hint={`Max drawdown ${pct(s.baselineMaxDrawdown, 1)}`}
        />
        <StatTile
          label="Positive months"
          value={`${s.strategyPositiveMonths} / ${s.months.length}`}
          hint={`Baseline ${s.baselinePositiveMonths} / ${s.months.length}`}
        />
        <StatTile
          label="Avg. traders picked"
          value={num(s.avgStrategyPicks, 1)}
          hint={
            cashMonths
              ? `${cashMonths} month(s) in cash (nobody qualified)`
              : "of top " + (params.topK ?? 10)
          }
        />
      </div>

      <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
        <CardHeader className="px-4 sm:px-6">
          <CardTitle>Growth of $1,000</CardTitle>
          <CardDescription>
            Run {timeAgo(run.createdAt)} · {params.traders ?? "?"} traders · last{" "}
            {params.months ?? s.months.length} months
            {recordedMonths > 0 && ` · ${recordedMonths} recorded at the time`}
            {pickMonths > 0 &&
              ` · ${partialPickMonths} of ${pickMonths} recorded pick-months partial (${pct(partialPickMonths / pickMonths, 0)}, left out)`}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4 sm:px-6">
          <LineChart
            data={data}
            series={[
              { key: "strategy", label: "Verified traders", color: "var(--series-1)" },
              { key: "baseline", label: "Top earners", color: "var(--series-2)" },
            ]}
            baseline={1000}
          />
        </CardContent>
      </Card>

      <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
        <CardHeader className="px-4 sm:px-6">
          <CardTitle>Month by month</CardTitle>
        </CardHeader>
        <CardContent className="px-3 sm:px-6">
          {/* Fits a 320px phone: smaller text there, "recorded" under the month. */}
          <Table className="text-xs min-[360px]:text-sm">
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead className="text-right">
                  <span className="sm:hidden">Picked</span>
                  <span className="hidden sm:inline">Traders picked</span>
                </TableHead>
                <TableHead className="hidden text-right sm:table-cell">Bets copied</TableHead>
                <TableHead className="text-right">Strategy</TableHead>
                <TableHead className="text-right">Baseline</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.months.map((m) => (
                <TableRow key={m.month}>
                  <TableCell>
                    {m.month}
                    {m.recorded && (
                      <span className="text-muted-foreground block text-xs sm:inline">
                        <span className="hidden sm:inline"> · </span>recorded
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m.strategyPicks.length || "cash"}
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums sm:table-cell">
                    {m.strategyBets}
                  </TableCell>
                  <TableCell className="text-right">
                    <Signed value={m.strategyReturn}>
                      {pct(m.strategyReturn, 1, { sign: true })}
                    </Signed>
                  </TableCell>
                  <TableCell className="text-right">
                    <Signed value={m.baselineReturn}>
                      {pct(m.baselineReturn, 1, { sign: true })}
                    </Signed>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="bg-card flex gap-3 rounded-xl border p-4 text-sm">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" aria-label="Caution" />
        <div className="text-muted-foreground space-y-1">
          <p className="text-foreground font-medium">How to read this honestly</p>
          <p>
            For months not marked <em>recorded</em>, the traders tested come from{" "}
            <em>today&apos;s</em> leaderboards, so everyone in the pool is someone who survived
            (survivorship bias). That inflates both lines, and not necessarily equally, so even the
            gap between them is only a rough guide. Months marked <em>recorded</em> use the picks
            saved at the time (the top Verified traders and the month leaderboard&apos;s top
            earners, bots left out), rebuilt from their own activity once the month is over — free
            of survivorship in the picks, but still estimates (partial months left out, held shares
            valued at rebuild time, bets booked in the month opened). Paper trading forward is the
            real test.
          </p>
        </div>
      </div>
    </div>
  );
}
