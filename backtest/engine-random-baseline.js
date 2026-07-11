// ═══════════════════════════════════════════════════════
//  backtest/engine-random-baseline.js  — DIAGNOSTIC ONLY
//
//  Not part of production or the normal backtest suite. This is a
//  one-off copy of engine.js with exactly one change: at the point
//  where a real signal fires, a seeded coin flip has a 50% chance
//  of taking the OPPOSITE direction instead of the signal's real
//  call. Entry timing, entry frequency, and every exit rule are
//  byte-for-byte identical to engine.js.
//
//  Purpose: if collectSignals()'s direction call has no real skill,
//  flipping it 50% of the time should perform statistically the
//  same as the real signal (both are then coin flips). If flipping
//  it makes things meaningfully WORSE, that's evidence the real
//  signal's direction call is adding genuine value on top of the
//  exit engineering. Delete this file once the question is answered
//  — it should never be imported by run-all.js/walk-forward.js.
// ═══════════════════════════════════════════════════════

import {
  collectSignals,
  resetSymbolState,
  SIG_BUY,
  SIG_SELL,
} from "../src/strategy/signals.js";
import { RiskManager, StopLossTakeProfit } from "../src/risk/risk-manager.js";
import { FALLBACK_MULTIPLIERS } from "../src/trading/multipliers.js";

// Seeded PRNG (mulberry32) so a given seed always produces the same
// sequence of flips — reproducible, not "got lucky" noise.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _clockBox = { ms: Date.now() };
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) return new RealDate(_clockBox.ms);
    return new RealDate(...args);
  }
  static now() { return _clockBox.ms; }
}
function withFakeNow(simulatedMs, fn) {
  _clockBox.ms = simulatedMs;
  globalThis.Date = FakeDate;
  try { return fn(); } finally { globalThis.Date = RealDate; }
}

function makeClosedCounter(arr, durationSecs) {
  let i = 0;
  return function countClosed(targetEpoch) {
    while (i < arr.length && arr[i].epoch + durationSecs <= targetEpoch) i++;
    return i;
  };
}

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

function priceForPnl(position, targetPnl) {
  const { entryPrice, stake, multiplier, direction } = position;
  const dirSign = direction === "buy" ? 1 : -1;
  return entryPrice * (1 + (targetPnl / (stake * multiplier)) * dirSign);
}

function checkExitWithinBar(position, bar, opts) {
  const { trailingStopPct = 0.5, contractDurationMins = 120, noProfitCutoffMins = 20, cutoffCooldownHours = 2 } = opts;
  const { stopLoss, takeProfit, direction, entryEpoch } = position;

  const worstPrice = direction === "buy" ? bar.low : bar.high;
  const bestPrice  = direction === "buy" ? bar.high : bar.low;
  const worstPnl   = pnlAtPrice(position, worstPrice);
  const bestPnl    = pnlAtPrice(position, bestPrice);

  const minutesOpen = (bar.epoch - entryEpoch) / 60;

  const closePnl = pnlAtPrice(position, bar.close);
  if (noProfitCutoffMins > 0 && minutesOpen >= noProfitCutoffMins && closePnl <= 0) {
    return { exit: true, exitPrice: bar.close, pnl: closePnl, outcome: "NO_PROFIT_CUTOFF", lockCooldownHours: cutoffCooldownHours };
  }

  if (trailingStopPct > 0 && takeProfit > 0) {
    const stepSize  = takeProfit * trailingStopPct;
    const priorPeak = position.trailingPeakPnl || 0;
    const newPeak   = Math.max(priorPeak, bestPnl);
    if (newPeak > priorPeak) position.trailingPeakPnl = newPeak;

    if (newPeak >= stepSize) {
      const stepsBanked = Math.floor(newPeak / stepSize);
      const lockedProfit = stepsBanked * stepSize;
      const trailingFloorPnl = Math.max(lockedProfit - stepSize, 0);
      position.trailingActive = true;

      if (worstPnl <= trailingFloorPnl) {
        const exitPrice = priceForPnl(position, trailingFloorPnl);
        return { exit: true, exitPrice, pnl: trailingFloorPnl, outcome: trailingFloorPnl > 0 ? "TRAIL" : "TRAIL_BE" };
      }
    }
  }

  if (worstPnl <= -stopLoss) {
    const exitPrice = priceForPnl(position, -stopLoss);
    return { exit: true, exitPrice, pnl: -stopLoss, outcome: "SL" };
  }

  if (bestPnl >= takeProfit) {
    const exitPrice = priceForPnl(position, takeProfit);
    return { exit: true, exitPrice, pnl: takeProfit, outcome: "TP" };
  }

  if (contractDurationMins > 0 && minutesOpen >= contractDurationMins) {
    return { exit: true, exitPrice: bar.close, pnl: closePnl, outcome: "FORCED_CLOSE" };
  }

  return { exit: false };
}

