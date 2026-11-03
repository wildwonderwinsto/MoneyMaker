/**
 * Live smoke test against the public Polymarket APIs (no DB needed):
 *   npm run smoke:polymarket
 */
import { getBook, getMidpoints, getPriceHistory } from "@/lib/polymarket/clob";
import {
  getActivity,
  getLeaderboard,
  getPortfolioValue,
  getPositions,
  getUserPnl,
  getUserStats,
} from "@/lib/polymarket/data";
import { getMarketsByConditionIds, winnerIndex } from "@/lib/polymarket/gamma";

async function main() {
  const lb = await getLeaderboard({ timePeriod: "month", sortBy: "PNL", limit: 5 });
  console.log(
    "leaderboard:",
    lb.data.map((e) => `${e.rank}. ${e.user_name ?? e.user_id} $${e.pnl.toFixed(0)}`),
  );
  const wallet = lb.data[0].user_id;

  const [closed, open, activity, pnl, stats, value] = await Promise.all([
    getPositions({ user: wallet, status: "CLOSED", limit: 20 }),
    getPositions({ user: wallet, status: "OPEN", limit: 20 }),
    getActivity({ user: wallet, type: "TRADE", limit: 5 }),
    getUserPnl({ user: wallet }),
    getUserStats(wallet),
    getPortfolioValue(wallet),
  ]);
  console.log({
    wallet,
    closedPositions: closed.data.length,
    openPositions: open.data.length,
    recentTrades: activity.data.length,
    pnlPoints: pnl.length,
    distinctMarkets: stats?.trades,
    tradeCount: stats?.all_time_pnl?.trade_count,
    portfolioValue: value,
  });

  const conditionIds = closed.data.slice(0, 5).map((p) => p.condition_id);
  const markets = await getMarketsByConditionIds(conditionIds);
  console.log(
    "markets:",
    markets.map((m) => `${m.question.slice(0, 50)} closed=${m.closed} winner=${winnerIndex(m)}`),
  );

  const token = open.data[0]?.token_id ?? markets[0]?.clobTokenIds[0];
  if (token) {
    const [book, mids, history] = await Promise.all([
      getBook(token),
      getMidpoints([token]),
      getPriceHistory(token, { interval: "1d", fidelity: 5 }),
    ]);
    console.log({
      bestBid: book.bids[0],
      bestAsk: book.asks[0],
      mid: mids.get(token),
      historyPoints: history.length,
    });
  }
  console.log("OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
