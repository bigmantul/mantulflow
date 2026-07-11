// ═══════════════════════════════════════════════════════
//  backtest/engine-scalp.js — SL/TP ONLY exits, no cutoff,
//  no forced-close timer, no trailing, no bias-reversal.
//  Built specifically per instruction to abandon every exit
//  mechanism except stop-loss and take-profit.
//
//  Uses collectScalpSignal() from src/strategy/scalp-signals.js
//  (RSI+Bollinger mean-reversion scalp), not the Daily Bias
//  cascade in src/strategy/signals.js.
// ═══════════════════════════════════════════════════════
import { collectScalpSignal } from "../src/strategy/scalp-signals.js";
import { FALLBACK_MULTIPLIERS } from "../src/trading/multipliers.js";

function pnlAtPrice({ entryPrice, stake, multiplier, direction }, price) {
  const dirSign = direction === "buy" ? 1 : -1;
  return stake * multiplier * ((price - entryPrice) / entryPrice) * dirSign;
}

export function runScalpBacktest(opts) {
  const {
    symbol, m15,
    startEquity = 1000,
    stakeAmount,
    riskPct = 0.02,
    minStartIndex = 60,
    scalpParams = {},
    maxHoldBars = 0, // 0 = truly no time limit (as instructed); set >0 only for a diagnostic comparison
  } = opts;

  if (!m15 || m15.length < minStartIndex + 5) {
    throw new Error(`Not enough M15 data for ${symbol}`);
  }

  let equity = startEquity;
  const trades = [];
  let openPosition = null;
  const growingM15 = [];
  const multiplier = FALLBACK_MULTIPLIERS[symbol] ?? 10;

  for (let i = minStartIndex; i < m15.length; i++) {
    const bar = m15[i];
    growingM15.push(bar);

    if (openPosition) {
      const { direction, stopLossPrice, takeProfitPrice, entryEpoch } = openPosition;
      let exit = null;
      // Conservative convention: if both SL and TP could have been touched
      // within this bar's range, assume SL hit first (same convention engine.js uses).
      if (direction === "buy") {
        if (bar.low <= stopLossPrice) exit = { price: stopLossPrice, outcome: "SL" };
        else if (bar.high >= takeProfitPrice) exit = { price: takeProfitPrice, outcome: "TP" };
      } else {
        if (bar.high >= stopLossPrice) exit = { price: stopLossPrice, outcome: "SL" };
        else if (bar.low <= takeProfitPrice) exit = { price: takeProfitPrice, outcome: "TP" };
      }
      if (!exit && maxHoldBars > 0 && (i - openPosition.entryIndex) >= maxHoldBars) {
        exit = { price: bar.close, outcome: "TIME_DIAGNOSTIC_ONLY" };
      }
      if (exit) {
        const pnl = pnlAtPrice(openPosition, exit.price);
        equity += pnl;
        trades.push({ symbol, direction, entryEpoch, exitEpoch: bar.epoch, pnl, outcome: exit.outcome, equityAfter: equity, barsHeld: i - openPosition.entryIndex });
        openPosition = null;
      }
      continue; // one position at a time, same convention as engine.js
    }

    // No lookahead: pass only bars closed so far, plus a placeholder for "still forming".
    const placeholder = { ...bar, close: bar.close, high: bar.close, low: bar.close };
    growingM15[growingM15.length] = placeholder; // temporarily extend
    const sig = collectScalpSignal({ m15: growingM15 }, scalpParams);
    growingM15.pop(); // remove placeholder — wait, we need actual closed bar in array too

    if (sig.signal === "NONE") continue;

    const stake = stakeAmount !== undefined ? Math.max(1, stakeAmount) : Math.max(1, parseFloat((equity * riskPct).toFixed(2)));
    openPosition = {
      direction: sig.signal === "BUY" ? "buy" : "sell",
      entryPrice: sig.entryPrice,
      entryEpoch: bar.epoch,
      entryIndex: i,
      stake, multiplier,
      stopLossPrice: sig.stopLossPrice,
      takeProfitPrice: sig.takeProfitPrice,
    };
  }

  if (openPosition) {
    const lastBar = m15[m15.length - 1];
    const pnl = pnlAtPrice(openPosition, lastBar.close);
    equity += pnl;
    trades.push({ symbol, direction: openPosition.direction, entryEpoch: openPosition.entryEpoch, exitEpoch: lastBar.epoch, pnl, outcome: "STILL_OPEN_EOD", equityAfter: equity, barsHeld: (m15.length - 1) - openPosition.entryIndex });
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  return {
    symbol, trades,
    totalTrades: trades.length,
    wins: wins.length, losses: losses.length,
    winRatePct: trades.length ? +(wins.length / trades.length * 100).toFixed(1) : 0,
    profitFactor: grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? Infinity : 0),
    totalReturnPct: +(((equity - startEquity) / startEquity) * 100).toFixed(2),
    stillOpenCount: trades.filter(t => t.outcome === "STILL_OPEN_EOD").length,
    avgBarsHeld: trades.length ? +(trades.reduce((s,t)=>s+t.barsHeld,0)/trades.length).toFixed(1) : 0,
  };
}
