// ═══════════════════════════════════════════════════════
//  src/strategy/signals.js
//
//  MULTI-STRATEGY SIGNAL ENGINE
//
//  5 Independent Strategies:
//    1. Trend Following   (4H / 30M / 15M)
//    2. Supply & Demand   (4H / 1H / 15M)
//    3. Smart Money (SMC) (4H / 30M / 15M)
//    4. Breakout          (1H / 15M)
//    5. Mean Reversion    (1H / 15M)
//
//  Signal Collection:
//    Each strategy returns BUY | SELL | HOLD
//    Conflict engine combines all signals per symbol
//    BUY + SELL on same cycle → HOLD (no trade)
//    BUY only (+ HOLDs)       → BUY trade
//    SELL only (+ HOLDs)      → SELL trade
//
//  Market Classification:
//    FX / Metals  → session filter required
//    Synthetics   → 24/7, no session filter
//    Crypto       → 24/7, volatility filter only
// ═══════════════════════════════════════════════════════

// ── SIGNAL CONSTANTS ──────────────────────────────────
export const SIG_BUY  =  1;
export const SIG_SELL = -1;
export const SIG_HOLD =  0;

// ── MARKET HOURS ──────────────────────────────────────
const LONDON_START   = 7;
const LONDON_END     = 16;
const NY_START       = 12;
const NY_END         = 21;

const FX_SYMBOLS = new Set([
  "frxEURUSD","frxGBPUSD","frxUSDJPY","frxUSDCHF",
  "frxAUDUSD","frxUSDCAD","frxNZDUSD",
  "frxGBPJPY","frxEURGBP","frxEURCHF","frxEURCAD","frxEURAUD",
  "frxXAUUSD","frxXAGUSD",
]);

const SYNTHETIC_SYMBOLS = new Set([
  "BOOM500","CRASH500","JD75","JD100","R_75","R_100",
]);

const CRYPTO_SYMBOLS = new Set([
  "cryBTCUSD","cryETHUSD",
]);

export function isMarketOpen(symbol) {
  // Synthetics and crypto trade 24/7
  if (SYNTHETIC_SYMBOLS.has(symbol) || CRYPTO_SYMBOLS.has(symbol)) return true;

  // FX / Metals — must be in London or NY session
  const hour = new Date().getUTCHours();
  const day  = new Date().getUTCDay();

  // Weekend block for FX
  const isSaturday         = day === 6;
  const isSundayBeforeOpen = day === 0 && hour < 21;
  const isFridayAfterClose = day === 5 && hour >= 21;
  if (isSaturday || isSundayBeforeOpen || isFridayAfterClose) return false;

  const inLondon = hour >= LONDON_START && hour < LONDON_END;
  const inNY     = hour >= NY_START     && hour < NY_END;
  return inLondon || inNY;
}

export function sessionName() {
  const hour    = new Date().getUTCHours();
  const london  = hour >= LONDON_START && hour < LONDON_END;
  const ny      = hour >= NY_START     && hour < NY_END;
  if (london && ny) return "London+NY overlap";
  if (london)       return "London";
  if (ny)           return "New York";
  return "off-session";
}

// ── MATH / INDICATOR HELPERS ──────────────────────────

function ema(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length < period) return result;
  const k     = 2 / (period + 1);
  const start = period - 1;
  result[start] = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = start + 1; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains  += diff;
    else           losses -= diff;
  }
  let avgGain = gains  / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function bollingerBands(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean  = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { upper: mean + stdDev * sd, middle: mean, lower: mean - stdDev * sd };
}

function atrValues(df, period = 14) {
  const tr = [];
  for (let i = 1; i < df.length; i++) {
    tr.push(Math.max(
      df[i].high - df[i].low,
      Math.abs(df[i].high - df[i - 1].close),
      Math.abs(df[i].low  - df[i - 1].close),
    ));
  }
  const vals = new Array(tr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < period && i < tr.length; i++) sum += tr[i];
  if (tr.length >= period) {
    vals[period - 1] = sum / period;
    for (let i = period; i < tr.length; i++) {
      vals[i] = (vals[i - 1] * (period - 1) + tr[i]) / period;
    }
  }
  return vals;
}

