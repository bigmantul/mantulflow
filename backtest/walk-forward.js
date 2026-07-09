// ═══════════════════════════════════════════════════════
//  backtest/walk-forward.js
//
//  WHY THIS EXISTS:
//  run-all.js runs the whole history in one pass and gives
//  ONE blended number ("62% win rate over the year"). That
//  hides whether the strategy is consistently mediocre or
//  is actually great in some conditions and terrible in
//  others — which is exactly what you need to see to know
//  whether a threshold/rule change is fixing the real
//  problem or just shifting it around.
//
//  This script slices each symbol's history into rolling
//  windows (default 90 days, stepping forward 30 days at a
//  time), classifies the market regime of each window
//  (trend strength + volatility level), and runs the SAME
//  real runBacktest() from engine.js on each window. Output
//  is grouped by regime so you can see e.g. "this strategy
//  is fine in trending/high-vol conditions but bleeds in
//  ranging/low-vol conditions" directly, instead of guessing
//  from demo trading.
//
//  d1/h1 are passed to each window UNSLICED (full history)
//  so trend-lookback context (e.g. the 30-candle HTF trend
//  read) still has real prior data to work with — only m15
//  (the bar-by-bar driver) is sliced to the window's date
//  range. This is safe: engine.js's closed-bar counters only
//  ever grow up to the current simulated bar's epoch, so
//  passing full d1/h1 arrays cannot leak future data.
//
//  Usage:
//    node backtest/walk-forward.js [--days=365] [--window=90]
//      [--step=30] [--equity=1000] [--stake=1.00] [--real-only]
//
//  Same risk-setting flags as run-all.js (--stake, --trailing,
//  --duration, --cutoff, --cooldown) are honored the same way,
//  including auto-loading backtest/my-risk-settings.js if present.
// ═══════════════════════════════════════════════════════

import fs from "fs";
import path from "path";
import { runBacktest } from "./engine.js";
import { generateSample } from "./generate-sample-data.js";
import { SYMBOLS } from "../src/config/symbols.js";
import { classifyD1Regime } from "../src/strategy/signals.js";