export function runRandomBaseline(opts) {
  const {
    symbol, d1, h1, m15,
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
    seed = 42,
  } = opts;

  if (!m15 || m15.length < minStartIndex + 5) {
    throw new Error(`Not enough M15 data for ${symbol} (need > ${minStartIndex + 5} bars, got ${m15?.length ?? 0})`);
  }

  const rand = mulberry32(seed);
  resetSymbolState(symbol);

  const rm = new RiskManager({ maxOpenTrades, maxConsecutiveLosses, maxDailyLossPct });
  rm.setStartingBalance(startEquity);
  const sltp = new StopLossTakeProfit({ slPct, tpPct });

  const d1Counter = makeClosedCounter(d1, 86400);
  const h1Counter = makeClosedCounter(h1, 3600);

  let equity = startEquity;
  const equityCurve = [{ epoch: m15[0].epoch, equity }];
  const trades = [];
  let openPosition = null;
  let cooldownUntilEpoch = 0;
  let flippedCount = 0, keptCount = 0;

  const growingD1 = [];
  const growingH1 = [];
  const growingM15 = [];
  let d1Pushed = 0;
  let h1Pushed = 0;

  for (let i = minStartIndex; i < m15.length; i++) {
    const bar = m15[i];

    withFakeNow(bar.epoch * 1000, () => {

    const targetD1Count = d1Counter(bar.epoch);
    while (d1Pushed < targetD1Count) growingD1.push(d1[d1Pushed++]);
    const targetH1Count = h1Counter(bar.epoch);
    while (h1Pushed < targetH1Count) growingH1.push(h1[h1Pushed++]);
    growingM15.push(bar);

    if (growingD1.length < 4 || growingH1.length < 20) return;

    pushPlaceholder(growingD1);
    pushPlaceholder(growingH1);
    pushPlaceholder(growingM15);

    let signalResult;
    try {
      const tf = { d1: growingD1, h1: growingH1, m15: growingM15, symbol };
      signalResult = collectSignals(tf);
    } finally {
      growingD1.pop();
      growingH1.pop();
      growingM15.pop();
    }

    if (openPosition) {
      const currentBias  = signalResult.dailyBias;
      const positionBias = openPosition.direction === "buy" ? "bullish" : "bearish";
      const biasFlipped  = currentBias !== "none" && currentBias !== positionBias;

      if (biasFlipped) {
        const pnl = pnlAtPrice(openPosition, bar.close);
        equity += pnl;
        rm.tradeClosed(pnl);
        trades.push({ symbol, direction: openPosition.direction, entryEpoch: openPosition.entryEpoch, entryPrice: openPosition.entryPrice, exitEpoch: bar.epoch, exitPrice: bar.close, stake: openPosition.stake, multiplier: openPosition.multiplier, pnl, outcome: "BIAS_REVERSAL", equityAfter: equity });
        equityCurve.push({ epoch: bar.epoch, equity });
        openPosition = null;
        return;
      }

      const exitResult = checkExitWithinBar(openPosition, bar, { trailingStopPct, contractDurationMins, noProfitCutoffMins, cutoffCooldownHours });
      if (exitResult.exit) {
        equity += exitResult.pnl;
        rm.tradeClosed(exitResult.pnl);
        trades.push({ symbol, direction: openPosition.direction, entryEpoch: openPosition.entryEpoch, entryPrice: openPosition.entryPrice, exitEpoch: bar.epoch, exitPrice: exitResult.exitPrice, stake: openPosition.stake, multiplier: openPosition.multiplier, pnl: exitResult.pnl, outcome: exitResult.outcome, equityAfter: equity });
        equityCurve.push({ epoch: bar.epoch, equity });
        if (exitResult.lockCooldownHours > 0) cooldownUntilEpoch = bar.epoch + exitResult.lockCooldownHours * 60 * 60;
        openPosition = null;
      }
    }

    if (openPosition) return;
    if (bar.epoch < cooldownUntilEpoch) return;
    if (signalResult.signal !== SIG_BUY && signalResult.signal !== SIG_SELL) return;
    if (!rm.canTrade(equity)) return;

    // ── THE ONLY SUBSTANTIVE CHANGE vs engine.js ──
    // 50/50 seeded coin flip decides whether we take the real signal's
    // direction or its exact opposite. Entry TIMING (this bar fires,
    // same as production) is untouched — only which side we take.
    const realDirection = signalResult.signal === SIG_BUY ? "buy" : "sell";
    const flip = rand() < 0.5;
    const direction = flip ? (realDirection === "buy" ? "sell" : "buy") : realDirection;
    if (flip) flippedCount++; else keptCount++;

    const stake = stakeAmount !== undefined ? Math.max(1, stakeAmount) : Math.max(1, parseFloat((equity * riskPct).toFixed(2)));
    const multiplier = FALLBACK_MULTIPLIERS[symbol] ?? 10;
    const limitOrder = sltp.getMultiplierLimitOrder(stake);

    openPosition = {
      direction, entryEpoch: bar.epoch, entryPrice: bar.open, stake, multiplier,
      stopLoss: limitOrder.stop_loss, takeProfit: limitOrder.take_profit,
      trailingPeakPnl: 0, trailingActive: false,
    };
    rm.tradeOpened();

    });
  }

  if (openPosition) {
    const lastBar = m15[m15.length - 1];
    const pnl = pnlAtPrice(openPosition, lastBar.close);
    equity += pnl;
    trades.push({ symbol, direction: openPosition.direction, entryEpoch: openPosition.entryEpoch, entryPrice: openPosition.entryPrice, exitEpoch: lastBar.epoch, exitPrice: lastBar.close, stake: openPosition.stake, multiplier: openPosition.multiplier, pnl, outcome: "EOD_MARK", equityAfter: equity });
    equityCurve.push({ epoch: lastBar.epoch, equity });
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  return {
    symbol,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? parseFloat(((wins.length / trades.length) * 100).toFixed(1)) : 0,
    profitFactor: grossLoss > 0 ? parseFloat((grossProfit / grossLoss).toFixed(2)) : (grossProfit > 0 ? Infinity : 0),
    totalReturnPct: parseFloat((((equity - startEquity) / startEquity) * 100).toFixed(2)),
    flippedCount, keptCount,
  };
}
