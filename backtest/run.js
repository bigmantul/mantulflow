// ═══════════════════════════════════════════════════════
//  backtest/run.js
//
//  PERSONAL RISK SETTINGS:
//  If backtest/my-risk-settings.js exists (copy it from
//  backtest/my-risk-settings.example.js and edit it with
//  YOUR dashboard values), it's loaded automatically and
//  used as the defaults below — no need to retype
//  --stake= --trailing= --duration= every run. CLI flags
//  still override individual values if passed.
//
//  Usage:
//    node backtest/run.js <SYMBOL> [--equity=1000] [--stake=1.00]
//      [--risk=0.02] [--trailing=0.5] [--duration=120]
//      [--cutoff=20] [--cooldown=2]
//
//  --stake    : FIXED dollar stake (matches db.js risk.stakeAmount
//               EXACTLY — production sizing, not % of equity).
//               Takes priority over --risk when both are set.
//  --risk     : fallback %-of-equity sizing, only used if --stake
//               is not set (production does not use this mode).
//  --trailing : trailingStopPct, fraction of TP that activates
//               trailing stop (default 0.5 = 50%, matches db.js
//               default). Set to 0 to disable.
//  --duration : contractDurationMins, forced close timer in
//               minutes (default 120 = 2hrs, matches db.js
//               default). Set to 0 to disable.
//  --cutoff   : noProfitCutoffMins, close a trade if it hasn't
//               reached profit within this many minutes of opening
//               (default 20, matches db.js default). Set to 0 to
//               disable this mechanism entirely.
//  --cooldown : cutoffCooldownHours, hours to lock a symbol out of
//               new entries after the no-profit cutoff fires
//               (default 2, matches db.js default). Set to 0 for
//               no cooldown lock at all.
//
//  Reads backtest/data/<SYMBOL>.json (produced either by
//  fetch-history.js / fetch-all-history.js against real
//  Deriv data, or by generate-sample-data.js for a synthetic
//  dry run) and prints a performance report.
// ═══════════════════════════════════════════════════════

import fs from "fs";
import path from "path";
import { runBacktest } from "./engine.js";

// ── LOAD PERSONAL RISK SETTINGS, IF PRESENT ──────────────
const myRiskPath = path.resolve("backtest/my-risk-settings.js");
let myRisk = {};
if (fs.existsSync(myRiskPath)) {
  const mod = await import(`file://${myRiskPath}`);
  myRisk = mod.default || {};
  console.log("Loaded personal risk settings from backtest/my-risk-settings.js");
}

function parseArgs(argv) {
  const symbol = argv[2];
  const opts = {};
  for (const arg of argv.slice(3)) {
    const m = arg.match(/^--([\w]+)=(.+)$/);
    if (m) opts[m[1]] = isNaN(Number(m[2])) ? m[2] : Number(m[2]);
  }
  return { symbol, opts };
}

const { symbol, opts: cliOpts } = parseArgs(process.argv);
const opts = { ...myRisk, ...cliOpts };

if (!symbol) {
  console.error("Usage: node backtest/run.js <SYMBOL> [--equity=1000] [--stake=1.00] [--risk=0.02] [--trailing=0.5] [--duration=120] [--cutoff=20] [--cooldown=2]");
  process.exit(1);
}

const dataPath = `backtest/data/${symbol}.json`;
if (!fs.existsSync(dataPath)) {
  console.error(`No data file at ${dataPath}.`);
  console.error(`Run either:`);
  console.error(`  node backtest/generate-sample-data.js ${symbol}   (synthetic dry run)`);
  console.error(`  node backtest/fetch-history.js ${symbol}          (real Deriv history)`);
  console.error(`  node backtest/fetch-all-history.js                (real Deriv history, ALL symbols)`);
  process.exit(1);
}

const { d1, h1, m15 } = JSON.parse(fs.readFileSync(dataPath, "utf8"));

const result = runBacktest({
  symbol,
  d1,
  h1,
  m15,
  startEquity: opts.equity ?? 1000,
  stakeAmount: opts.stake ?? opts.stakeAmount, // fixed dollar stake, matches production
  riskPct: opts.risk ?? 0.02,                   // fallback only, used if stakeAmount unset
  slPct: opts.sl ?? opts.stopLossPct ?? 0.80,
  tpPct: opts.tp ?? opts.takeProfitPct ?? 2.00,
  trailingStopPct: opts.trailing ?? opts.trailingStopPct ?? 0.5,
  contractDurationMins: opts.duration ?? opts.contractDurationMins ?? 120,
  noProfitCutoffMins: opts.cutoff ?? opts.noProfitCutoffMins ?? 20,
  cutoffCooldownHours: opts.cooldown ?? opts.cutoffCooldownHours ?? 2,
});

const stakeMode = (opts.stake ?? opts.stakeAmount) !== undefined
  ? `stakeAmount=$${opts.stake ?? opts.stakeAmount} (fixed, matches production)`
  : `riskPct=${opts.risk ?? 0.02} (% of equity, fallback mode)`;

console.log(`\n══════════════════════════════════════════`);
console.log(`  BACKTEST REPORT — ${result.symbol}`);
console.log(`══════════════════════════════════════════`);
console.log(`  Settings       : ${stakeMode}`);
console.log(`  No-Profit Cutoff: ${(opts.cutoff ?? opts.noProfitCutoffMins ?? 20) > 0 ? `${opts.cutoff ?? opts.noProfitCutoffMins ?? 20}min` : "OFF"}  Cooldown: ${(opts.cooldown ?? opts.cutoffCooldownHours ?? 2) > 0 ? `${opts.cooldown ?? opts.cutoffCooldownHours ?? 2}hr` : "OFF"}`);
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