function getAtr(df, period = 14) {
  const vals = atrValues(df, period);
  for (let i = vals.length - 1; i >= 0; i--) {
    if (vals[i] !== null) return vals[i];
  }
  return 0;
}

export function getAtrPct(df, period = 14) {
  const atr   = getAtr(df, period);
  const price = df[df.length - 1].close;
  return price > 0 ? atr / price : 0;
}

export function marketIsTradeable(df) {
  if (!df || df.length < 20) return false;
  const pct = getAtrPct(df);
  return pct >= 0.00005 && pct <= 0.10;
}

export function getVolatilityScalar(df) {
  const pct = Math.max(getAtrPct(df), 0.0001);
  return parseFloat(Math.max(0.25, Math.min(1.0, 0.003 / pct)).toFixed(4));
}

// ── SWING POINTS ──────────────────────────────────────

function getSwingPoints(df, lookback = 5) {
  const highs = [], lows = [];
  const end = df.length - lookback;
  for (let i = lookback; i < end; i++) {
    const sliceH = df.slice(i - lookback, i + lookback + 1).map(c => c.high);
    const sliceL = df.slice(i - lookback, i + lookback + 1).map(c => c.low);
    if (df[i].high === Math.max(...sliceH)) highs.push({ idx: i, price: df[i].high });
    if (df[i].low  === Math.min(...sliceL)) lows.push({  idx: i, price: df[i].low  });
  }
  return { highs, lows };
}

function getMarketStructure(df, lookback = 3) {
  const { highs, lows } = getSwingPoints(df, lookback);
  if (highs.length < 2 || lows.length < 2) return "neutral";
  const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
  const hl = lows[lows.length - 1].price   > lows[lows.length - 2].price;
  const lh = highs[highs.length - 1].price < highs[highs.length - 2].price;
  const ll = lows[lows.length - 1].price   < lows[lows.length - 2].price;
  if (hh && hl) return "bullish";
  if (lh && ll) return "bearish";
  return "neutral";
}

// ── EMA ANALYSIS ──────────────────────────────────────

function getEmaAnalysis(df, emaPeriod = 50) {
  if (df.length < emaPeriod + 5) return { valid: false };
  const closes  = df.map(c => c.close);
  const emaVals = ema(closes, emaPeriod);
  const len     = df.length;
  const e50Now  = emaVals[len - 2];
  const e50Prev = emaVals[len - 7];
  if (e50Now === null || e50Prev === null) return { valid: false };

  const price      = closes[len - 2];
  const priceAbove = price > e50Now;
  const slopeDiff  = e50Now - e50Prev;
  const pricePct   = Math.abs(slopeDiff) / e50Now;

  let slope;
  if (pricePct < 0.0001)  slope = "flat";
  else if (slopeDiff > 0) slope = "rising";
  else                    slope = "falling";

  return { valid: true, priceAbove, slope, e50: e50Now };
}

// ── CANDLE QUALITY ────────────────────────────────────

function isBullishCandle(candle) {
  if (!candle) return false;
  const body  = candle.close - candle.open;
  const range = candle.high - candle.low;
  if (range === 0) return false;
  return body > 0 && (body / range) >= 0.4;
}

function isBearishCandle(candle) {
  if (!candle) return false;
  const body  = candle.open - candle.close;
  const range = candle.high - candle.low;
  if (range === 0) return false;
  return body > 0 && (body / range) >= 0.4;
}

function isStrongBullish(candle) {
  if (!candle) return false;
  const body  = candle.close - candle.open;
  const range = candle.high - candle.low;
  if (range === 0) return false;
  return body > 0 && (body / range) >= 0.6 && (candle.high - candle.close) / range < 0.25;
}

function isStrongBearish(candle) {
  if (!candle) return false;
  const body  = candle.open - candle.close;
  const range = candle.high - candle.low;
  if (range === 0) return false;
  return body > 0 && (body / range) >= 0.6 && (candle.close - candle.low) / range < 0.25;
}

// ═══════════════════════════════════════════════════════
//  STRATEGY 1 — TREND FOLLOWING
//  4H bias → 30M pullback → 15M entry
// ═══════════════════════════════════════════════════════

