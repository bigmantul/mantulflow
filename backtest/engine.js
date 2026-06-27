// ═══════════════════════════════════════════════════════
//  backtest/engine.js
//
//  Walk-forward backtester for the Daily Bias strategy.
//
//  DESIGN PRINCIPLE: this engine does NOT reimplement the
//  strategy. It imports the real collectSignals() from
//  src/strategy/signals.js and the real RiskManager /
//  StopLossTakeProfit from src/risk/risk-manager.js, so a
//  backtest result reflects what production code actually
//  does — not a re-derived approximation of it.
//
//  IMPORTANT GOTCHA THIS ENGINE WORKS AROUND:
//  signals.js uses `new Date()` (real wall-clock time) to
//  decide "is this a new trading day" and "are we in the
//  London/NY session". That's correct for live trading,
//  but it means if you just call collectSignals() in a
//  loop over historical bars, Stage 1 (Daily Bias) would
//  only ever be computed ONCE — on the first call — using
//  TODAY's real date, then stay frozen for the rest of the
//  backtest, because `state.dailyBiasDate` would never
//  differ from `todayKey()` again. Same problem for the
//  London/NY session gate.
//
//  Fix: withFakeNow() temporarily swaps the global Date
//  constructor so `new Date()` (no args) returns the
//  CURRENT SIMULATED bar's timestamp, only for the duration
//  of a single collectSignals() call, then restores the
//  real Date immediately after. signals.js itself is never
//  modified.
// ═══════════════════════════════════════════════════════

import {
  collectSignals,
  resetSymbolState,
  SIG_BUY,
  SIG_SELL,
} from "../src/strategy/signals.js";
import { RiskManager, StopLossTakeProfit } from "../src/risk/risk-manager.js";
import { FALLBACK_MULTIPLIERS } from "../src/trading/multipliers.js";

// ── Date mocking (scoped to a single call) ─────────────
// Class is defined ONCE; only the captured `simulatedMs` box
// changes per call. Recreating a class expression on every
// bar (tens of thousands of times per symbol) was the actual
// bottleneck in earlier profiling — this version just flips
// a mutable box instead.
const _clockBox = { ms: Date.now() };
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) return new RealDate(_clockBox.ms);
    return new RealDate(...args);
  }
  static now() {
    return _clockBox.ms;
  }
}