// ── LOAD PERSONAL RISK SETTINGS, IF PRESENT (same as run-all.js) ──
const myRiskPath = path.resolve("backtest/my-risk-settings.js");
let myRisk = {};
if (fs.existsSync(myRiskPath)) {
  const mod = await import(`file://${myRiskPath}`);
  myRisk = mod.default || {};
  console.log("Loaded personal risk settings from backtest/my-risk-settings.js");
} else {
  console.log("No backtest/my-risk-settings.js found — using built-in defaults.");
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
const opts = { ...myRisk, ...cliOpts };

const TOTAL_DAYS  = opts.days   ?? 365;
const WINDOW_DAYS = opts.window ?? 90;
const STEP_DAYS   = opts.step   ?? 30;
const SECS_PER_DAY = 86400;

// ── Regime classification ──────────────────────────────
// Trend classification uses the EXACT SAME classifyD1Regime()
// from src/strategy/signals.js that the live bot's regime gate
// uses — so "trending" here means the identical thing it means
// live, not a separately-drifting definition. Volatility
// labeling (not part of the live gate — see signals.js's
// comment on why) stays local here, for reporting only.
function classifyRegime(d1Window) {
  if (!d1Window || d1Window.length < 3) return { label: "insufficient-data", volLevel: "?", trendLevel: "?" };

  const avgRangePct = d1Window.reduce((s, c) => s + (c.high - c.low) / c.close, 0) / d1Window.length;
  const volLevel = avgRangePct < 0.006 ? "low-vol" : avgRangePct < 0.015 ? "med-vol" : "high-vol";

  // excludeForming: false — this window is fully-historical, no still-
  // forming candle at the end. lookback: whole window, not the live
  // rolling 30 — keeps this comparable to earlier walk-forward runs.
  const { trending, agreeRatio } = classifyD1Regime(d1Window, { lookback: d1Window.length, excludeForming: false });
  const trendLevel = trending ? "trending" : "ranging";

  return { label: `${trendLevel}/${volLevel}`, volLevel, trendLevel, avgRangePct: +(avgRangePct * 100).toFixed(3), agreeRatio };
}

// ── Slice m15 to an epoch range; d1/h1 stay full (see header note) ──
function sliceM15(m15, fromEpoch, toEpoch) {
  return m15.filter(c => c.epoch >= fromEpoch && c.epoch < toEpoch);
}
function sliceD1ForRegime(d1, fromEpoch, toEpoch) {
  return d1.filter(c => c.epoch >= fromEpoch && c.epoch < toEpoch);
}

const riskOpts = {
  startEquity: opts.equity ?? 1000,
  stakeAmount: opts.stake ?? opts.stakeAmount ?? 100,
  riskPct: opts.risk ?? 10,
  slPct: opts.sl ?? opts.stopLossPct ?? 0.80,
  tpPct: opts.tp ?? opts.takeProfitPct ?? 1.60,
  trailingStopPct: opts.trailing ?? opts.trailingStopPct ?? 25,
  contractDurationMins: opts.duration ?? opts.contractDurationMins ?? 240,
  noProfitCutoffMins: opts.cutoff ?? opts.noProfitCutoffMins ?? 0,
  cutoffCooldownHours: opts.cooldown ?? opts.cutoffCooldownHours ?? 0,
};

console.log(`Walk-forward: ${TOTAL_DAYS}d history, ${WINDOW_DAYS}d windows, ${STEP_DAYS}d step, ${SYMBOLS.length} symbols\n`);

const rows = [];      // one row per symbol x window
const skipped = [];

for (const symbol of SYMBOLS) {
  const dataPath = `backtest/data/${symbol}.json`;
  let data;
  if (fs.existsSync(dataPath)) {
    data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  } else if (opts.realOnly) {
    skipped.push(symbol);
    continue;
  } else {
    data = generateSample({ symbol, days: TOTAL_DAYS });
  }

  const { d1, h1, m15 } = data;
  if (!m15 || m15.length < 200) { skipped.push(symbol); continue; }

  const firstEpoch = m15[0].epoch;
  const lastEpoch  = m15[m15.length - 1].epoch;

  for (let winStart = firstEpoch; winStart + WINDOW_DAYS * SECS_PER_DAY <= lastEpoch; winStart += STEP_DAYS * SECS_PER_DAY) {
    const winEnd = winStart + WINDOW_DAYS * SECS_PER_DAY;
    const windowM15 = sliceM15(m15, winStart, winEnd);
    if (windowM15.length < 150) continue; // not enough bars to bother (minStartIndex + buffer)

    const regime = classifyRegime(sliceD1ForRegime(d1, winStart, winEnd));

    try {
      const result = runBacktest({ symbol, d1, h1, m15: windowM15, ...riskOpts });

      // Tally exit reasons for THIS window (outcome field set by engine.js —
      // e.g. "SL", "TP", "DAILY_BIAS_REVERSAL", "FORCED_CLOSE", "EOD_MARK",
      // "NO_PROFIT_CUTOFF" — see engine.js's monitorOpenTrades-equivalent logic)
      const outcomeCounts = {};
      for (const t of result.trades) outcomeCounts[t.outcome] = (outcomeCounts[t.outcome] || 0) + 1;

      // Raw counts/sums, not ratios — averaging per-window profit-factor or
      // win-rate RATIOS is statistically fragile (one low-trade window with
      // near-zero gross loss can produce an enormous PF that skews a naive
      // average). Storing the raw numbers lets regime-level stats be computed
      // as true aggregates: sum(grossProfit)/sum(grossLoss), not avg(PF).
      const grossProfit = result.trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
      const grossLoss   = Math.abs(result.trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));

      rows.push({
        symbol,
        windowStart: new Date(winStart * 1000).toISOString().slice(0, 10),
        windowEnd: new Date(winEnd * 1000).toISOString().slice(0, 10),
        regime: regime.label,
        trades: result.totalTrades,
        wins: result.wins,
        losses: result.losses,
        grossProfit,
        grossLoss,
        totalReturnPct: result.totalReturnPct,
        maxDrawdownPct: result.maxDrawdownPct,
        outcomeCounts,
      });
    } catch (e) {
      // Not enough bars after minStartIndex burn-in for this particular
      // window — skip silently, this is expected for some windows.
    }
  }
}

// ── Group by regime ─────────────────────────────────────
const byRegime = {};
for (const r of rows) {
  if (!byRegime[r.regime]) byRegime[r.regime] = [];
  byRegime[r.regime].push(r);
}

