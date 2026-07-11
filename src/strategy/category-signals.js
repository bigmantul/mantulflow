// ═══════════════════════════════════════════════════════
//  src/strategy/category-signals.js — CANDIDATES, NOT LIVE
//
//  A small library of genuinely different entry primitives, meant
//  to be tested against each instrument category rather than
//  assumed to fit all of them. Each takes M15 candles (last one
//  still forming, dropped internally) and returns a signal.
// ═══════════════════════════════════════════════════════
import { calcRsi, calcBollinger, calcAtrLocal } from "./scalp-signals.js";

export const SIG_BUY = "BUY", SIG_SELL = "SELL", SIG_NONE = "NONE";

function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

// A) EMA CROSSOVER MOMENTUM — trend-following. Fast EMA crosses
// above/below slow EMA, with a minimum separation (as % of price)
// required so we're not firing on noise right at the cross.
export function emaCrossoverSignal(tf, params) {
  const { fastPeriod = 9, slowPeriod = 21, minSeparationPct = 0.0005, atrPeriod = 14, slAtrMult = 1.0, tpAtrMult = 2.0 } = params;
  const m15 = tf.m15;
  const need = Math.max(fastPeriod, slowPeriod, atrPeriod) * 3;
  if (!m15 || m15.length < need + 3) return { signal: SIG_NONE };
  const closed = m15.slice(-(need + 1), -1);
  const closes = closed.map(c => c.close);
  const last = closed[closed.length - 1];

  const fastNow = ema(closes.slice(-fastPeriod * 3), fastPeriod);
  const slowNow = ema(closes.slice(-slowPeriod * 3), slowPeriod);
  const fastPrev = ema(closes.slice(-fastPeriod * 3 - 1, -1), fastPeriod);
  const slowPrev = ema(closes.slice(-slowPeriod * 3 - 1, -1), slowPeriod);

  const sepPct = Math.abs(fastNow - slowNow) / last.close;
  const atr = calcAtrLocal(closed, atrPeriod);
  if (atr <= 0 || sepPct < minSeparationPct) return { signal: SIG_NONE };

  const crossedUp = fastPrev <= slowPrev && fastNow > slowNow;
  const crossedDown = fastPrev >= slowPrev && fastNow < slowNow;
  if (crossedUp) return { signal: SIG_BUY, entryPrice: last.close, stopLossPrice: last.close - atr*slAtrMult, takeProfitPrice: last.close + atr*tpAtrMult };
  if (crossedDown) return { signal: SIG_SELL, entryPrice: last.close, stopLossPrice: last.close + atr*slAtrMult, takeProfitPrice: last.close - atr*tpAtrMult };
  return { signal: SIG_NONE };
}

// B) DONCHIAN BREAKOUT — price closes beyond the highest-high /
// lowest-low of the last N candles (excluding current). Classic
// breakout/trend-continuation.
export function donchianBreakoutSignal(tf, params) {
  const { lookback = 20, atrPeriod = 14, slAtrMult = 1.5, tpAtrMult = 2.5 } = params;
  const m15 = tf.m15;
  if (!m15 || m15.length < lookback + atrPeriod + 3) return { signal: SIG_NONE };
  const closed = m15.slice(-(lookback + atrPeriod + 2), -1);
  const last = closed[closed.length - 1];
  const priorWindow = closed.slice(-(lookback + 1), -1);
  const highestHigh = Math.max(...priorWindow.map(c => c.high));
  const lowestLow = Math.min(...priorWindow.map(c => c.low));
  const atr = calcAtrLocal(closed, atrPeriod);
  if (atr <= 0) return { signal: SIG_NONE };

  if (last.close > highestHigh) return { signal: SIG_BUY, entryPrice: last.close, stopLossPrice: last.close - atr*slAtrMult, takeProfitPrice: last.close + atr*tpAtrMult };
  if (last.close < lowestLow) return { signal: SIG_SELL, entryPrice: last.close, stopLossPrice: last.close + atr*slAtrMult, takeProfitPrice: last.close - atr*tpAtrMult };
  return { signal: SIG_NONE };
}