function withFakeNow(simulatedMs, fn) {
  _clockBox.ms = simulatedMs;
  globalThis.Date = FakeDate;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

// ── Two-pointer "how many bars are closed as of time T" ──
// Returns a function you call with increasing epochs (must
// be called in non-decreasing epoch order) that returns the
// count of bars in `arr` whose epoch <= targetEpoch.
function makeClosedCounter(arr) {
  let i = 0;
  return function countClosed(targetEpoch) {
    while (i < arr.length && arr[i].epoch <= targetEpoch) i++;
    return i;
  };
}

// Appends ONE placeholder bar in-place (no array copy) so that
// `len-2` lands on the last real closed bar (mirrors how
// production always has a still-forming candle as the last
// array element). The placeholder's OHLC values are never
// read by any function in signals.js — only bar[len-2] and
// earlier are read — but we still avoid leaking the *next*
// real bar into the array, since that would be lookahead.
// Caller is responsible for popping it back off afterward.
function pushPlaceholder(arr) {
  if (arr.length === 0) return null;
  const last = arr[arr.length - 1];
  const placeholder = { ...last, epoch: last.epoch + 1, open: last.close, high: last.close, low: last.close, close: last.close };
  arr.push(placeholder);
  return placeholder;
}

function pnlAtPrice({ entryPrice, stake, multiplier, direction }, price) {
  const dirSign = direction === "buy" ? 1 : -1;
  return stake * multiplier * ((price - entryPrice) / entryPrice) * dirSign;
}

// Given an open position and the M15 bar that just closed,
// determine if SL or TP was crossed inside that bar's
// high/low range. Conservative convention: if both could
// have been hit in the same bar, SL is assumed to have hit
// first (avoids overstating performance).
function checkExitWithinBar(position, bar) {
  const { stopLoss, takeProfit, direction } = position;
  const worstPrice = direction === "buy" ? bar.low : bar.high;
  const bestPrice = direction === "buy" ? bar.high : bar.low;

  const worstPnl = pnlAtPrice(position, worstPrice);
  if (worstPnl <= -stopLoss) {
    // Solve for the exact price where pnl == -stopLoss
    const dirSign = direction === "buy" ? 1 : -1;
    const exitPrice = position.entryPrice * (1 - (stopLoss / (position.stake * position.multiplier)) * dirSign);
    return { exit: true, exitPrice, pnl: -stopLoss, outcome: "SL" };
  }
  const bestPnl = pnlAtPrice(position, bestPrice);
  if (bestPnl >= takeProfit) {
    const dirSign = direction === "buy" ? 1 : -1;
    const exitPrice = position.entryPrice * (1 + (takeProfit / (position.stake * position.multiplier)) * dirSign);
    return { exit: true, exitPrice, pnl: takeProfit, outcome: "TP" };
  }
  return { exit: false };
}

/**
 * Run a single-symbol backtest.
 *
 * @param {object} opts
 * @param {string} opts.symbol
 * @param {Array}  opts.d1   - full historical D1 candles, ascending epoch, {epoch,open,high,low,close}
 * @param {Array}  opts.h1   - full historical H1 candles
 * @param {Array}  opts.m15  - full historical M15 candles (the bar the loop steps over)
 * @param {number} [opts.startEquity=1000]
 * @param {number} [opts.riskPct=0.02]      - fraction of equity risked per trade stake (0.02 = 2%).
 *                                            NOTE: this is intentionally NOT routed through
 *                                            RiskManager.calculateStake() — see README note on
 *                                            the riskPct*10 bug in risk-manager.js. This engine
 *                                            computes stake directly with correct units.
 * @param {number} [opts.slPct=0.80]        - matches StopLossTakeProfit default
 * @param {number} [opts.tpPct=2.00]
 * @param {number} [opts.maxOpenTrades=3]
 * @param {number} [opts.maxConsecutiveLosses=3]
 * @param {number} [opts.maxDailyLossPct=0.30]
 * @param {number} [opts.minStartIndex] - skip this many bars at the start to give D1/H1 lookback room to warm up
 */
export function runBacktest(opts) {
  const {
    symbol,
    d1,
    h1,
    m15,
    startEquity = 1000,
    riskPct = 0.02,
    slPct = 0.80,
    tpPct = 2.00,
    maxOpenTrades = 3,
    maxConsecutiveLosses = 3,
    maxDailyLossPct = 0.30,
    minStartIndex = 100,
  } = opts;

  if (!m15 || m15.length < minStartIndex + 5) {
    throw new Error(`Not enough M15 data for ${symbol} (need > ${minStartIndex + 5} bars, got ${m15?.length ?? 0})`);
  }

  resetSymbolState(symbol); // fresh state — module-level Map, must clear before each run

  const rm = new RiskManager({ maxOpenTrades, maxConsecutiveLosses, maxDailyLossPct });
  rm.setStartingBalance(startEquity);
  const sltp = new StopLossTakeProfit({ slPct, tpPct });

  const d1Counter = makeClosedCounter(d1);
  const h1Counter = makeClosedCounter(h1);

  let equity = startEquity;
  const equityCurve = [{ epoch: m15[0].epoch, equity }];
  const trades = [];
  let openPosition = null; // single position at a time for this symbol

  // Incrementally-grown "closed bars so far" arrays. Avoids the O(n^2)
  // cost of re-slicing the full history on every bar — instead we push
  // newly-closed bars on as we go (O(1) amortized) and temporarily push
  // a placeholder for the duration of each collectSignals() call, then
  // pop it back off. None of signals.js's helpers mutate their input
  // arrays (verified — only .slice()/.map()/index reads), so reusing
  // one growing array across iterations is safe.
  const growingD1 = [];
  const growingH1 = [];
  const growingM15 = [];
  let d1Pushed = 0;
  let h1Pushed = 0;

  for (let i = minStartIndex; i < m15.length; i++) {
    const bar = m15[i];

    // Everything in this iteration runs under the simulated bar time —
    // both collectSignals() (Stage1 day-tracking, session gating) AND
    // RiskManager's _checkDailyReset() depend on new Date(), so both
    // need to see the same simulated "now", not real wall-clock time.
    withFakeNow(bar.epoch * 1000, () => {

    // ── If a position is open, check for SL/TP exit on THIS bar first ──
    if (openPosition) {
      const result = checkExitWithinBar(openPosition, bar);
      if (result.exit) {
        equity += result.pnl;
        rm.tradeClosed(result.pnl);
        trades.push({
          symbol,
          direction: openPosition.direction,
          entryEpoch: openPosition.entryEpoch,
          entryPrice: openPosition.entryPrice,
          exitEpoch: bar.epoch,
          exitPrice: result.exitPrice,
          stake: openPosition.stake,
          multiplier: openPosition.multiplier,
          pnl: result.pnl,
          outcome: result.outcome,
          equityAfter: equity,
        });
        equityCurve.push({ epoch: bar.epoch, equity });
        openPosition = null;
      }
    }

    // ── Grow the closed-bar windows incrementally, no lookahead ──
    const targetD1Count = d1Counter(bar.epoch);
    while (d1Pushed < targetD1Count) growingD1.push(d1[d1Pushed++]);
    const targetH1Count = h1Counter(bar.epoch);
    while (h1Pushed < targetH1Count) growingH1.push(h1[h1Pushed++]);
    growingM15.push(bar);

    if (growingD1.length < 4 || growingH1.length < 20) return; // not enough warm-up yet

    const d1Placeholder = pushPlaceholder(growingD1);
    const h1Placeholder = pushPlaceholder(growingH1);
    const m15Placeholder = pushPlaceholder(growingM15);

    let result;
    try {
      const tf = { d1: growingD1, h1: growingH1, m15: growingM15, symbol };
      result = collectSignals(tf);
    } finally {
      growingD1.pop();
      growingH1.pop();
      growingM15.pop();
    }

    // ── Symbol lock: while a position is open on this symbol, ignore new signals ──
    if (openPosition) return;
    if (result.signal !== SIG_BUY && result.signal !== SIG_SELL) return;

    if (!rm.canTrade(equity)) return;

    // Entry happens at the OPEN of the bar immediately following the
    // signal candle — that's exactly `bar` in this loop iteration,
    // since collectSignals() just fired using bar i as `lastClosed`.
    const direction = result.signal === SIG_BUY ? "buy" : "sell";
    const stake = Math.max(1, parseFloat((equity * riskPct).toFixed(2)));
    const multiplier = FALLBACK_MULTIPLIERS[symbol] ?? 50;
    const limitOrder = sltp.getMultiplierLimitOrder(stake);

    openPosition = {
      direction,
      entryEpoch: bar.epoch,
      entryPrice: bar.open,
      stake,
      multiplier,
      stopLoss: limitOrder.stop_loss,
      takeProfit: limitOrder.take_profit,
    };
    rm.tradeOpened();

    }); // end withFakeNow
  } // end for

  // Close any still-open position at the last available price (mark-to-market)
  if (openPosition) {
    const lastBar = m15[m15.length - 1];
    const pnl = pnlAtPrice(openPosition, lastBar.close);
    equity += pnl;
    trades.push({
      symbol,
      direction: openPosition.direction,
      entryEpoch: openPosition.entryEpoch,
      entryPrice: openPosition.entryPrice,
      exitEpoch: lastBar.epoch,
      exitPrice: lastBar.close,
      stake: openPosition.stake,
      multiplier: openPosition.multiplier,
      pnl,
      outcome: "EOD_MARK",
      equityAfter: equity,
    });
    equityCurve.push({ epoch: lastBar.epoch, equity });
  }

  return summarize({ symbol, trades, equityCurve, startEquity, finalEquity: equity });
}

function summarize({ symbol, trades, equityCurve, startEquity, finalEquity }) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  let peak = startEquity;
  let maxDrawdownPct = 0;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const dd = (peak - point.equity) / peak;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  return {
    symbol,
    startEquity,
    finalEquity: parseFloat(finalEquity.toFixed(2)),
    totalReturnPct: parseFloat((((finalEquity - startEquity) / startEquity) * 100).toFixed(2)),
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? parseFloat(((wins.length / trades.length) * 100).toFixed(1)) : 0,
    profitFactor: grossLoss > 0 ? parseFloat((grossProfit / grossLoss).toFixed(2)) : (grossProfit > 0 ? Infinity : 0),
    maxDrawdownPct: parseFloat((maxDrawdownPct * 100).toFixed(2)),
    avgWin: wins.length ? parseFloat((grossProfit / wins.length).toFixed(2)) : 0,
    avgLoss: losses.length ? parseFloat((-grossLoss / losses.length).toFixed(2)) : 0,
    trades,
    equityCurve,
  };
}