function strategyTrendFollowing(dfH4, dfM30, dfM15) {
  try {
    if (!dfH4 || dfH4.length < 55) return SIG_HOLD;
    if (!dfM30 || dfM30.length < 55) return SIG_HOLD;
    if (!dfM15 || dfM15.length < 20) return SIG_HOLD;

    // ── Phase 1: 4H Bias ──
    const h4Ema  = getEmaAnalysis(dfH4);
    const h4Str  = getMarketStructure(dfH4, 3);
    if (!h4Ema.valid || h4Ema.slope === "flat") return SIG_HOLD;
    if (h4Str === "neutral") return SIG_HOLD;

    const bullBias = h4Ema.priceAbove && h4Ema.slope === "rising"  && h4Str === "bullish";
    const bearBias = !h4Ema.priceAbove && h4Ema.slope === "falling" && h4Str === "bearish";
    if (!bullBias && !bearBias) return SIG_HOLD;

    // ── Phase 2: 30M Confirmation ──
    const m30Ema = getEmaAnalysis(dfM30);
    const m30Str = getMarketStructure(dfM30, 3);
    if (!m30Ema.valid) return SIG_HOLD;

    if (bullBias) {
      if (!m30Ema.priceAbove) return SIG_HOLD;
      if (m30Str !== "bullish") return SIG_HOLD;
      // Pullback: recent close < 5-bar-ago close (price pulled back)
      const recent = dfM30.slice(-10).map(c => c.close);
      const pulledBack = Math.min(...recent.slice(0, 7)) < recent[0];
      if (!pulledBack) return SIG_HOLD;
    }

    if (bearBias) {
      if (m30Ema.priceAbove) return SIG_HOLD;
      if (m30Str !== "bearish") return SIG_HOLD;
      const recent = dfM30.slice(-10).map(c => c.close);
      const pulledBack = Math.max(...recent.slice(0, 7)) > recent[0];
      if (!pulledBack) return SIG_HOLD;
    }

    // ── Phase 3: 15M Entry ──
    const trigger = dfM15[dfM15.length - 2]; // last closed candle
    if (bullBias) {
      // Need higher low on 15M + bullish confirmation candle
      const { lows } = getSwingPoints(dfM15, 3);
      const hasHL = lows.length >= 2 && lows[lows.length - 1].price > lows[lows.length - 2].price;
      if (!hasHL) return SIG_HOLD;
      if (!isBullishCandle(trigger)) return SIG_HOLD;
      return SIG_BUY;
    }

    if (bearBias) {
      const { highs } = getSwingPoints(dfM15, 3);
      const hasLH = highs.length >= 2 && highs[highs.length - 1].price < highs[highs.length - 2].price;
      if (!hasLH) return SIG_HOLD;
      if (!isBearishCandle(trigger)) return SIG_HOLD;
      return SIG_SELL;
    }

  } catch { return SIG_HOLD; }
  return SIG_HOLD;
}

// ═══════════════════════════════════════════════════════
//  STRATEGY 2 — SUPPLY & DEMAND
//  4H/1H zone detection → 15M rejection entry
// ═══════════════════════════════════════════════════════

function detectZones(df, lookback = 5) {
  // A zone is where price had a strong impulse AWAY from a level
  // Demand: strong bullish impulse after low → price returned to test that low area
  // Supply: strong bearish impulse after high → price returned to test that high area
  const zones = { demand: [], supply: [] };
  if (!df || df.length < lookback * 3) return zones;

  for (let i = lookback; i < df.length - lookback; i++) {
    const candle = df[i];
    const body   = Math.abs(candle.close - candle.open);
    const range  = candle.high - candle.low;
    if (range === 0) continue;
    const bodyRatio = body / range;

    // Strong bullish impulse candle → marks a demand zone
    if (candle.close > candle.open && bodyRatio >= 0.6) {
      zones.demand.push({
        top:    Math.max(candle.open, candle.close),
        bottom: Math.min(candle.open, candle.close),
        idx:    i,
        tested: 0,
      });
    }

    // Strong bearish impulse candle → marks a supply zone
    if (candle.close < candle.open && bodyRatio >= 0.6) {
      zones.supply.push({
        top:    Math.max(candle.open, candle.close),
        bottom: Math.min(candle.open, candle.close),
        idx:    i,
        tested: 0,
      });
    }
  }

  // Count retests for each zone against remaining candles
  for (const z of zones.demand) {
    for (let i = z.idx + 1; i < df.length - 1; i++) {
      if (df[i].low <= z.top && df[i].high >= z.bottom) z.tested++;
    }
  }
  for (const z of zones.supply) {
    for (let i = z.idx + 1; i < df.length - 1; i++) {
      if (df[i].low <= z.top && df[i].high >= z.bottom) z.tested++;
    }
  }

  // Fresh zones = tested 0 or 1 times only
  zones.demand = zones.demand.filter(z => z.tested <= 1);
  zones.supply = zones.supply.filter(z => z.tested <= 1);

  return zones;
}

