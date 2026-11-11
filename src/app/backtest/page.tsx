import { cn } from "cn";
import { CircleCheck, CircleX, FlaskConical, TriangleAlert } from "lucide-react";
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
import { dateLabel, num, pct, timeAgo } from "@/lib/format";
import type { MonthInProgress } from "@/lib/jobs/backtest";
import { getBacktests } from "@/lib/queries";
import {
  MIN_RECORDED_MONTHS,
  recordedVerdict,
  THIN_MONTH_PICKS,
  type BacktestMonth,
  type BacktestResult,
  type MethodResult,
  type Verdict,
} from "@/lib/scoring/backtest";
import { mean } from "@/lib/scoring/stats";

export const metadata: Metadata = { title: "Backtest" };

export default function BacktestPage() {
  return (
    <>
      <PageHeader
        title="Backtest"
        description="Does picking traders this way make money when you copy them, compared with simply copying last month's top earners? The answer that counts comes from picks saved at the start of each month and followed forward, copied with slippage and Polymarket's taker fee. A hindsight simulation is shown below it for context only."
      />
      <Suspense fallback={<Skeleton className="h-[500px] rounded-xl" />}>
        <BacktestContent />
      </Suspense>
    </>
  );
}

type Summary = BacktestResult["summary"] & {
  months: BacktestMonth[];
  /** The current month's saved picks so far (provisional); runs before it had none. */
  inProgress?: MonthInProgress | null;
};

/** "2026-11" → "November 2026". */
const monthName = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
/** "2026-11" → "December 1": when that month's result is final. */
const finalOn = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
};
const signed = (x: number | null) => (x === null ? "—" : pct(x, 1, { sign: true }));

async function BacktestContent() {
  await connection();
  const runs = await getBacktests(1);
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
  const verdict = recordedVerdict(s.months);
  const recorded = s.months.filter((m) => m.recorded);
  const simulated = s.months.filter((m) => !m.recorded);

  return (
    <div className="space-y-4 sm:space-y-6">
      <VerdictCard verdict={verdict} inProgress={s.inProgress ?? null} />
      {s.inProgress && <InProgressCard p={s.inProgress} />}
      {recorded.length > 0 && (
        <MonthsCard
          title="Months with saved picks"
          description="Picks saved at the start of the month and followed forward: the record that counts."
          months={recorded}
        />
      )}
      <Simulation
        months={simulated}
        traders={params.traders}
        ranAt={run.createdAt}
        topK={params.topK ?? 10}
      />
    </div>
  );
}

/** The plain-language answer, from saved-pick months only (recordedVerdict). */
function VerdictCard({
  verdict: v,
  inProgress,
}: {
  verdict: Verdict;
  inProgress: MonthInProgress | null;
}) {
  const range =
    v.low !== null && v.high !== null ? ` (90% range ${signed(v.low)} to ${signed(v.high)})` : "";
  const good = v.kind === "ahead";
  const bad = v.kind === "behind";
  const Icon = good ? CircleCheck : bad ? CircleX : TriangleAlert;
  const title =
    v.kind === "none"
      ? "No verdict yet: no finished month of saved picks"
      : v.kind === "too_early"
        ? `Too early to judge: ${v.months} finished month${v.months === 1 ? "" : "s"} of saved picks`
        : good
          ? `Picked traders beat the top earners over ${v.months} months`
          : bad
            ? `Picked traders trailed the top earners over ${v.months} months`
            : `No clear difference yet over ${v.months} months`;
  return (
    <div className="bg-card flex gap-3 rounded-xl border p-4 text-sm">
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          good ? "text-yes" : bad ? "text-no" : "text-amber-500",
        )}
        aria-hidden
      />
      <div className="text-muted-foreground space-y-1.5">
        <p className="text-foreground font-medium">{title}</p>
        {v.kind === "none" ? (
          <p>
            Only picks saved at the time, then followed forward, show whether the method works.
            {inProgress
              ? ` ${monthName(inProgress.month)} is the first month with saved picks; it becomes a result on ${finalOn(inProgress.month)}.`
              : " Each month's picks are saved on its first daily run."}{" "}
            The hindsight simulation below can&apos;t answer the question.
          </p>
        ) : (
          <p>
            On average the strategy made {signed(v.meanGap)} a month more than copying last
            month&apos;s top earners{range}.{" "}
            {v.kind === "too_early"
              ? `Months swing a lot: the record needs at least ${MIN_RECORDED_MONTHS} finished months before this means much.`
              : v.kind === "unclear"
                ? "The range includes zero, so the difference could be luck."
                : "The range leaves out zero, so it's unlikely to be luck alone."}
          </p>
        )}
        {v.thinMonths > 0 && (
          <p>
            {v.thinMonths} of these months had fewer than {THIN_MONTH_PICKS} picked traders, so they
            mostly reflect one trader&apos;s luck.
          </p>
        )}
      </div>
    </div>
  );
}

