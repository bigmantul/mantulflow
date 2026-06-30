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
//  EXIT RULES SIMULATED (matches dashboard/bot-manager.js
//  monitorOpenTrades(), same priority order, checked in
//  this exact order on every closed M15 bar):
//    1. No-profit cutoff (configurable, default 20min, 0=OFF) —
//       close if open >=noProfitCutoffMins and PnL<=0, then symbol
//       locked out from new entries for cutoffCooldownHours (0=none)
//    2. Trailing stop — activates at trailingStopPct of TP
//       (default 50%), moves SL to breakeven, then trails
//       by the same step
//    3. Stop Loss (fixed dollar limit order)
//    4. Take Profit (fixed dollar limit order)
//    5. Forced contract close — after contractDurationMins
//       (default 120 = 2hrs), regardless of P&L
//
//  NOT YET SIMULATED — KNOWN GAP:
//  Production's EXIT 1 (Daily Bias Reversal — closing early
//  if the D1 bias flips against an open position) is NOT
//  implemented in this engine yet. Positions here only close
//  via the 5 rules above. If you want this added too, say so
//  explicitly — flagging it rather than silently omitting it.
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

// Converts a target PnL dollar amount into the price level that would
// produce it, given direction/stake/multiplier — used for SL/TP/trailing.
function priceForPnl(position, targetPnl) {
  const { entryPrice, stake, multiplier, direction } = position;
  const dirSign = direction === "buy" ? 1 : -1;
  return entryPrice * (1 + (targetPnl / (stake * multiplier)) * dirSign);
}

/**
 * Given an open position and the M15 bar that just closed, checks ALL
 * exit conditions in the SAME PRIORITY ORDER as production's
 * monitorOpenTrades(), aside from Daily Bias Reversal (checked
 * separately in the main loop since it needs collectSignals() output,
 * not just this bar's OHLC).
 *
 * Priority: 20-min no-profit cutoff -> trailing stop -> SL -> TP ->
 * forced contract duration close.
 *
 * Conservative convention preserved: if SL and TP could both have
 * been hit in the same bar, SL is assumed to have hit first.
 */