console.log(`══════════════════════════════════════════════════════════════`);
console.log(`  RESULTS BY REGIME  (${rows.length} symbol-windows across ${SYMBOLS.length - skipped.length} symbols)`);
console.log(`══════════════════════════════════════════════════════════════`);
for (const [regime, group] of Object.entries(byRegime).sort()) {
  const totalTrades  = group.reduce((s, r) => s + r.trades, 0);
  const totalWins    = group.reduce((s, r) => s + r.wins, 0);
  const totalGP      = group.reduce((s, r) => s + r.grossProfit, 0);
  const totalGL      = group.reduce((s, r) => s + r.grossLoss, 0);
  const aggWinRate   = totalTrades ? (totalWins / totalTrades) * 100 : 0;
  const aggPF        = totalGL > 0 ? totalGP / totalGL : (totalGP > 0 ? Infinity : 0);
  const avgReturn    = group.reduce((s, r) => s + r.totalReturnPct, 0) / group.length;
  const avgDD        = group.reduce((s, r) => s + r.maxDrawdownPct, 0) / group.length;
  const worstDD      = Math.max(...group.map(r => r.maxDrawdownPct));

  // Merge every window's outcomeCounts in this regime into one tally,
  // so we can see WHY trades closed, not just whether they won —
  // e.g. a regime dying to SL hits (stops too tight for the volatility)
  // looks very different from one dying to FORCED_CLOSE (trend takes
  // longer to play out than contractDurationMins allows).
  const mergedOutcomes = {};
  for (const r of group) {
    for (const [k, v] of Object.entries(r.outcomeCounts || {})) mergedOutcomes[k] = (mergedOutcomes[k] || 0) + v;
  }
  const outcomeStr = Object.entries(mergedOutcomes)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v} (${totalTrades ? ((v / totalTrades) * 100).toFixed(0) : 0}%)`)
    .join("  ");

  console.log(`\n  ${regime}  (${group.length} windows, ${totalTrades} total trades)`);
  console.log(`    Win rate (agg)  : ${aggWinRate.toFixed(1)}%`);
  console.log(`    Profit fctr(agg): ${Number.isFinite(aggPF) ? aggPF.toFixed(2) : "—"}`);
  console.log(`    Avg return      : ${avgReturn.toFixed(2)}%`);
  console.log(`    Avg / worst DD  : ${avgDD.toFixed(2)}% / ${worstDD.toFixed(2)}%`);
  console.log(`    Exit reasons    : ${outcomeStr || "—"}`);
}

// ── COMBINED — everything, ignoring regime bucketing ────
// This is the answer to "did a change (e.g. the regime gate)
// improve the OVERALL result" — per-bucket comparisons can be
// misleading once live gating logic and backtest bucket-labeling
// use different granularities (rolling lookback vs whole-window).
{
  const allTotalTrades = rows.reduce((s, r) => s + r.trades, 0);
  const allTotalWins   = rows.reduce((s, r) => s + r.wins, 0);
  const allTotalGP     = rows.reduce((s, r) => s + r.grossProfit, 0);
  const allTotalGL     = rows.reduce((s, r) => s + r.grossLoss, 0);
  const allWinRate     = allTotalTrades ? (allTotalWins / allTotalTrades) * 100 : 0;
  const allPF          = allTotalGL > 0 ? allTotalGP / allTotalGL : (allTotalGP > 0 ? Infinity : 0);
  const allAvgReturn   = rows.length ? rows.reduce((s, r) => s + r.totalReturnPct, 0) / rows.length : 0;
  const allWorstDD     = rows.length ? Math.max(...rows.map(r => r.maxDrawdownPct)) : 0;

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  COMBINED (all regimes, ${rows.length} symbol-windows)`);
  console.log(`══════════════════════════════════════════════════════════════`);
  console.log(`    Total trades    : ${allTotalTrades}`);
  console.log(`    Win rate (agg)  : ${allWinRate.toFixed(1)}%`);
  console.log(`    Profit fctr(agg): ${Number.isFinite(allPF) ? allPF.toFixed(2) : "—"}`);
  console.log(`    Avg return      : ${allAvgReturn.toFixed(2)}%`);
  console.log(`    Worst-case DD   : ${allWorstDD.toFixed(2)}%`);
  console.log(`    Gross profit/loss: $${allTotalGP.toFixed(2)} / $${allTotalGL.toFixed(2)}`);
}
console.log(`\n══════════════════════════════════════════════════════════════`);
if (skipped.length) console.log(`Skipped (no data / insufficient bars): ${skipped.join(", ")}`);

// ── Full detail CSV — every symbol x window row ─────────
fs.mkdirSync("backtest/results", { recursive: true });
const header = "symbol,window_start,window_end,regime,trades,wins,losses,gross_profit,gross_loss,total_return_pct,max_drawdown_pct,exit_reasons\n";
const csv = rows
  .map(r => {
    const outcomeStr = Object.entries(r.outcomeCounts || {}).map(([k, v]) => `${k}:${v}`).join(" ");
    return [r.symbol, r.windowStart, r.windowEnd, r.regime, r.trades, r.wins, r.losses, r.grossProfit.toFixed(2), r.grossLoss.toFixed(2), r.totalReturnPct, r.maxDrawdownPct, `"${outcomeStr}"`].join(",");
  })
  .join("\n");
fs.writeFileSync("backtest/results/walk-forward.csv", header + csv);
console.log(`\nFull detail: backtest/results/walk-forward.csv`);