function strategySupplyDemand(dfH4, dfM30, dfM15) {
  try {
    if (!dfH4 || dfH4.length < 50) return SIG_HOLD;
    if (!dfM15 || dfM15.length < 20) return SIG_HOLD;

    const currentPrice = dfM15[dfM15.length - 2].close;
    const trigger      = dfM15[dfM15.length - 2];

    // Detect zones on 4H (macro) and 30M (mid)
    const h4Zones = detectZones(dfH4, 5);
    const m30Zones = dfM30 && dfM30.length > 50 ? detectZones(dfM30, 5) : { demand: [], supply: [] };

    // Combine zones from both timeframes
    const allDemand = [...h4Zones.demand, ...m30Zones.demand];
    const allSupply = [...h4Zones.supply, ...m30Zones.supply];

    // Check if current price is inside a demand zone
    const inDemand = allDemand.some(z =>
      currentPrice >= z.bottom * 0.999 && currentPrice <= z.top * 1.001
    );

    // Check if current price is inside a supply zone
    const inSupply = allSupply.some(z =>
      currentPrice >= z.bottom * 0.999 && currentPrice <= z.top * 1.001
    );

    if (inDemand && isBullishCandle(trigger)) return SIG_BUY;
    if (inSupply && isBearishCandle(trigger)) return SIG_SELL;

  } catch { return SIG_HOLD; }
  return SIG_HOLD;
}

// ═══════════════════════════════════════════════════════
//  STRATEGY 3 — SMART MONEY CONCEPTS (SMC)
//  Structure + liquidity sweep + CHoCH/BOS + OB/FVG
// ═══════════════════════════════════════════════════════

function detectLiquiditySweep(df) {
  // A liquidity sweep = price briefly breaks a swing high/low then reverses
  if (!df || df.length < 20) return { sweepLow: false, sweepHigh: false };

  const { highs, lows } = getSwingPoints(df, 5);
  if (!highs.length || !lows.length) return { sweepLow: false, sweepHigh: false };

  const lastCandle = df[df.length - 2];
  const prevLow    = lows[lows.length - 1].price;
  const prevHigh   = highs[highs.length - 1].price;

  // Sweep below previous low but closed above it (bullish sweep)
  const sweepLow  = lastCandle.low < prevLow && lastCandle.close > prevLow;
  // Sweep above previous high but closed below it (bearish sweep)
  const sweepHigh = lastCandle.high > prevHigh && lastCandle.close < prevHigh;

  return { sweepLow, sweepHigh };
}

function detectCHoCH(df) {
  // Change of Character: after bearish structure, first bullish break = CHoCH
  if (!df || df.length < 30) return { bullishChoCH: false, bearishChoCH: false };

  const recent   = df.slice(-20);
  const { highs, lows } = getSwingPoints(recent, 3);
  if (highs.length < 2 || lows.length < 2) return { bullishChoCH: false, bearishChoCH: false };

  const lastClose = df[df.length - 2].close;

  // Bullish CHoCH: was making LH/LL but just broke a recent swing high
  const prevHigh     = highs[highs.length - 1].price;
  const bullishChoCH = lastClose > prevHigh;

  // Bearish CHoCH: was making HH/HL but just broke a recent swing low
  const prevLow      = lows[lows.length - 1].price;
  const bearishChoCH = lastClose < prevLow;

  return { bullishChoCH, bearishChoCH };
}