// C) STREAK CONTINUATION/REVERSION — after N consecutive same-
// direction closes, either bet the streak continues (mode:
// "continue") or bet it snaps back (mode: "revert"). Cheap,
// structure-agnostic — good fit for Step indices' discrete moves
// and as a control test for the others.
export function streakSignal(tf, params) {
  const { streakLen = 4, mode = "continue", atrPeriod = 14, slAtrMult = 1.0, tpAtrMult = 1.5 } = params;
  const m15 = tf.m15;
  if (!m15 || m15.length < streakLen + atrPeriod + 3) return { signal: SIG_NONE };
  const closed = m15.slice(-(streakLen + atrPeriod + 2), -1);
  const last = closed[closed.length - 1];
  const tail = closed.slice(-streakLen);
  let allUp = true, allDown = true;
  for (let i = 1; i < tail.length; i++) {
    if (tail[i].close <= tail[i-1].close) allUp = false;
    if (tail[i].close >= tail[i-1].close) allDown = false;
  }
  const atr = calcAtrLocal(closed, atrPeriod);
  if (atr <= 0) return { signal: SIG_NONE };

  let dir = null;
  if (allUp) dir = mode === "continue" ? "buy" : "sell";
  if (allDown) dir = mode === "continue" ? "sell" : "buy";
  if (!dir) return { signal: SIG_NONE };

  if (dir === "buy") return { signal: SIG_BUY, entryPrice: last.close, stopLossPrice: last.close - atr*slAtrMult, takeProfitPrice: last.close + atr*tpAtrMult };
  return { signal: SIG_SELL, entryPrice: last.close, stopLossPrice: last.close + atr*slAtrMult, takeProfitPrice: last.close - atr*tpAtrMult };
}

// D) SPIKE-AWARE DRIFT-FOLLOW — built for Boom/Crash specifically.
// Trades WITH the recent measured local drift (not an assumed
// folklore direction — measured over the last `driftLookback`
// candles), but skips entries right after an unusually large single
// candle (a likely spike), since a) that's the event these indices
// are built around and b) tight stops get blown through by it.
export function spikeAwareDriftSignal(tf, params) {
  const { driftLookback = 30, spikeAtrMult = 3, atrPeriod = 14, slAtrMult = 2.0, tpAtrMult = 1.0 } = params;
  const m15 = tf.m15;
  if (!m15 || m15.length < driftLookback + atrPeriod + 3) return { signal: SIG_NONE };
  const closed = m15.slice(-(driftLookback + atrPeriod + 2), -1);
  const last = closed[closed.length - 1];
  const atr = calcAtrLocal(closed, atrPeriod);
  if (atr <= 0) return { signal: SIG_NONE };

  // Was the last candle itself a spike? If so, sit out — too close to
  // the event these indices are built around, and stops don't hold up.
  const lastMove = Math.abs(last.close - last.open);
  if (lastMove > atr * spikeAtrMult) return { signal: SIG_NONE };

  const driftWindow = closed.slice(-driftLookback);
  const netDrift = driftWindow[driftWindow.length-1].close - driftWindow[0].close;
  const driftStrength = Math.abs(netDrift) / atr;
  if (driftStrength < 1.0) return { signal: SIG_NONE }; // not enough measured drift to trade

  const dir = netDrift > 0 ? "buy" : "sell";
  if (dir === "buy") return { signal: SIG_BUY, entryPrice: last.close, stopLossPrice: last.close - atr*slAtrMult, takeProfitPrice: last.close + atr*tpAtrMult };
  return { signal: SIG_SELL, entryPrice: last.close, stopLossPrice: last.close + atr*slAtrMult, takeProfitPrice: last.close - atr*tpAtrMult };
}

export const PRIMITIVES = {
  ema_crossover: emaCrossoverSignal,
  donchian_breakout: donchianBreakoutSignal,
  streak_continue: (tf, p) => streakSignal(tf, { ...p, mode: "continue" }),
  streak_revert: (tf, p) => streakSignal(tf, { ...p, mode: "revert" }),
  spike_aware_drift: spikeAwareDriftSignal,
};
