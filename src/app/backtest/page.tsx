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

  return (
    <div className="space-y-4 sm:space-y-6">
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
        <CardContent className="px-4 sm:px-6">
          <Table>
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
                  <TableCell>{m.month}</TableCell>
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
            The traders tested come from <em>today&apos;s</em> leaderboards, so everyone in the pool
            is someone who survived (survivorship bias). That inflates both lines. The useful signal
            is the <strong>gap between the two lines</strong>, plus how often the strategy sat in
            cash because nobody passed. Paper trading forward is the real test.
          </p>
        </div>
      </div>
    </div>
  );
}