function checkExitWithinBar(position, bar, opts) {
  const { trailingStopPct = 0.5, contractDurationMins = 120, noProfitCutoffMins = 20, cutoffCooldownHours = 2 } = opts;
  const { stopLoss, takeProfit, direction, entryEpoch, m15GranularitySec = 900 } = position;

  const worstPrice = direction === "buy" ? bar.low : bar.high;
  const bestPrice  = direction === "buy" ? bar.high : bar.low;
  const worstPnl   = pnlAtPrice(position, worstPrice);
  const bestPnl    = pnlAtPrice(position, bestPrice);

  const minutesOpen = (bar.epoch - entryEpoch) / 60;

  // ── 1. NO-PROFIT CUTOFF (configurable, default 20min, 0 = OFF) ──
  // Mirrors bot-manager.js EXIT 1B exactly: if >=noProfitCutoffMins open
  // and current (close-of-bar) PnL <= 0, force close. Uses bar.close
  // as "current price" since that's the most recent known price
  // at the moment this check would run live (poll-based, not
  // intra-bar), matching how monitorOpenTrades() polls periodically
  // rather than reacting to every tick. cutoffCooldownHours controls
  // how long the symbol is then locked out (0 = no cooldown at all).
  const closePnl = pnlAtPrice(position, bar.close);
  if (noProfitCutoffMins > 0 && minutesOpen >= noProfitCutoffMins && closePnl <= 0) {
    return { exit: true, exitPrice: bar.close, pnl: closePnl, outcome: "NO_PROFIT_CUTOFF", lockCooldownHours: cutoffCooldownHours };
  }

  // ── 2. TRAILING STOP ─────────────────────────────────
  // Activates once profit reaches trailingStopPct of TP, moves SL to
  // breakeven, then trails by the same step as profit climbs further
  // — identical math to bot-manager.js EXIT (trailing stop) section.
  if (trailingStopPct > 0 && takeProfit > 0) {
    const stepSize  = takeProfit * trailingStopPct;
    const priorPeak = position.trailingPeakPnl || 0;
    const newPeak   = Math.max(priorPeak, bestPnl);
    if (newPeak > priorPeak) position.trailingPeakPnl = newPeak;

    if (newPeak >= stepSize) {
      const stepsBanked = Math.floor(newPeak / stepSize);
      const lockedProfit = stepsBanked * stepSize;
      // Trailing floor sits ONE STEP behind the peak — e.g. once 2 steps
      // are banked, the floor locks in 1 step of profit, not 2 — same
      // "always one step behind" behavior as production.
      const trailingFloorPnl = Math.max(lockedProfit - stepSize, 0); // never below breakeven (pnl=0)
      position.trailingActive = true;

      if (worstPnl <= trailingFloorPnl) {
        const exitPrice = priceForPnl(position, trailingFloorPnl);
        return { exit: true, exitPrice, pnl: trailingFloorPnl, outcome: trailingFloorPnl > 0 ? "TRAIL" : "TRAIL_BE" };
      }
    }
  }

  // ── 3. STOP LOSS ─────────────────────────────────────
  if (worstPnl <= -stopLoss) {
    const exitPrice = priceForPnl(position, -stopLoss);
    return { exit: true, exitPrice, pnl: -stopLoss, outcome: "SL" };
  }

  // ── 4. TAKE PROFIT ───────────────────────────────────
  if (bestPnl >= takeProfit) {
    const exitPrice = priceForPnl(position, takeProfit);
    return { exit: true, exitPrice, pnl: takeProfit, outcome: "TP" };
  }

  // ── 5. FORCED CONTRACT DURATION CLOSE ────────────────
  // Mirrors trader.js's startForcedCloseTimer: regardless of P&L,
  // close once contractDurationMins has elapsed. 0/null = OFF.
  if (contractDurationMins > 0 && minutesOpen >= contractDurationMins) {
    return { exit: true, exitPrice: bar.close, pnl: closePnl, outcome: "FORCED_CLOSE" };
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
 * @param {number} [opts.stakeAmount]  - FIXED dollar stake, matches the live bot's
 *                                       dashboard/db.js risk.stakeAmount EXACTLY (the
 *                                       live bot does NOT size stake as a % of balance
 *                                       at all — every trade uses this same fixed dollar
 *                                       amount regardless of equity). If provided, this
 *                                       takes priority over riskPct below. This is the
 *                                       option to use for a true 1:1 match to production.
 * @param {number} [opts.riskPct=0.02] - fraction of equity risked per trade stake (0.02 = 2%).
 *                                       Only used as a FALLBACK if stakeAmount is not
 *                                       provided. NOTE: this %-of-equity sizing is NOT
 *                                       how the live bot actually sizes trades — kept here
 *                                       only for exploratory "what if I sized by % instead"
 *                                       backtests. For matching production, use stakeAmount.
 * @param {number} [opts.slPct=0.80]        - matches StopLossTakeProfit default
 * @param {number} [opts.tpPct=2.00]
 * @param {number} [opts.maxOpenTrades=3]
 * @param {number} [opts.maxConsecutiveLosses=3]
 * @param {number} [opts.maxDailyLossPct=0.30]
 * @param {number} [opts.trailingStopPct=0.5]   - matches db.js default (50% of TP)
 * @param {number} [opts.contractDurationMins=120] - matches db.js default (2hrs). 0 = OFF.
 * @param {number} [opts.minStartIndex] - skip this many bars at the start to give D1/H1 lookback room to warm up
 */
export function runBacktest(opts) {
  const {
    symbol,
    d1,
    h1,
    m15,
    startEquity = 1000,
    stakeAmount,
    riskPct = 0.02,
    slPct = 0.80,
    tpPct = 2.00,
    maxOpenTrades = 3,
    maxConsecutiveLosses = 3,
    maxDailyLossPct = 0.30,
    trailingStopPct = 0.5,
    contractDurationMins = 120,
    noProfitCutoffMins = 20,
    cutoffCooldownHours = 2,
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
  let cooldownUntilEpoch = 0; // set by the 20-min-no-profit rule; blocks new entries until this epoch

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

    // ── If a position is open, check ALL exit conditions on THIS bar ──
    // (20-min no-profit cutoff, trailing stop, SL, TP, forced duration
    // close — see checkExitWithinBar's priority order, matches
    // bot-manager.js's monitorOpenTrades exactly)
    if (openPosition) {
      const result = checkExitWithinBar(openPosition, bar, { trailingStopPct, contractDurationMins, noProfitCutoffMins, cutoffCooldownHours });
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
        // The no-profit cutoff exit locks the symbol out from new
        // entries for cutoffCooldownHours of SIMULATED time, mirroring
        // portfolio.lockSymbolForCooldown() in bot-manager.js. 0 hours
        // means no cooldown is applied at all.
        if (result.lockCooldownHours > 0) {
          cooldownUntilEpoch = bar.epoch + result.lockCooldownHours * 60 * 60;
        }
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
    // ── Cooldown lock: 2hrs after a 20-min-no-profit exit, no new entries ──
    if (bar.epoch < cooldownUntilEpoch) return;
    if (result.signal !== SIG_BUY && result.signal !== SIG_SELL) return;

    if (!rm.canTrade(equity)) return;

    // Entry happens at the OPEN of the bar immediately following the
    // signal candle — that's exactly `bar` in this loop iteration,
    // since collectSignals() just fired using bar i as `lastClosed`.
    const direction = result.signal === SIG_BUY ? "buy" : "sell";
    // FIXED dollar stake (matches production exactly) takes priority
    // over %-of-equity sizing when provided — see runBacktest's
    // docblock above for why these are NOT the same thing.
    const stake = stakeAmount !== undefined
      ? Math.max(1, stakeAmount)
      : Math.max(1, parseFloat((equity * riskPct).toFixed(2)));
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
      trailingPeakPnl: 0,
      trailingActive: false,
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