function detectFVG(df) {
  // Fair Value Gap: candle[i-2] high < candle[i] low (bullish gap)
  //                candle[i-2] low  > candle[i] high (bearish gap)
  if (!df || df.length < 5) return { bullishFVG: false, bearishFVG: false };

  const len   = df.length;
  const c0    = df[len - 4]; // 3 candles back
  const c2    = df[len - 2]; // last closed candle
  const price = df[len - 2].close;

  const bullishFVG = c0 && c2 && c2.low > c0.high;  // gap up — price in gap = bullish
  const bearishFVG = c0 && c2 && c2.high < c0.low;  // gap down — price in gap = bearish

  return { bullishFVG, bearishFVG };
}

function strategySMC(dfH4, dfM30, dfM15) {
  try {
    if (!dfH4 || dfH4.length < 50) return SIG_HOLD;
    if (!dfM30 || dfM30.length < 30) return SIG_HOLD;
    if (!dfM15 || dfM15.length < 20) return SIG_HOLD;

    const h4Structure = getMarketStructure(dfH4, 3);
    const sweep       = detectLiquiditySweep(dfM30);
    const choch       = detectCHoCH(dfM15);
    const fvg         = detectFVG(dfM15);
    const trigger     = dfM15[dfM15.length - 2];

    // ── BULLISH SMC ──
    // 4H bullish structure + liquidity sweep below (trapped shorts)
    // + bullish CHoCH or BOS + OB/FVG retest + bullish trigger candle
    const bullishBOS   = getSwingPoints(dfM15, 3).highs;
    const bullishBreak = bullishBOS.length > 0 &&
      dfM15[dfM15.length - 2].close > bullishBOS[bullishBOS.length - 1].price;

    if (
      h4Structure === "bullish" &&
      sweep.sweepLow &&
      (choch.bullishChoCH || bullishBreak || fvg.bullishFVG) &&
      isBullishCandle(trigger)
    ) return SIG_BUY;

    // ── BEARISH SMC ──
    const bearishBOS   = getSwingPoints(dfM15, 3).lows;
    const bearishBreak = bearishBOS.length > 0 &&
      dfM15[dfM15.length - 2].close < bearishBOS[bearishBOS.length - 1].price;

    if (
      h4Structure === "bearish" &&
      sweep.sweepHigh &&
      (choch.bearishChoCH || bearishBreak || fvg.bearishFVG) &&
      isBearishCandle(trigger)
    ) return SIG_SELL;

  } catch { return SIG_HOLD; }
  return SIG_HOLD;
}

// ═══════════════════════════════════════════════════════
//  STRATEGY 4 — BREAKOUT
//  1H range detection → 15M breakout confirmation
// ═══════════════════════════════════════════════════════

function detectRange(df, lookback = 40) {
  // Find a consolidation range: recent swing high and swing low
  if (!df || df.length < lookback) return null;

  const slice  = df.slice(-lookback);
  const { highs, lows } = getSwingPoints(slice, 5);
  if (!highs.length || !lows.length) return null;

  // Use most recent swing high/low as resistance/support
  const resistance = highs[highs.length - 1].price;
  const support    = lows[lows.length - 1].price;

  const rangeSize = (resistance - support) / support;
  // Range must be meaningful (not too tight, not too wide)
  if (rangeSize < 0.001 || rangeSize > 0.05) return null;

  return { resistance, support };
}

