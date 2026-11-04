# MoneyMaker

Find prediction-market traders who win **consistently** (not one lucky bet), then copy them
with fake money first to prove it works.

- **Signals:** Polymarket's public data. Every wallet's trades and P&L are visible there.
  Kalshi hides who made each trade, so Kalshi traders can't be followed.
- **Phase 1 (this repo):** discover → verify → backtest → paper-trade → dashboards.
- **Phase 2 (later):** real orders on US-legal venues (Kalshi or Polymarket US), only after
  the paper results hold up.

> Paper trading only. Nothing here guarantees profit. Copy delay, leaders exiting, and price
> differences between venues all eat into returns.

## How traders get verified

The daily job pulls Polymarket's leaderboards (week / month / all-time × categories). It
downloads each candidate's full position history and runs 16 checks:

| Question            | Check                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real skill or luck? | Wins vs. the win rate their entry prices implied (z-score), plus a Monte Carlo test that re-draws every outcome at random. It's corrected for testing hundreds of traders at once (Benjamini–Hochberg). |
| One-hit wonder?     | Biggest single win ≤ 25% of all profits, top 3 ≤ 50%                                                                                                                                                    |
| Consistent?         | ≥ 60% profitable months, profit ≥ 2× worst drawdown, ≥ 50 markets across ≥ 25 events                                                                                                                    |
| Copyable?           | Still profitable when copied 2 minutes late with slippage; not a bot or market maker; holds long enough                                                                                                 |
| Still good?         | Profitable in the last 60 days, traded in the last 14 days                                                                                                                                              |

Traders who pass everything are **Verified** (or **Elite** when the score is ≥ 70). Near
misses go on the **Watchlist**. Each trader's page shows every check and why it passed or
failed. All thresholds can be changed in **Settings**.

A walk-forward **backtest** asks: "if I had picked traders this way each month, using only
what was known then, how would copying them have done?" It compares against simply copying
last month's top earners.

## How copying works (paper)

Copying fast comes first. The server runs the engine itself (`src/instrumentation.ts`):

1. **Real-time feed:** Polymarket's live trade stream delivers a followed trader's trade
   ~25 ms after it happens (the Data API takes ~15 s), so copies land within seconds.
2. **Checks every 15, 30 or 60 s** (Settings → Speed) poll every trader as a safety net,
   re-check trades skipped because the price ran away, settle resolved markets at $1 or $0,
   mark prices, auto-hedge (if on) and snapshot equity.
3. Each trade passes the risk rules (price moved too much? market ending? daily loss limit?
   caps?), then fills against the **live order book** (real slippage). Pieces of one order
   are combined first, so sizing and the "too small" filter see the whole order.
4. Sells are mirrored proportionally (and any hedge is sold with them).

`/api/cron/tick` (cron-job.org, every minute) keeps the free instance awake and runs a tick
itself if the loop ever stalls. Set `ENGINE_LOOP=off` to rely on cron alone.

Every decision, including skips, is logged on the **Live** page. Hover or tap a reason for
the full explanation with the exact prices and limits involved.

**Hedging ("cancel out"):** any open copy can be hedged from its position page by buying
the other outcome: _lock in_ (the loss stops growing) or _break even if it flips_. Auto-hedge
can do this when a copy is down a set amount, within a cost cap.

**Access:** visitors can view everything but change nothing. The admin password unlocks
following, hiding ("No"), hedging, settings and resets; every server action re-checks it,
and wrong passwords are rate-limited.

## Architecture (all free)

```
GitHub Actions (daily)  ──► discover → backfill → score → backtest ──► Supabase Postgres
cron-job.org (1/min)    ──► Render free web service: Next.js dashboards + /api/cron/tick ──┘
```

**Stack:** Next.js 16, TypeScript, Tailwind v4 + shadcn/ui, Drizzle ORM, Zod, Recharts,
Vitest. Locally the app uses an embedded Postgres (PGlite), so no database setup is needed.

## Run it locally

Requires Node 22+.

```bash
npm install
npm run db:migrate                       # creates the local database in .data/
npm run job -- daily --limit 25          # find + score 25 traders (~4 min)
npm run dev                              # http://localhost:3000
```

Other commands:

```bash
npm run job -- follow 0xWALLET           # paper-copy a trader
npm run job -- tick                      # run one copy-engine tick by hand
npm run job -- backtest --months 6 --top 10
npm run check                            # typecheck + lint + format + tests
npm run smoke:polymarket                 # live API sanity check
```

> The local database is a single-process file. Stop `npm run dev` before running `npm run job`,
> or the job can't open it.

## Deploy (about 15 minutes, $0)

1. **GitHub:** create a private repo, then push:
   ```bash
   brew install gh && gh auth login
   gh repo create moneymaker --private --source=. --push
   ```
2. **Supabase** (database): create a free project at <https://supabase.com>. Go to
   **Project Settings → Database → Connection string → Session pooler** and copy the URL.
   Use port **5432** (it works over IPv4, which Render and GitHub need).
3. **GitHub secret:** repo → Settings → Secrets and variables → Actions → New secret:
   `DATABASE_URL` = the Supabase URL. Then open **Actions → Daily trader scoring →
   Run workflow** to fill the database (about 15–30 min the first time).
4. **Render** (website): <https://render.com> → **New → Blueprint** → pick the repo. Paste
   `DATABASE_URL` and choose an `ADMIN_PASSWORD`. `CRON_SECRET` is generated for you. Copy
   it from the service's **Environment** tab.
5. **cron-job.org** (heartbeat): create a free account, then a job:
   - URL: `https://<your-app>.onrender.com/api/cron/tick`
   - Schedule: every 1 minute
   - Advanced → Headers: `Authorization: Bearer <CRON_SECRET>`

   This runs the copy engine and keeps the free Render instance awake.

6. Open your Render URL → **Settings** → unlock with your password → follow traders.

### Free-tier notes

- Render free: 750 hours per month covers one always-on service. The instance may restart at
  any time; nothing is lost because all state lives in Supabase.
- Supabase free: 500 MB. The daily job caps candidates at 150 and prunes rejected traders to
  stay well under that. It pauses only after 7 days with no activity, which the 1-minute
  tick prevents.
- GitHub Actions: a private repo gets 2,000 free minutes per month; the daily job uses about
  15–30. Scheduled workflows in _public_ repos switch off after 60 days without commits.

## Project layout

```
src/lib/polymarket/   API clients (Data API v2, Gamma, CLOB), validated with Zod
src/lib/scoring/      metrics, checks, composite score, walk-forward backtest (pure)
src/lib/jobs/         discover, backfill, score, backtest jobs (DB + API)
src/lib/copy/         copy engine: decisions, sizing, fill simulator, account, tick
src/app/              pages + /api/cron/tick + /api/health + server actions
drizzle/              SQL migrations (npm run db:generate after editing schema.ts)
tests/                unit + integration tests (in-memory Postgres, mocked APIs)
```

## Data notes (verified against the live API, Nov 2026)

- Polymarket Data API **v1 was retired 2026-11-02**. Everything here uses `/v2`.
- Losing positions that were never redeemed stay under `OPEN/REDEEMABLE`, not `CLOSED`.
  Both lists are fetched, or losses would be hidden.
- The positions endpoint sorts by **largest profit first** by default. Capped fetches must use
  `sort_by=TIMESTAMP`, or only a trader's best bets get counted.
- Gamma `/markets/keyset` returns only open markets unless `closed=true` is passed.
