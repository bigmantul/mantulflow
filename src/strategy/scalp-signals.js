// ═══════════════════════════════════════════════════════
//  src/strategy/scalp-signals.js  — CANDIDATE, NOT YET LIVE
//
//  A short-timeframe (M15) mean-reversion scalp: price stretches to
//  a Bollinger Band extreme while RSI confirms the extreme, enter
//  expecting a snap back toward the mid-band. Deliberately much
//  higher-frequency and much shorter-hold than the Daily Bias
//  cascade in signals.js — that's a multi-stage trend-continuation
//  model, this is the opposite style (fade the stretch, not follow
//  the break).
//
//  Exits are ONLY stop-loss / take-profit, sized off each symbol's
//  own recent ATR rather than a flat percentage — a fixed % SL/TP
//  (like the 0.80/2.00 in risk-manager.js) turned out to almost
//  never get hit for these instruments (see backtest results),
//  which is exactly why this file exists.
//
//  Parameters are meant to be tuned PER CATEGORY (forex vs crypto
//  vs each synthetic family) — see backtest/scalp-sweep.mjs for the
//  actual tuned values per category, chosen empirically against the
//  real 1yr dataset, not guessed.
// ═══════════════════════════════════════════════════════

export const SIG_BUY = "BUY";
export const SIG_SELL = "SELL";
export const SIG_NONE = "NONE";

function sma(values) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stddev(values, mean) {
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// Standard Wilder's RSI over closes.
export function calcRsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses += -diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function calcBollinger(closes, period = 20, mult = 2) {
  const window = closes.slice(-period);
  const mid = sma(window);
  const sd = stddev(window, mid);
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
}

// True Range ATR over OHLC candles (Wilder-style simple average, not smoothed —
// fine for the sizing-only use here, doesn't need to match signals.js's calcAtr exactly).
export function calcAtrLocal(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return sma(trs);
}

/**
 * @param {object} tf - { m15: [...closed candles, last one still forming] }
 * @param {object} params
 * @param {number} params.rsiPeriod
 * @param {number} params.bbPeriod
 * @param {number} params.bbMult
 * @param {number} params.oversold
 * @param {number} params.overbought
 * @param {number} params.atrPeriod
 * @param {number} params.slAtrMult   - stop distance = slAtrMult * ATR
 * @param {number} params.tpAtrMult  - target distance = tpAtrMult * ATR
 */
export function collectScalpSignal(tf, params) {
  const {
    rsiPeriod = 14, bbPeriod = 20, bbMult = 2,
    oversold = 30, overbought = 70,
    atrPeriod = 14, slAtrMult = 0.6, tpAtrMult = 0.6,
    requireConfirmation = false,
  } = params;

  const m15 = tf.m15;
  if (!m15 || m15.length < Math.max(rsiPeriod, bbPeriod, atrPeriod) + 6) {
    return { signal: SIG_NONE };
  }
  const needed = Math.max(rsiPeriod, bbPeriod, atrPeriod) + 3;
  const closed = m15.slice(-(needed + 1), -1); // drop still-forming candle, keep only the tail window we need
  const closes = closed.map(c => c.close);
  const last = closed[closed.length - 1];
  const prev = closed[closed.length - 2];

  const rsi = calcRsi(closes, rsiPeriod);
  const bb = calcBollinger(closes, bbPeriod, bbMult);
  const atr = calcAtrLocal(closed, atrPeriod);
  if (atr <= 0) return { signal: SIG_NONE };

  const slDist = atr * slAtrMult;
  const tpDist = atr * tpAtrMult;

  if (!requireConfirmation) {
    if (last.close <= bb.lower && rsi <= oversold) {
      return { signal: SIG_BUY, entryPrice: last.close, stopLossPrice: last.close - slDist, takeProfitPrice: last.close + tpDist, rsi, bb, atr };
    }
    if (last.close >= bb.upper && rsi >= overbought) {
      return { signal: SIG_SELL, entryPrice: last.close, stopLossPrice: last.close + slDist, takeProfitPrice: last.close - tpDist, rsi, bb, atr };
    }
    return { signal: SIG_NONE };
  }

  // Confirmation mode: the PREVIOUS candle had to be the one touching the
  // extreme + RSI condition; THIS candle must show price already moving
  // back toward the mid-band (a green candle off the low, or red candle
  // off the high) before we commit — costs a little entry price, aims to
  // skip knives that are still falling/spiking when we'd otherwise enter.
  const prevRsi = calcRsi(closes.slice(0, -1), rsiPeriod);
  const wasOversold = prev.close <= bb.lower && prevRsi <= oversold;
  const wasOverbought = prev.close >= bb.upper && prevRsi >= overbought;

  if (wasOversold && last.close > prev.close) {
    return { signal: SIG_BUY, entryPrice: last.close, stopLossPrice: prev.low - slDist, takeProfitPrice: last.close + tpDist, rsi, bb, atr };
  }
  if (wasOverbought && last.close < prev.close) {
    return { signal: SIG_SELL, entryPrice: last.close, stopLossPrice: prev.high + slDist, takeProfitPrice: last.close - tpDist, rsi, bb, atr };
  }
  return { signal: SIG_NONE };
}