function strategyBreakout(dfH1, dfM15) {
  try {
    if (!dfH1  || dfH1.length  < 50) return SIG_HOLD;
    if (!dfM15 || dfM15.length < 20) return SIG_HOLD;

    const range = detectRange(dfH1, 50);
    if (!range) return SIG_HOLD;

    const { resistance, support } = range;
    const lastCandle  = dfM15[dfM15.length - 2];
    const prevCandle  = dfM15[dfM15.length - 3];
    const currentAtr  = getAtr(dfM15);

    // ATR expansion check — momentum breakout, not wick
    const candleRange = lastCandle.high - lastCandle.low;
    const hasExpansion = candleRange > currentAtr * 1.2;

    // ── BULLISH BREAKOUT ──
    // Strong close above resistance (body above, not just wick)
    const bullBreak =
      lastCandle.close > resistance &&
      Math.min(lastCandle.open, lastCandle.close) > resistance * 0.999 && // body above
      isStrongBullish(lastCandle) &&
      hasExpansion;

    if (bullBreak) return SIG_BUY;

    // ── BEARISH BREAKDOWN ──
    const bearBreak =
      lastCandle.close < support &&
      Math.max(lastCandle.open, lastCandle.close) < support * 1.001 && // body below
      isStrongBearish(lastCandle) &&
      hasExpansion;

    if (bearBreak) return SIG_SELL;

    // ── RETEST ENTRY ──
    // Price broke out, pulled back to retest, now continuing
    const prevClose = prevCandle.close;

    // Bullish retest: price broke above resistance before, pulled back, now bouncing
    if (
      prevClose > resistance &&
      lastCandle.low <= resistance * 1.002 &&
      lastCandle.close > resistance &&
      isBullishCandle(lastCandle)
    ) return SIG_BUY;

    // Bearish retest
    if (
      prevClose < support &&
      lastCandle.high >= support * 0.998 &&
      lastCandle.close < support &&
      isBearishCandle(lastCandle)
    ) return SIG_SELL;

  } catch { return SIG_HOLD; }
  return SIG_HOLD;
}

// ═══════════════════════════════════════════════════════
//  STRATEGY 5 — MEAN REVERSION
//  RSI extremes + Bollinger bands + reversal candle
// ═══════════════════════════════════════════════════════

function strategyMeanReversion(dfH1, dfM15) {
  try {
    if (!dfH1  || dfH1.length  < 30) return SIG_HOLD;
    if (!dfM15 || dfM15.length < 25) return SIG_HOLD;

    const h1Closes  = dfH1.map(c => c.close);
    const m15Closes = dfM15.map(c => c.close);

    const h1Rsi  = rsi(h1Closes, 14);
    const m15Rsi = rsi(m15Closes, 14);
    if (h1Rsi === null || m15Rsi === null) return SIG_HOLD;

    const bb    = bollingerBands(m15Closes, 20, 2);
    if (!bb) return SIG_HOLD;

    const currentPrice = m15Closes[m15Closes.length - 2];
    const trigger      = dfM15[dfM15.length - 2];

    // ── OVERSOLD — BUY REVERSION ──
    // H1 RSI < 30 + 15M RSI < 35 + price below lower BB + reversal candle
    if (
      h1Rsi < 30 &&
      m15Rsi < 35 &&
      currentPrice < bb.lower &&
      isBullishCandle(trigger)
    ) return SIG_BUY;

    // ── OVERBOUGHT — SELL REVERSION ──
    // H1 RSI > 70 + 15M RSI > 65 + price above upper BB + bearish reversal
    if (
      h1Rsi > 70 &&
      m15Rsi > 65 &&
      currentPrice > bb.upper &&
      isBearishCandle(trigger)
    ) return SIG_SELL;

  } catch { return SIG_HOLD; }
  return SIG_HOLD;
}

// ═══════════════════════════════════════════════════════
//  SIGNAL COLLECTION + CONFLICT ENGINE
// ═══════════════════════════════════════════════════════

/**
 * Run all 5 strategies and collect signals.
 * Returns the final resolved signal and full breakdown.
 *
 * @param {object} tf  - { h4, m30, m15, h1 } candle arrays
 * @returns {object}   - { signal, buyCount, sellCount, breakdown, reason }
 */
