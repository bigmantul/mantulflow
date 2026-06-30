// ═══════════════════════════════════════════════════════
//  backtest/run-all.js
//
//  Runs the backtest across every symbol in SYMBOLS (the
//  exact same list src/index.js scans in production — see
//  src/config/symbols.js). For each symbol:
//    - uses backtest/data/<symbol>.json if present (real
//      data from fetch-history.js / fetch-all-history.js)
//    - otherwise auto-generates synthetic data so the full
//      scan can still be dry-run end-to-end
//
//  PERSONAL RISK SETTINGS:
//  If backtest/my-risk-settings.js exists (copy it from
//  backtest/my-risk-settings.example.js and edit it with
//  YOUR dashboard values), it's loaded automatically and
//  used as the defaults for every option below — no need
//  to retype --stake= --trailing= --duration= every run.
//  CLI flags still override individual values if passed.
//
//  Usage:
//    node backtest/run-all.js [--days=365] [--equity=1000]
//      [--stake=1.00] [--risk=0.02] [--trailing=0.5]
//      [--duration=120] [--cutoff=20] [--cooldown=2] [--real-only]
//
//  --stake     : FIXED dollar stake (matches db.js risk.stakeAmount
//                EXACTLY — this is how production actually sizes
//                trades, NOT a % of equity). Takes priority over
//                --risk when both are present.
//  --risk      : fallback %-of-equity sizing, only used if --stake
//                is not set (production does not use this mode).
//  --trailing  : trailingStopPct (default 0.5 = 50% of TP, matches
//                db.js default). 0 disables trailing stop.
//  --duration  : contractDurationMins (default 120 = 2hrs, matches
//                db.js default). 0 disables the forced-close timer.
//  --cutoff    : noProfitCutoffMins (default 20, matches db.js
//                default). 0 disables this mechanism entirely.
//  --cooldown  : cutoffCooldownHours (default 2, matches db.js
//                default). 0 means no cooldown lock applied.
//  --real-only skips any symbol without a real data file
//  instead of falling back to synthetic data for it.
// ═══════════════════════════════════════════════════════

import fs from "fs";
import path from "path";
import { runBacktest } from "./engine.js";
import { generateSample } from "./generate-sample-data.js";
import { SYMBOLS } from "../src/config/symbols.js";

// ── LOAD PERSONAL RISK SETTINGS, IF PRESENT ──────────────
const myRiskPath = path.resolve("backtest/my-risk-settings.js");
let myRisk = {};
if (fs.existsSync(myRiskPath)) {
  const mod = await import(`file://${myRiskPath}`);
  myRisk = mod.default || {};
  console.log("Loaded personal risk settings from backtest/my-risk-settings.js");
} else {
  console.log("No backtest/my-risk-settings.js found — using built-in defaults.");
  console.log("(Copy backtest/my-risk-settings.example.js to create your own.)\n");
}

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv.slice(2)) {
    if (arg === "--real-only") { opts.realOnly = true; continue; }
    const m = arg.match(/^--([\w]+)=(.+)$/);
    if (m) opts[m[1]] = isNaN(Number(m[2])) ? m[2] : Number(m[2]);
  }
  return opts;
}

const cliOpts = parseArgs(process.argv);
// CLI flags override personal settings file, which overrides built-in defaults.
const opts = { ...myRisk, ...cliOpts };
const days = opts.days ?? 365;

console.log(`Scanning ${SYMBOLS.length} symbols (the same list src/index.js trades)...\n`);

const results = [];
const skipped = [];

