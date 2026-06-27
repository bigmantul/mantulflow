// ═══════════════════════════════════════════════════════
//  backtest/run.js
//
//  Usage:
//    node backtest/run.js <SYMBOL> [--equity=1000] [--risk=0.02]
//
//  Reads backtest/data/<SYMBOL>.json (produced either by
//  fetch-history.js against real Deriv data, or by
//  generate-sample-data.js for a synthetic dry run) and
//  prints a performance report.
// ═══════════════════════════════════════════════════════

import fs from "fs";
import { runBacktest } from "./engine.js";

function parseArgs(argv) {
  const symbol = argv[2];
  const opts = {};
  for (const arg of argv.slice(3)) {
    const m = arg.match(/^--([\w]+)=(.+)$/);
    if (m) opts[m[1]] = isNaN(Number(m[2])) ? m[2] : Number(m[2]);
  }
  return { symbol, opts };
}

const { symbol, opts } = parseArgs(process.argv);

if (!symbol) {
  console.error("Usage: node backtest/run.js <SYMBOL> [--equity=1000] [--risk=0.02]");
  process.exit(1);
}

const dataPath = `backtest/data/${symbol}.json`;
if (!fs.existsSync(dataPath)) {
  console.error(`No data file at ${dataPath}.`);
  console.error(`Run either:`);
  console.error(`  node backtest/generate-sample-data.js ${symbol}   (synthetic dry run)`);
  console.error(`  node backtest/fetch-history.js ${symbol}          (real Deriv history)`);
  process.exit(1);
}

const { d1, h1, m15 } = JSON.parse(fs.readFileSync(dataPath, "utf8"));

const result = runBacktest({
  symbol,
  d1,
  h1,
  m15,
  startEquity: opts.equity ?? 1000,
  riskPct: opts.risk ?? 0.02,
  slPct: opts.sl ?? 0.80,
  tpPct: opts.tp ?? 2.00,
});

console.log(`\n══════════════════════════════════════════`);
console.log(`  BACKTEST REPORT — ${result.symbol}`);
console.log(`══════════════════════════════════════════`);
console.log(`  Start Equity   : $${result.startEquity.toFixed(2)}`);
console.log(`  Final Equity   : $${result.finalEquity.toFixed(2)}`);
console.log(`  Total Return   : ${result.totalReturnPct}%`);
console.log(`  Total Trades   : ${result.totalTrades}`);
console.log(`  Win Rate       : ${result.winRatePct}% (${result.wins}W / ${result.losses}L)`);
console.log(`  Profit Factor  : ${result.profitFactor}`);
console.log(`  Max Drawdown   : ${result.maxDrawdownPct}%`);
console.log(`  Avg Win/Loss   : $${result.avgWin} / $${result.avgLoss}`);
console.log(`══════════════════════════════════════════\n`);

fs.mkdirSync("backtest/results", { recursive: true });
const csvHeader = "symbol,direction,entry_time,entry_price,exit_time,exit_price,stake,multiplier,pnl,outcome,equity_after\n";
const csvRows = result.trades.map(t => [
  t.symbol, t.direction,
  new Date(t.entryEpoch * 1000).toISOString(), t.entryPrice,
  new Date(t.exitEpoch * 1000).toISOString(), t.exitPrice,
  t.stake, t.multiplier, t.pnl.toFixed(2), t.outcome, t.equityAfter.toFixed(2),
].join(",")).join("\n");
const csvPath = `backtest/results/${symbol}-trades.csv`;
fs.writeFileSync(csvPath, csvHeader + csvRows);
console.log(`Trade log written to ${csvPath}`);