export function collectSignals(tf) {
  const { h4, m30, m15, h1 } = tf;

  // h1 is optional — some strategies need it
  // fallback: use m30 data as 1H proxy if h1 not provided
  const df1h = h1 || m30;

  const strategies = [
    { name: "TrendFollowing",  signal: strategyTrendFollowing(h4, m30, m15) },
    { name: "SupplyDemand",    signal: strategySupplyDemand(h4, m30, m15)   },
    { name: "SMC",             signal: strategySMC(h4, m30, m15)            },
    { name: "Breakout",        signal: strategyBreakout(df1h, m15)          },
    { name: "MeanReversion",   signal: strategyMeanReversion(df1h, m15)     },
  ];

  let buyCount  = 0;
  let sellCount = 0;

  for (const s of strategies) {
    if (s.signal === SIG_BUY)  buyCount++;
    if (s.signal === SIG_SELL) sellCount++;
  }

  const breakdown = strategies.map(s => ({
    name:   s.name,
    signal: s.signal === SIG_BUY ? "BUY" : s.signal === SIG_SELL ? "SELL" : "HOLD",
  }));

  // ── CONFLICT RESOLUTION RULES ──
  // RULE 1: BUY + SELL on same cycle → HOLD (conflict)
  if (buyCount > 0 && sellCount > 0) {
    return { signal: SIG_HOLD, buyCount, sellCount, breakdown, reason: "CONFLICT — BUY+SELL signals present" };
  }

  // RULE 2 & 4: Only BUYs (+ HOLDs) → BUY
  if (buyCount > 0 && sellCount === 0) {
    return { signal: SIG_BUY, buyCount, sellCount, breakdown, reason: `${buyCount} BUY signal(s) — no conflicts` };
  }

  // RULE 2 & 4: Only SELLs (+ HOLDs) → SELL
  if (sellCount > 0 && buyCount === 0) {
    return { signal: SIG_SELL, buyCount, sellCount, breakdown, reason: `${sellCount} SELL signal(s) — no conflicts` };
  }

  // RULE 3: All HOLD
  return { signal: SIG_HOLD, buyCount, sellCount, breakdown, reason: "No signals — all strategies HOLD" };
}

// ═══════════════════════════════════════════════════════
//  SIGNAL STRENGTH
//  Based on how many strategies agree
// ═══════════════════════════════════════════════════════

export function getSignalStrength(tf) {
  const { signal, buyCount, sellCount } = collectSignals(tf);
  if (signal === SIG_HOLD) return 0;
  const votes = signal === SIG_BUY ? buyCount : sellCount;
  // 1 vote = 20%, 2 = 40%, 3 = 60%, 4 = 80%, 5 = 100%
  return Math.round((votes / 5) * 100);
}

// ═══════════════════════════════════════════════════════
//  TRADE REASON (for logs + Telegram)
// ═══════════════════════════════════════════════════════

export function getTradeReason(tf) {
  const result    = collectSignals(tf);
  const direction = result.signal === SIG_BUY ? "BUY" : result.signal === SIG_SELL ? "SELL" : "HOLD";
  const lines     = [
    `MULTI-STRATEGY SIGNAL — ${direction}`,
    `  Session   : ${sessionName()}`,
    `  ──────────────────────────────`,
  ];

  for (const s of result.breakdown) {
    const icon = s.signal === "BUY" ? "🟢" : s.signal === "SELL" ? "🔴" : "⬜";
    lines.push(`  ${icon} ${s.name.padEnd(16)}: ${s.signal}`);
  }

  lines.push(`  ──────────────────────────────`);
  lines.push(`  BUY votes : ${result.buyCount} | SELL votes: ${result.sellCount}`);
  lines.push(`  Decision  : ${direction} — ${result.reason}`);

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════
//  LEGACY COMPATIBILITY EXPORTS
//  (so bot-manager.js and index.js need minimal changes)
// ═══════════════════════════════════════════════════════

/**
 * Main signal function — drop-in replacement for getLatestSignalMtf()
 * Now accepts a full tf object { h4, m30, m15, h1 }
 * h1 is optional — strategies fall back to m30 if missing
 */
export function getLatestSignalMtf(dfM15, dfM30, dfH4, dfH1 = null) {
  const tf = { h4: dfH4, m30: dfM30, m15: dfM15, h1: dfH1 };
  return collectSignals(tf).signal;
}

/**
 * Strength for legacy callers
 */
export function getSignalStrengthLegacy(dfM15, dfM30 = null, dfH4 = null, dfH1 = null) {
  const tf = { h4: dfH4, m30: dfM30, m15: dfM15, h1: dfH1 };
  return getSignalStrength(tf);
}

/**
 * Trend helper used in Telegram cycle scan messages
 */
export function get15mTrend(dfM30) {
  if (!dfM30 || dfM30.length < 55) return "neutral";
  const emaData = getEmaAnalysis(dfM30);
  if (!emaData.valid || emaData.slope === "flat") return "neutral";
  if (emaData.priceAbove && emaData.slope === "rising")   return "bullish";
  if (!emaData.priceAbove && emaData.slope === "falling") return "bearish";
  return "neutral";
}