for (const symbol of SYMBOLS) {
  const dataPath = `backtest/data/${symbol}.json`;
  let data;

  if (fs.existsSync(dataPath)) {
    data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    console.log(`[real data]      ${symbol}`);
  } else if (opts.realOnly) {
    console.log(`[skip — no data] ${symbol}`);
    skipped.push(symbol);
    continue;
  } else {
    data = generateSample({ symbol, days });
    console.log(`[synthetic]      ${symbol}`);
  }

  try {
    const result = runBacktest({
      symbol,
      d1: data.d1,
      h1: data.h1,
      m15: data.m15,
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
    results.push(result);
  } catch (e) {
    console.log(`  ⚠ ${symbol} failed: ${e.message}`);
    skipped.push(symbol);
  }
}

// ── Combined summary ───────────────────────────────────
const totalTrades = results.reduce((s, r) => s + r.totalTrades, 0);
const totalWins = results.reduce((s, r) => s + r.wins, 0);
const totalLosses = results.reduce((s, r) => s + r.losses, 0);
const allTrades = results.flatMap(r => r.trades);
const grossProfit = allTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
const grossLoss = Math.abs(allTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
const totalPnl = grossProfit - grossLoss;

console.log(`\n══════════════════════════════════════════════════════════════`);
console.log(`  COMBINED RESULTS — ${results.length} symbols scanned, ${skipped.length} skipped`);
console.log(`══════════════════════════════════════════════════════════════`);
console.log(`  Total Trades     : ${totalTrades}`);
console.log(`  Win Rate         : ${totalTrades ? ((totalWins / totalTrades) * 100).toFixed(1) : 0}% (${totalWins}W / ${totalLosses}L)`);
console.log(`  Profit Factor    : ${grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "—"}`);
console.log(`  Combined PnL     : $${totalPnl.toFixed(2)}  (each symbol modeled with its own independent $${(opts.equity ?? 1000)} — NOT a shared portfolio equity curve)`);
console.log(`══════════════════════════════════════════════════════════════`);

// Exit-reason breakdown — shows how often each exit rule actually fired
const outcomeCounts = {};
for (const t of allTrades) outcomeCounts[t.outcome] = (outcomeCounts[t.outcome] || 0) + 1;
console.log(`  Exit reasons     : ${Object.entries(outcomeCounts).map(([k, v]) => `${k}=${v}`).join("  ")}`);
const stakeMode = (opts.stake ?? opts.stakeAmount) !== undefined
  ? `stakeAmount=$${opts.stake ?? opts.stakeAmount} (fixed, matches production)`
  : `riskPct=${opts.risk ?? 0.02} (% of equity, fallback mode)`;
console.log(`  Settings used    : ${stakeMode}  trailingStopPct=${opts.trailing ?? opts.trailingStopPct ?? 0.5}  contractDurationMins=${opts.duration ?? opts.contractDurationMins ?? 120}  noProfitCutoffMins=${opts.cutoff ?? opts.noProfitCutoffMins ?? 20}  cutoffCooldownHours=${opts.cooldown ?? opts.cutoffCooldownHours ?? 2}`);
console.log(`══════════════════════════════════════════════════════════════\n`);

// Per-symbol table, sorted by trade count desc so active symbols surface first
const active = results.filter(r => r.totalTrades > 0).sort((a, b) => b.totalTrades - a.totalTrades);
const inactive = results.filter(r => r.totalTrades === 0);

console.log(`Symbols with trades (${active.length}):`);
console.log(`  Symbol          Trades  WinRate   PF      Return%   MaxDD%`);
for (const r of active) {
  console.log(`  ${r.symbol.padEnd(15)} ${String(r.totalTrades).padStart(4)}    ${String(r.winRatePct).padStart(5)}%   ${String(r.profitFactor).padStart(5)}   ${String(r.totalReturnPct).padStart(6)}%   ${r.maxDrawdownPct}%`);
}
console.log(`\nSymbols with zero trades in this window (${inactive.length}): ${inactive.map(r => r.symbol).join(", ") || "none"}`);
if (skipped.length) console.log(`Skipped (no data / error) (${skipped.length}): ${skipped.join(", ")}`);

// ── Master trade CSV ────────────────────────────────────
fs.mkdirSync("backtest/results", { recursive: true });
const csvHeader = "symbol,direction,entry_time,entry_price,exit_time,exit_price,stake,multiplier,pnl,outcome,equity_after\n";
const csvRows = allTrades
  .sort((a, b) => a.entryEpoch - b.entryEpoch)
  .map(t => [
    t.symbol, t.direction,
    new Date(t.entryEpoch * 1000).toISOString(), t.entryPrice,
    new Date(t.exitEpoch * 1000).toISOString(), t.exitPrice,
    t.stake, t.multiplier, t.pnl.toFixed(2), t.outcome, t.equityAfter.toFixed(2),
  ].join(","))
  .join("\n");
fs.writeFileSync("backtest/results/all-symbols-trades.csv", csvHeader + csvRows);
console.log(`\nMaster trade log: backtest/results/all-symbols-trades.csv`);