function InProgressCard({ p }: { p: MonthInProgress }) {
  const since = new Date(p.from * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const side = (label: string, r: MethodResult) => (
    <div className="bg-muted/50 rounded-lg p-3">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">
        {r.ret === null ? "—" : <Signed value={r.ret}>{signed(r.ret)}</Signed>}
      </p>
      <p className="text-muted-foreground text-xs">
        {r.picks} trader{r.picks === 1 ? "" : "s"} · {r.bets} bets copied
        {r.partial > 0 && ` · ${r.partial} left out (too much activity to rebuild)`}
      </p>
    </div>
  );
  return (
    <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
      <CardHeader className="px-4 sm:px-6">
        <CardTitle>{monthName(p.month)} so far</CardTitle>
        <CardDescription>
          Provisional. The picks saved on {since}, copied from then on with slippage and fees; bets
          still open are valued at today&apos;s prices. Updated by each daily run, final on{" "}
          {finalOn(p.month)}.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 px-4 sm:grid-cols-2 sm:px-6">
        {side("Picked traders", p.strategy)}
        {side("Top earners (baseline)", p.baseline)}
      </CardContent>
    </Card>
  );
}

/** "2026-05" → "2026-06". */
const nextMonth = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7);
};

/**
 * Compounded growth over the given months, from $1,000. Each point is the value at the
 * start of a month: $1,000 at the first month's start, then after each month at the next.
 */
function growth(months: BacktestMonth[]) {
  let s = 1000;
  let b = 1000;
  return [
    { t: months[0]?.month ?? "", strategy: s, baseline: b },
    ...months.map((m) => {
      s *= 1 + m.strategyReturn;
      b *= 1 + m.baselineReturn;
      return {
        t: nextMonth(m.month),
        strategy: Math.round(s * 100) / 100,
        baseline: Math.round(b * 100) / 100,
      };
    }),
  ];
}

function Simulation({
  months,
  traders,
  ranAt,
  topK,
}: {
  months: BacktestMonth[];
  traders?: number;
  ranAt: Date;
  topK: number;
}) {
  if (months.length === 0) return null;
  const curve = growth(months);
  const last = curve.at(-1)!;
  const thin = months.filter((m) => m.strategyPicks.length < THIN_MONTH_PICKS).length;
  return (
    <section className="space-y-4 sm:space-y-6" aria-labelledby="simulation">
      <div>
        <h2 id="simulation" className="text-lg font-semibold tracking-tight">
          Hindsight simulation
        </h2>
        <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
          Not evidence. Each past month&apos;s picks are re-derived from the traders whose history
          is stored today ({traders ?? "?"}), and stored history is mostly traders who pass the
          checks today, so the picks lean on hindsight. That alone can swing the result by hundreds
          of points: in one check the same months gave the strategy +593% or +215% depending only on
          which stored traders were included. Run {timeAgo(ranAt)}.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-4">
        <StatTile
          label="Strategy (simulated)"
          value={pct(last.strategy / 1000 - 1, 1, { sign: true })}
          hint={`${months.length} months`}
        />
        <StatTile
          label="Baseline (simulated)"
          value={pct(last.baseline / 1000 - 1, 1, { sign: true })}
          hint="last month's top earners"
        />
        <StatTile
          label="Avg. traders picked"
          value={num(mean(months.map((m) => m.strategyPicks.length)), 1)}
          hint={`of up to ${topK}`}
        />
        <StatTile
          label="Thin months"
          value={`${thin} / ${months.length}`}
          hint={`under ${THIN_MONTH_PICKS} traders: one trader's luck`}
        />
      </div>
      <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
        <CardHeader className="px-4 sm:px-6">
          <CardTitle>Growth of $1,000 (simulated)</CardTitle>
          <CardDescription>Re-derived picks, compounded month by month</CardDescription>
        </CardHeader>
        <CardContent className="px-4 sm:px-6">
          <LineChart
            data={curve}
            series={[
              { key: "strategy", label: "Picked traders", color: "var(--series-1)" },
              { key: "baseline", label: "Top earners", color: "var(--series-2)" },
            ]}
            baseline={1000}
          />
        </CardContent>
      </Card>
      <MonthsCard title="Simulated months" months={months} />
    </section>
  );
}

function MonthsCard({
  title,
  description,
  months,
}: {
  title: string;
  description?: string;
  months: BacktestMonth[];
}) {
  return (
    <Card className="gap-4 py-4 sm:gap-6 sm:py-6">
      <CardHeader className="px-4 sm:px-6">
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="px-3 sm:px-6">
        {/* Fits a 320px phone: smaller text there. */}
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
            {months.map((m) => {
              const n = m.strategyPicks.length;
              return (
                <TableRow key={m.month}>
                  <TableCell>{dateLabel(m.month)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {n === 0 ? (
                      "cash"
                    ) : (
                      <span
                        className={n < THIN_MONTH_PICKS ? "text-amber-600 dark:text-amber-400" : ""}
                        title={
                          n < THIN_MONTH_PICKS ? "Under 3 traders: mostly one trader's luck" : ""
                        }
                      >
                        {n}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums sm:table-cell">
                    {m.strategyBets}
                  </TableCell>
                  <TableCell className="text-right">
                    <Signed value={m.strategyReturn}>{signed(m.strategyReturn)}</Signed>
                  </TableCell>
                  <TableCell className="text-right">
                    <Signed value={m.baselineReturn}>{signed(m.baselineReturn)}</Signed>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {months.some(
          (m) => m.strategyPicks.length > 0 && m.strategyPicks.length < THIN_MONTH_PICKS,
        ) && (
          <p className="text-muted-foreground mt-3 text-xs">
            <span className="text-amber-600 dark:text-amber-400">Amber</span> = under{" "}
            {THIN_MONTH_PICKS} traders picked: that month mostly reflects one trader&apos;s luck.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
