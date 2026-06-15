// ═══════════════════════════════════════════════════════
//  src/strategy/signals.js
//
//  MULTI-STRATEGY SIGNAL ENGINE — v2 (Full Spec)
//
//  5 Independent Strategies (all 3-phase: 4H → 1H → 15M):
//    1. Trend Following
//    2. Supply & Demand
//    3. Smart Money Concepts (SMC)
//    4. Breakout
//    5. Mean Reversion
//
//  Conflict Engine:
//    BUY + SELL same cycle  → HOLD (conflict, no trade)
//    BUY only  (+ HOLDs)   → BUY
//    SELL only (+ HOLDs)   → SELL
//    All HOLD              → no trade
//
//  Market Classification:
//    FX / Metals  → London + NY session only
//    Synthetics   → 24/7, no session filter
//    Crypto       → 24/7, volatility filter only
// ═══════════════════════════════════════════════════════

// ── SIGNAL CONSTANTS ──────────────────────────────────
export const SIG_BUY  =  1;
export const SIG_SELL = -1;
export const SIG_HOLD =  0;

// ── SESSION / MARKET CLASSIFICATION ───────────────────
const LONDON_START = 7;
const LONDON_END   = 16;
const NY_START     = 12;
const NY_END       = 21;

const SYNTHETIC_SYMBOLS = new Set([
  "BOOM500","CRASH500","JD75","JD100","R_75","R_100",
]);
const CRYPTO_SYMBOLS = new Set(["cryBTCUSD","cryETHUSD"]);

export function isMarketOpen(symbol) {
  if (SYNTHETIC_SYMBOLS.has(symbol) || CRYPTO_SYMBOLS.has(symbol)) return true;
  const hour = new Date().getUTCHours();
  const day  = new Date().getUTCDay();
  if (day === 6) return false;
  if (day === 0 && hour < 21) return false;
  if (day === 5 && hour >= 21) return false;
  return (hour >= LONDON_START && hour < LONDON_END) ||
         (hour >= NY_START     && hour < NY_END);
}

export function sessionName() {
  const hour   = new Date().getUTCHours();
  const london = hour >= LONDON_START && hour < LONDON_END;
  const ny     = hour >= NY_START     && hour < NY_END;
  if (london && ny) return "London+NY overlap";
  if (london)       return "London";
  if (ny)           return "New York";
  return "off-session";
}


// ═══════════════════════════════════════════════════════
//  SHARED INDICATOR UTILITIES
// ═══════════════════════════════════════════════════════

// ── EMA ───────────────────────────────────────────────
function calcEma(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length < period) return result;
  const k = 2 / (period + 1);
  result[period - 1] = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

// Returns { value, slope } for the last closed candle
// slope: "rising" | "falling" | "flat"
function getEma50(df) {
  if (!df || df.length < 56) return null;
  const closes  = df.map(c => c.close);
  const emaVals = calcEma(closes, 50);
  const len     = df.length;
  const now     = emaVals[len - 2]; // last closed
  const prev    = emaVals[len - 7]; // 5 bars back
  if (now === null || prev === null) return null;
  const pct = Math.abs(now - prev) / now;
  const slope = pct < 0.00008 ? "flat" : now > prev ? "rising" : "falling";
  return { value: now, slope, priceAbove: df[len - 2].close > now };
}

// ── ATR ───────────────────────────────────────────────
function calcAtr(df, period = 14) {
  if (!df || df.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < df.length; i++) {
    trs.push(Math.max(
      df[i].high - df[i].low,
      Math.abs(df[i].high - df[i - 1].close),
      Math.abs(df[i].low  - df[i - 1].close),
    ));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

export function getAtrPct(df, period = 14) {
  const atr   = calcAtr(df, period);
  const price = df[df.length - 1]?.close ?? 1;
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

// ── RSI ───────────────────────────────────────────────
function calcRsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains  += d;
    else       losses -= d;
  }
  let avgG = gains / period, avgL = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
  }
  return avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
}

// ── BOLLINGER BANDS ────────────────────────────────────
function calcBB(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean  = slice.reduce((a, b) => a + b, 0) / period;
  const sd    = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  return { upper: mean + mult * sd, middle: mean, lower: mean - mult * sd };
}

// ── SWING POINTS ──────────────────────────────────────
function getSwings(df, lookback = 5) {
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

// ── MARKET STRUCTURE ─────────────────────────────────
// Returns "bullish" | "bearish" | "neutral"
function getStructure(df, lookback = 4) {
  const { highs, lows } = getSwings(df, lookback);
  if (highs.length < 2 || lows.length < 2) return "neutral";
  const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
  const hl = lows[lows.length - 1].price   > lows[lows.length - 2].price;
  const lh = highs[highs.length - 1].price < highs[highs.length - 2].price;
  const ll = lows[lows.length - 1].price   < lows[lows.length - 2].price;
  if (hh && hl) return "bullish";
  if (lh && ll) return "bearish";
  return "neutral";
}

// ── CANDLE QUALITY FILTER ─────────────────────────────
// Spec: reject doji, spinning top, inside candle, body < 50% range
// Accept: strong body, close near high (bull) or low (bear)

function candleBody(c)  { return Math.abs(c.close - c.open); }
function candleRange(c) { return c.high - c.low; }

function isValidCandle(c) {
  if (!c) return false;
  const range = candleRange(c);
  if (range === 0) return false;
  const body  = candleBody(c);
  // Reject doji / spinning top: body < 50% range
  if (body / range < 0.50) return false;
  // Reject inside candle: handled contextually
  return true;
}

function isInsideCandle(c, prev) {
  return c.high <= prev.high && c.low >= prev.low;
}

// Strong bullish candle: body >= 50%, close in top 25% of range
function isBullishQuality(c) {
  if (!isValidCandle(c)) return false;
  if (c.close <= c.open) return false;
  const range = candleRange(c);
  return (c.high - c.close) / range <= 0.25;
}

// Strong bearish candle: body >= 50%, close in bottom 25% of range
function isBearishQuality(c) {
  if (!isValidCandle(c)) return false;
  if (c.close >= c.open) return false;
  const range = candleRange(c);
  return (c.close - c.low) / range <= 0.25;
}

// Bullish engulfing: close > prev open AND open < prev close
function isBullishEngulfing(c, prev) {
  if (!c || !prev) return false;
  return c.close > c.open &&
         c.open  < prev.close &&
         c.close > prev.open &&
         isBullishQuality(c);
}

// Bearish engulfing
function isBearishEngulfing(c, prev) {
  if (!c || !prev) return false;
  return c.close < c.open &&
         c.open  > prev.close &&
         c.close < prev.open &&
         isBearishQuality(c);
}

// Bullish pin bar: long lower wick, small body near top
function isBullishPinBar(c) {
  if (!c) return false;
  const range  = candleRange(c);
  if (range === 0) return false;
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const body      = candleBody(c);
  return lowerWick >= range * 0.6 && body <= range * 0.35;
}

// Bearish pin bar: long upper wick, small body near bottom
function isBearishPinBar(c) {
  if (!c) return false;
  const range     = candleRange(c);
  if (range === 0) return false;
  const upperWick = c.high - Math.max(c.open, c.close);
  const body      = candleBody(c);
  return upperWick >= range * 0.6 && body <= range * 0.35;
}

// Strong momentum candle (expansion): body > 60%, range > 1.5 × ATR
function isMomentumCandle(c, atr) {
  if (!c || !atr) return false;
  const range = candleRange(c);
  return candleBody(c) / range >= 0.60 && range >= atr * 1.5;
}

// Valid confirmation candle for BUY: engulfing OR pin bar OR momentum
function isValidBullTrigger(c, prev, atr) {
  return isBullishEngulfing(c, prev) ||
         isBullishPinBar(c) ||
         (isBullishQuality(c) && isMomentumCandle(c, atr));
}

// Valid confirmation candle for SELL
function isValidBearTrigger(c, prev, atr) {
  return isBearishEngulfing(c, prev) ||
         isBearishPinBar(c) ||
         (isBearishQuality(c) && isMomentumCandle(c, atr));
}

// ── BREAK OF STRUCTURE ────────────────────────────────
// BOS Bullish: close > recent swing high + 0.1 × ATR
// BOS Bearish: close < recent swing low  - 0.1 × ATR
function hasBullishBOS(df, atr) {
  const { highs } = getSwings(df, 4);
  if (!highs.length) return false;
  const lastHigh  = highs[highs.length - 1].price;
  const lastClose = df[df.length - 2].close;
  return lastClose > lastHigh + 0.1 * atr;
}

function hasBearishBOS(df, atr) {
  const { lows } = getSwings(df, 4);
  if (!lows.length) return false;
  const lastLow   = lows[lows.length - 1].price;
  const lastClose = df[df.length - 2].close;
  return lastClose < lastLow - 0.1 * atr;
}

// ── PULLBACK DETECTION ────────────────────────────────
// Bullish pullback: price retraced down recently before current candle
function hasBullishPullback(df, lookback = 10) {
  if (df.length < lookback + 2) return false;
  const slice  = df.slice(-lookback - 2, -1).map(c => c.close);
  const minVal = Math.min(...slice.slice(0, -1));
  return minVal < slice[0]; // price dipped then came back
}

function hasBearishPullback(df, lookback = 10) {
  if (df.length < lookback + 2) return false;
  const slice  = df.slice(-lookback - 2, -1).map(c => c.close);
  const maxVal = Math.max(...slice.slice(0, -1));
  return maxVal > slice[0];
}

// ── LIQUIDITY SWEEP ───────────────────────────────────
// Sweep below recent low then closes back above (bullish)
// Sweep above recent high then closes back below (bearish)
function detectLiqSweep(df) {
  if (!df || df.length < 15) return { sweepLow: false, sweepHigh: false };
  const { highs, lows } = getSwings(df, 5);
  if (!highs.length || !lows.length) return { sweepLow: false, sweepHigh: false };
  const c        = df[df.length - 2];
  const prevLow  = lows[lows.length - 1].price;
  const prevHigh = highs[highs.length - 1].price;
  return {
    sweepLow:  c.low < prevLow  && c.close > prevLow,
    sweepHigh: c.high > prevHigh && c.close < prevHigh,
  };
}

// ── CHANGE OF CHARACTER (CHoCH) ───────────────────────
// Bullish CHoCH: bearish trend → price breaks previous Lower High
// Bearish CHoCH: bullish trend → price breaks previous Higher Low
function detectChoCH(df) {
  if (!df || df.length < 20) return { bullish: false, bearish: false };
  const recent = df.slice(-20);
  const { highs, lows } = getSwings(recent, 3);
  const lastClose = df[df.length - 2].close;
  const bullish   = highs.length >= 1 && lastClose > highs[highs.length - 1].price;
  const bearish   = lows.length  >= 1 && lastClose < lows[lows.length - 1].price;
  return { bullish, bearish };
}

// ── ORDER BLOCK DETECTION ────────────────────────────
// Bullish OB: last bearish candle before strong bullish displacement + BOS
// Bearish OB: last bullish candle before strong bearish displacement + BOS
function findBullishOB(df, atr) {
  // Walk back looking for: bearish candle → strong bullish displacement → BOS
  for (let i = df.length - 10; i >= 2; i--) {
    const c    = df[i];
    const next = df[i + 1];
    if (!c || !next) continue;
    // Bearish OB candle
    if (c.close >= c.open) continue;
    // Next candle must be strong bullish displacement
    if (!isMomentumCandle(next, atr) || next.close <= next.open) continue;
    // OB is the range of the bearish candle
    const obTop    = Math.max(c.open, c.close);
    const obBottom = Math.min(c.open, c.close);
    // OB must be unmitigated (price hasn't traded back through it)
    let mitigated = false;
    for (let j = i + 2; j < df.length - 1; j++) {
      if (df[j].low <= obBottom) { mitigated = true; break; }
    }
    if (mitigated) continue;
    return { top: obTop, bottom: obBottom, idx: i, fresh: true };
  }
  return null;
}

function findBearishOB(df, atr) {
  for (let i = df.length - 10; i >= 2; i--) {
    const c    = df[i];
    const next = df[i + 1];
    if (!c || !next) continue;
    if (c.close <= c.open) continue; // needs bullish OB candle
    if (!isMomentumCandle(next, atr) || next.close >= next.open) continue;
    const obTop    = Math.max(c.open, c.close);
    const obBottom = Math.min(c.open, c.close);
    let mitigated = false;
    for (let j = i + 2; j < df.length - 1; j++) {
      if (df[j].high >= obTop) { mitigated = true; break; }
    }
    if (mitigated) continue;
    return { top: obTop, bottom: obBottom, idx: i, fresh: true };
  }
  return null;
}

// ── FAIR VALUE GAP ────────────────────────────────────
// Bullish FVG: c[n].low > c[n-2].high  (3-candle gap up)
// Bearish FVG: c[n].high < c[n-2].low  (3-candle gap down)
function findBullishFVG(df) {
  // Scan last 20 candles for a bullish FVG
  for (let i = df.length - 2; i >= 2; i--) {
    if (df[i].low > df[i - 2].high) {
      return { top: df[i].low, bottom: df[i - 2].high, idx: i };
    }
  }
  return null;
}

function findBearishFVG(df) {
  for (let i = df.length - 2; i >= 2; i--) {
    if (df[i].high < df[i - 2].low) {
      return { top: df[i - 2].low, bottom: df[i].high, idx: i };
    }
  }
  return null;
}

function priceInZone(price, zone) {
  return zone && price >= zone.bottom * 0.999 && price <= zone.top * 1.001;
}


// ═══════════════════════════════════════════════════════
//  SUPPLY & DEMAND ZONE DETECTION
//  Pattern: Drop-Base-Rally (demand) | Rally-Base-Drop (supply)
//  Base: 1-6 candles, then strong departure + BOS
// ═══════════════════════════════════════════════════════

function detectSDZones(df, atr) {
  const demand = [], supply = [];
  if (!df || df.length < 20) return { demand, supply };

  for (let i = 3; i < df.length - 8; i++) {
    // ── DEMAND ZONE: Drop → Base → Rally ──
    // Look for: at least 1 bearish candle, then 1-6 base candles, then strong bullish departure
    const baseStart = i;
    let   baseEnd   = i;

    // Count base candles (small range, no strong momentum)
    while (
      baseEnd < df.length - 4 &&
      baseEnd - baseStart < 6 &&
      candleBody(df[baseEnd]) < atr * 0.8
    ) baseEnd++;

    if (baseEnd === baseStart) { continue; }
    if (baseEnd >= df.length - 2) continue;

    const departure = df[baseEnd];
    const baseCandles = df.slice(baseStart, baseEnd);

    // ── DEMAND: need 2 strong bullish candles after base ──
    const bullCount = [df[baseEnd], df[baseEnd + 1]].filter(c =>
      c && isBullishQuality(c) && isMomentumCandle(c, atr)
    ).length;

    if (bullCount >= 1 && departure.close > departure.open) {
      const zoneTop    = Math.max(...baseCandles.map(c => c.high));
      const zoneBottom = Math.min(...baseCandles.map(c => c.low));

      // Count retests
      let retests = 0;
      for (let j = baseEnd + 2; j < df.length - 1; j++) {
        if (df[j].low <= zoneTop && df[j].high >= zoneBottom) retests++;
      }
      if (retests <= 1) {
        demand.push({ top: zoneTop, bottom: zoneBottom, idx: baseStart, retests, fresh: retests === 0 });
      }
    }

    // ── SUPPLY ZONE: Rally → Base → Drop ──
    const bearCount = [df[baseEnd], df[baseEnd + 1]].filter(c =>
      c && isBearishQuality(c) && isMomentumCandle(c, atr)
    ).length;

    if (bearCount >= 1 && departure.close < departure.open) {
      const zoneTop    = Math.max(...baseCandles.map(c => c.high));
      const zoneBottom = Math.min(...baseCandles.map(c => c.low));

      let retests = 0;
      for (let j = baseEnd + 2; j < df.length - 1; j++) {
        if (df[j].low <= zoneTop && df[j].high >= zoneBottom) retests++;
      }
      if (retests <= 1) {
        supply.push({ top: zoneTop, bottom: zoneBottom, idx: baseStart, retests, fresh: retests === 0 });
      }
    }
  }

  return { demand, supply };
}


// ═══════════════════════════════════════════════════════
//  BREAKOUT LEVEL DETECTION
//  Resistance: 2-3 touches within 0.5 × ATR range
//  Support: 2-3 touches within 0.5 × ATR range
//  Consolidation: min 5 candles, narrowing range
// ═══════════════════════════════════════════════════════

function detectBreakoutLevels(df, atr) {
  if (!df || df.length < 20) return { resistance: null, support: null };

  const lookback = Math.min(50, df.length - 2);
  const slice    = df.slice(-lookback - 1, -1);
  const tolerance = atr * 0.5;

  // Find resistance: cluster of highs within tolerance
  let resistance = null;
  const highs = slice.map(c => c.high).sort((a, b) => b - a);
  for (let i = 0; i < highs.length - 2; i++) {
    const level  = highs[i];
    const touches = highs.filter(h => Math.abs(h - level) <= tolerance);
    if (touches.length >= 2) { resistance = level; break; }
  }

  // Find support: cluster of lows within tolerance
  let support = null;
  const lows = slice.map(c => c.low).sort((a, b) => a - b);
  for (let i = 0; i < lows.length - 2; i++) {
    const level  = lows[i];
    const touches = lows.filter(l => Math.abs(l - level) <= tolerance);
    if (touches.length >= 2) { support = level; break; }
  }

  return { resistance, support };
}

// Check if price has consolidated (min 5 candles, narrowing range)
function hasConsolidation(df, lookback = 15) {
  if (df.length < lookback + 2) return false;
  const slice = df.slice(-lookback - 1, -1);
  if (slice.length < 5) return false;

  // No major trend swing — all candles within a band
  const high = Math.max(...slice.map(c => c.high));
  const low  = Math.min(...slice.map(c => c.low));
  const atr  = calcAtr(df);
  const band = high - low;

  // Consolidation: band ≤ 3 × ATR and no large impulsive candles
  const hasImpulse = slice.some(c => candleRange(c) > atr * 2);
  return band <= atr * 3 && !hasImpulse && slice.length >= 5;
}


// ═══════════════════════════════════════════════════════
//  STRATEGY 1 — TREND FOLLOWING (HIGH-CONFIDENCE)
//  4H → 1H → 15M — ALL phases must align
//
//  Phase 1: 4H — EMA50 + EMA200 dual confirmation,
//           HH/HL or LH/LL structure, BOS, ATR above avg
//  Phase 2: 1H — EMA50 + EMA200 alignment, pullback to
//           EMA50 or swing level, momentum candle (body≥70%)
//  Phase 3: 15M — pullback, higher low, bullish engulfing
//           AND break of previous 15M swing high
//  Filters: ADX≥25, ATR above 20-period average
// ═══════════════════════════════════════════════════════

// ── ADX CALCULATOR ────────────────────────────────────
function calcAdx(df, period = 14) {
  if (!df || df.length < period * 2 + 1) return 0;
  const plusDM  = [], minusDM = [], tr = [];
  for (let i = 1; i < df.length; i++) {
    const upMove   = df[i].high - df[i - 1].high;
    const downMove = df[i - 1].low - df[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(
      df[i].high - df[i].low,
      Math.abs(df[i].high - df[i - 1].close),
      Math.abs(df[i].low  - df[i - 1].close),
    ));
  }
  // Smoothed averages (Wilder)
  let sTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let sPDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let sMDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  const dxArr = [];
  for (let i = period; i < tr.length; i++) {
    sTR  = sTR  - sTR  / period + tr[i];
    sPDM = sPDM - sPDM / period + plusDM[i];
    sMDM = sMDM - sMDM / period + minusDM[i];
    const pdi = sTR > 0 ? (sPDM / sTR) * 100 : 0;
    const mdi = sTR > 0 ? (sMDM / sTR) * 100 : 0;
    const sum = pdi + mdi;
    dxArr.push(sum > 0 ? Math.abs(pdi - mdi) / sum * 100 : 0);
  }
  if (dxArr.length < period) return 0;
  let adx = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxArr.length; i++) {
    adx = (adx * (period - 1) + dxArr[i]) / period;
  }
  return adx;
}

// ── ATR AVERAGE FILTER ────────────────────────────────
// Returns true if current ATR is above its 20-period average
function atrAboveAverage(df, period = 14, avgPeriod = 20) {
  if (!df || df.length < period + avgPeriod + 5) return false;
  const atrs = [];
  for (let i = period; i < df.length; i++) {
    atrs.push(calcAtr(df.slice(0, i + 1), period));
  }
  if (atrs.length < avgPeriod) return false;
  const avg     = atrs.slice(-avgPeriod).reduce((a, b) => a + b, 0) / avgPeriod;
  const current = atrs[atrs.length - 1];
  return current > avg;
}

// ── EMA200 ────────────────────────────────────────────
function getEma200(df) {
  if (!df || df.length < 205) return null;
  const closes  = df.map(c => c.close);
  const emaVals = calcEma(closes, 200);
  const len     = df.length;
  const now     = emaVals[len - 2];
  const prev    = emaVals[len - 7];
  if (now === null || prev === null) return null;
  const pct   = Math.abs(now - prev) / now;
  const slope = pct < 0.00005 ? "flat" : now > prev ? "rising" : "falling";
  return { value: now, slope, priceAbove: df[len - 2].close > now };
}

// ── TREND FOLLOWING MOMENTUM CANDLE ──────────────────
// Spec: body >= 70% of range, close in top/bottom 20%, range >= 1.2 × ATR
function isTFMomentumCandle(c, atr, direction) {
  if (!c || !atr) return false;
  const range = candleRange(c);
  if (range === 0) return false;
  const bodyPct = candleBody(c) / range;
  if (bodyPct < 0.70) return false;
  if (range < atr * 1.2) return false;
  if (direction === "bull") {
    return c.close > c.open && (c.high - c.close) / range <= 0.20;
  }
  return c.close < c.open && (c.close - c.low) / range <= 0.20;
}

// ── PULLBACK TOUCHES EMA50 OR SWING LEVEL ────────────
function pullbackTouchesEmaOrSwing(df, ema50val, direction) {
  if (!df || df.length < 15) return false;
  const lookback = df.slice(-15, -1); // last 15 closed candles
  const { lows, highs } = getSwings(df, 4);

  if (direction === "bull") {
    // Bullish pullback: price dipped toward EMA50 or recent swing low
    const swingLow = lows.length > 0 ? lows[lows.length - 1].price : null;
    return lookback.some(c =>
      c.low <= ema50val * 1.002 ||
      (swingLow && c.low <= swingLow * 1.005)
    );
  } else {
    // Bearish pullback: price bounced toward EMA50 or recent swing high
    const swingHigh = highs.length > 0 ? highs[highs.length - 1].price : null;
    return lookback.some(c =>
      c.high >= ema50val * 0.998 ||
      (swingHigh && c.high >= swingHigh * 0.995)
    );
  }
}

function strategyTrendFollowing(dfH4, dfH1, dfM15) {
  try {
    if (!dfH4 || dfH4.length < 210) return SIG_HOLD; // need 200 EMA
    if (!dfH1 || dfH1.length < 210) return SIG_HOLD;
    if (!dfM15 || dfM15.length < 30) return SIG_HOLD;

    const atr4h = calcAtr(dfH4);
    const atr1h = calcAtr(dfH1);
    const atr15 = calcAtr(dfM15);

    // ── PHASE 1: 4H BIAS ─────────────────────────────
    const ema50_4h  = getEma50(dfH4);
    const ema200_4h = getEma200(dfH4);
    if (!ema50_4h || !ema200_4h) return SIG_HOLD;

    // No trade: EMA50 flat, EMA converging, ATR below avg
    if (ema50_4h.slope === "flat")   return SIG_HOLD;
    if (ema200_4h.slope === "flat")  return SIG_HOLD;
    if (!atrAboveAverage(dfH4))      return SIG_HOLD;

    // No trade: price between EMA50 and EMA200
    const price4h    = dfH4[dfH4.length - 2].close;
    const betweenEma = price4h > Math.min(ema50_4h.value, ema200_4h.value) &&
                       price4h < Math.max(ema50_4h.value, ema200_4h.value);
    if (betweenEma) return SIG_HOLD;

    // ADX >= 25 required on 4H
    const adx4h = calcAdx(dfH4);
    if (adx4h < 25) return SIG_HOLD;

    // EMA50 must be above EMA200 (bull) or below (bear)
    const str4h      = getStructure(dfH4, 4);
    if (str4h === "neutral") return SIG_HOLD;

    const ema50Above200 = ema50_4h.value > ema200_4h.value;

    // Bullish 4H bias
    const bull4h =
      ema50_4h.priceAbove &&           // price above EMA50
      ema50Above200 &&                  // EMA50 above EMA200
      ema50_4h.slope  === "rising" &&   // EMA50 slope positive
      ema200_4h.slope === "rising" &&   // EMA200 slope positive
      str4h === "bullish" &&            // HH + HL structure
      hasBullishBOS(dfH4, atr4h);       // latest swing high broken

    // Bearish 4H bias
    const bear4h =
      !ema50_4h.priceAbove &&           // price below EMA50
      !ema50Above200 &&                 // EMA50 below EMA200
      ema50_4h.slope  === "falling" &&  // EMA50 slope negative
      ema200_4h.slope === "falling" &&  // EMA200 slope negative
      str4h === "bearish" &&            // LH + LL structure
      hasBearishBOS(dfH4, atr4h);       // latest swing low broken

    if (!bull4h && !bear4h) return SIG_HOLD;

    // EMA distance >= 0.5 × ATR (no compression)
    const emaDist = Math.abs(ema50_4h.value - ema200_4h.value);
    if (emaDist < atr4h * 0.5) return SIG_HOLD;

    // ── PHASE 2: 1H CONFIRMATION ─────────────────────
    const ema50_1h  = getEma50(dfH1);
    const ema200_1h = getEma200(dfH1);
    if (!ema50_1h || !ema200_1h) return SIG_HOLD;

    const str1h      = getStructure(dfH1, 4);
    const adx1h      = calcAdx(dfH1);
    const ema50A200_1h = ema50_1h.value > ema200_1h.value;

    const len1h  = dfH1.length;
    const last1h = dfH1[len1h - 2];
    const prev1h = dfH1[len1h - 3];

    // Reject if 1H and 4H are misaligned (alignment engine)
    if (bull4h) {
      if (!ema50_1h.priceAbove)     return SIG_HOLD; // price above EMA50 on 1H
      if (!ema50A200_1h)            return SIG_HOLD; // EMA50 above EMA200 on 1H
      if (str1h !== "bullish")      return SIG_HOLD; // HH+HL on 1H
      if (adx1h < 20)               return SIG_HOLD; // min ADX on 1H

      // Pullback must touch EMA50 or swing support
      if (!pullbackTouchesEmaOrSwing(dfH1, ema50_1h.value, "bull")) return SIG_HOLD;
      if (!hasBullishPullback(dfH1)) return SIG_HOLD;

      // Confirmation candle: engulfing OR pin bar OR momentum (body >= 70%)
      const isMom1h = isTFMomentumCandle(last1h, atr1h, "bull");
      if (!isBullishEngulfing(last1h, prev1h) && !isBullishPinBar(last1h) && !isMom1h) return SIG_HOLD;

      // Reject if inside candle or opposing wick > 40%
      if (isInsideCandle(last1h, prev1h)) return SIG_HOLD;
      const range1h = candleRange(last1h);
      if (range1h > 0 && (last1h.open - last1h.low) / range1h > 0.40) return SIG_HOLD;
    }

    if (bear4h) {
      if (ema50_1h.priceAbove)      return SIG_HOLD;
      if (ema50A200_1h)             return SIG_HOLD;
      if (str1h !== "bearish")      return SIG_HOLD;
      if (adx1h < 20)               return SIG_HOLD;

      if (!pullbackTouchesEmaOrSwing(dfH1, ema50_1h.value, "bear")) return SIG_HOLD;
      if (!hasBearishPullback(dfH1)) return SIG_HOLD;

      const isMom1h = isTFMomentumCandle(last1h, atr1h, "bear");
      if (!isBearishEngulfing(last1h, prev1h) && !isBearishPinBar(last1h) && !isMom1h) return SIG_HOLD;

      if (isInsideCandle(last1h, prev1h)) return SIG_HOLD;
      const range1h = candleRange(last1h);
      if (range1h > 0 && (last1h.high - last1h.open) / range1h > 0.40) return SIG_HOLD;
    }

    // ── PHASE 3: 15M ENTRY ───────────────────────────
    // Spec: pullback on 15M + higher low + bullish ENGULFING
    // AND break of previous 15M swing high (BOTH required)
    const ema50_15 = getEma50(dfM15);
    if (!ema50_15) return SIG_HOLD;

    const { highs: h15, lows: l15 } = getSwings(dfM15, 3);
    const len15  = dfM15.length;
    const last15 = dfM15[len15 - 2];
    const prev15 = dfM15[len15 - 3];

    if (bull4h) {
      // Price must be above EMA50 on 15M
      if (!ema50_15.priceAbove) return SIG_HOLD;
      // 15M alignment: must NOT be bearish structure
      if (getStructure(dfM15, 3) === "bearish") return SIG_HOLD;
      // Pullback on 15M
      if (!hasBullishPullback(dfM15, 8)) return SIG_HOLD;
      // Higher low formed on 15M
      if (l15.length < 2 || l15[l15.length - 1].price <= l15[l15.length - 2].price) return SIG_HOLD;
      // Entry: bullish engulfing CLOSES (spec: engulfing AND swing high break — both)
      if (!isBullishEngulfing(last15, prev15)) return SIG_HOLD;
      // Break of previous 15M swing high
      if (h15.length === 0 || last15.close <= h15[h15.length - 1].price) return SIG_HOLD;
      // Reject inside candle on 15M
      if (isInsideCandle(last15, prev15)) return SIG_HOLD;
      return SIG_BUY;
    }

    if (bear4h) {
      if (ema50_15.priceAbove) return SIG_HOLD;
      if (getStructure(dfM15, 3) === "bullish") return SIG_HOLD;
      if (!hasBearishPullback(dfM15, 8)) return SIG_HOLD;
      if (h15.length < 2 || h15[h15.length - 1].price >= h15[h15.length - 2].price) return SIG_HOLD;
      if (!isBearishEngulfing(last15, prev15)) return SIG_HOLD;
      if (l15.length === 0 || last15.close >= l15[l15.length - 1].price) return SIG_HOLD;
      if (isInsideCandle(last15, prev15)) return SIG_HOLD;
      return SIG_SELL;
    }

  } catch { return SIG_HOLD; }
  return SIG_HOLD;
}


// ═══════════════════════════════════════════════════════
//  STRATEGY 2 — SUPPLY & DEMAND
//  4H → 1H → 15M
// ═══════════════════════════════════════════════════════

function strategySupplyDemand(dfH4, dfH1, dfM15) {
  try {
    if (!dfH4 || dfH4.length < 60) return SIG_HOLD;
    if (!dfH1 || dfH1.length < 60) return SIG_HOLD;
    if (!dfM15 || dfM15.length < 20) return SIG_HOLD;

    const atr4h = calcAtr(dfH4);
    const atr1h = calcAtr(dfH1);
    const atr15 = calcAtr(dfM15);

    // ── PHASE 1: 4H CONTEXT ──────────────────────────
    const ema4h = getEma50(dfH4);
    const str4h = getStructure(dfH4, 4);
    if (!ema4h || ema4h.slope === "flat" || str4h === "neutral") return SIG_HOLD;

    const bull4h = ema4h.priceAbove && str4h === "bullish";
    const bear4h = !ema4h.priceAbove && str4h === "bearish";
    if (!bull4h && !bear4h) return SIG_HOLD;

    // Detect S&D zones on 4H and 1H
    const zones4h = detectSDZones(dfH4, atr4h);
    const zones1h = detectSDZones(dfH1, atr1h);

    const allDemand = [...zones4h.demand, ...zones1h.demand];
    const allSupply = [...zones4h.supply, ...zones1h.supply];

    const currentPrice = dfM15[dfM15.length - 2].close;

    if (bull4h) {
      // Must have a valid demand zone and price inside it
      const activeZone = allDemand.find(z => priceInZone(currentPrice, z));
      if (!activeZone) return SIG_HOLD;

      // ── PHASE 2: 1H CONFIRMATION ──────────────────
      const str1h  = getStructure(dfH1, 4);
      if (str1h !== "bullish") return SIG_HOLD;

      const len1h  = dfH1.length;
      const last1h = dfH1[len1h - 2];
      const prev1h = dfH1[len1h - 3];
      if (!isValidBullTrigger(last1h, prev1h, atr1h)) return SIG_HOLD;

      // Higher low on 1H
      const { lows: lows1h } = getSwings(dfH1, 4);
      if (lows1h.length < 2 || lows1h[lows1h.length - 1].price <= lows1h[lows1h.length - 2].price) return SIG_HOLD;

      // ── PHASE 3: 15M ENTRY ──────────────────────
      const { highs: h15, lows: l15 } = getSwings(dfM15, 3);
      const len15  = dfM15.length;
      const last15 = dfM15[len15 - 2];
      const prev15 = dfM15[len15 - 3];

      if (!priceInZone(currentPrice, activeZone)) return SIG_HOLD;
      if (getStructure(dfM15, 3) === "bearish") return SIG_HOLD;

      // Higher low on 15M
      if (l15.length < 2 || l15[l15.length - 1].price <= l15[l15.length - 2].price) return SIG_HOLD;

      const breakSwingHigh = h15.length > 0 && last15.close > h15[h15.length - 1].price;
      if (!isValidBullTrigger(last15, prev15, atr15) && !breakSwingHigh) return SIG_HOLD;
      return SIG_BUY;
    }

    if (bear4h) {
      const activeZone = allSupply.find(z => priceInZone(currentPrice, z));
      if (!activeZone) return SIG_HOLD;

      const str1h  = getStructure(dfH1, 4);
      if (str1h !== "bearish") return SIG_HOLD;

      const len1h  = dfH1.length;
      const last1h = dfH1[len1h - 2];
      const prev1h = dfH1[len1h - 3];
      if (!isValidBearTrigger(last1h, prev1h, atr1h)) return SIG_HOLD;

      // Lower high on 1H
      const { highs: highs1h } = getSwings(dfH1, 4);
      if (highs1h.length < 2 || highs1h[highs1h.length - 1].price >= highs1h[highs1h.length - 2].price) return SIG_HOLD;

      const { highs: h15, lows: l15 } = getSwings(dfM15, 3);
      const len15  = dfM15.length;
      const last15 = dfM15[len15 - 2];
      const prev15 = dfM15[len15 - 3];

      if (!priceInZone(currentPrice, activeZone)) return SIG_HOLD;
      if (getStructure(dfM15, 3) === "bullish") return SIG_HOLD;

      // Lower high on 15M
      if (h15.length < 2 || h15[h15.length - 1].price >= h15[h15.length - 2].price) return SIG_HOLD;

      const breakSwingLow = l15.length > 0 && last15.close < l15[l15.length - 1].price;
      if (!isValidBearTrigger(last15, prev15, atr15) && !breakSwingLow) return SIG_HOLD;
      return SIG_SELL;
    }

  } catch { return SIG_HOLD; }
  return SIG_HOLD;
}


// ═══════════════════════════════════════════════════════
//  STRATEGY 3 — SMART MONEY CONCEPTS (SMC)
//  4H → 1H → 15M
// ═══════════════════════════════════════════════════════

function strategySMC(dfH4, dfH1, dfM15) {
  try {
    if (!dfH4 || dfH4.length < 60) return SIG_HOLD;
    if (!dfH1 || dfH1.length < 60) return SIG_HOLD;
    if (!dfM15 || dfM15.length < 20) return SIG_HOLD;

    const atr4h = calcAtr(dfH4);
    const atr1h = calcAtr(dfH1);
    const atr15 = calcAtr(dfM15);

    // ── PHASE 1: 4H BIAS ─────────────────────────────
    const str4h = getStructure(dfH4, 4);
    if (str4h === "neutral") return SIG_HOLD;

    const bos4hBull = hasBullishBOS(dfH4, atr4h);
    const bos4hBear = hasBearishBOS(dfH4, atr4h);

    // Bullish OB or Bearish OB on 4H
    const bullOB4h = findBullishOB(dfH4, atr4h);
    const bearOB4h = findBearishOB(dfH4, atr4h);

    const bull4h = str4h === "bullish" && bos4hBull && bullOB4h !== null;
    const bear4h = str4h === "bearish" && bos4hBear && bearOB4h !== null;
    if (!bull4h && !bear4h) return SIG_HOLD;

    const currentPrice = dfM15[dfM15.length - 2].close;

    // ── PHASE 2: 1H CONFIRMATION ─────────────────────
    const sweep1h  = detectLiqSweep(dfH1);
    const choch1h  = detectChoCH(dfH1);
    const len1h    = dfH1.length;
    const last1h   = dfH1[len1h - 2];
    const prev1h   = dfH1[len1h - 3];

    if (bull4h) {
      // Price must retrace into 4H OB or FVG
      const fvg4h = findBullishFVG(dfH4);
      const inOB  = priceInZone(currentPrice, bullOB4h);
      const inFVG = fvg4h && priceInZone(currentPrice, fvg4h);
      if (!inOB && !inFVG) return SIG_HOLD;

      // Liquidity sweep below recent low on 1H
      if (!sweep1h.sweepLow) return SIG_HOLD;
      // Bullish CHoCH on 1H
      if (!choch1h.bullish) return SIG_HOLD;
      // Valid 1H confirmation candle
      if (!isValidBullTrigger(last1h, prev1h, atr1h)) return SIG_HOLD;

      // ── PHASE 3: 15M ENTRY ──────────────────────
      const bullOB15  = findBullishOB(dfM15, atr15);
      const bullFVG15 = findBullishFVG(dfM15);
      const choch15   = detectChoCH(dfM15);
      const sweep15   = detectLiqSweep(dfM15);

      const inOB15  = bullOB15  && priceInZone(currentPrice, bullOB15);
      const inFVG15 = bullFVG15 && priceInZone(currentPrice, bullFVG15);
      if (!inOB15 && !inFVG15) return SIG_HOLD;

      if (!sweep15.sweepLow && !choch15.bullish) return SIG_HOLD;

      const len15  = dfM15.length;
      const last15 = dfM15[len15 - 2];
      const prev15 = dfM15[len15 - 3];
      const bos15  = hasBullishBOS(dfM15, atr15);

      if (!isValidBullTrigger(last15, prev15, atr15) && !bos15) return SIG_HOLD;
      return SIG_BUY;
    }

    if (bear4h) {
      const fvg4h = findBearishFVG(dfH4);
      const inOB  = priceInZone(currentPrice, bearOB4h);
      const inFVG = fvg4h && priceInZone(currentPrice, fvg4h);
      if (!inOB && !inFVG) return SIG_HOLD;

      if (!sweep1h.sweepHigh) return SIG_HOLD;
      if (!choch1h.bearish)   return SIG_HOLD;
      if (!isValidBearTrigger(last1h, prev1h, atr1h)) return SIG_HOLD;

      const bearOB15  = findBearishOB(dfM15, atr15);
      const bearFVG15 = findBearishFVG(dfM15);
      const choch15   = detectChoCH(dfM15);
      const sweep15   = detectLiqSweep(dfM15);

      const inOB15  = bearOB15  && priceInZone(currentPrice, bearOB15);
      const inFVG15 = bearFVG15 && priceInZone(currentPrice, bearFVG15);
      if (!inOB15 && !inFVG15) return SIG_HOLD;

      if (!sweep15.sweepHigh && !choch15.bearish) return SIG_HOLD;

      const len15  = dfM15.length;
      const last15 = dfM15[len15 - 2];
      const prev15 = dfM15[len15 - 3];
      const bos15  = hasBearishBOS(dfM15, atr15);

      if (!isValidBearTrigger(last15, prev15, atr15) && !bos15) return SIG_HOLD;
      return SIG_SELL;
    }

  } catch { return SIG_HOLD; }
  return SIG_HOLD;
}


// ═══════════════════════════════════════════════════════
//  STRATEGY 4 — BREAKOUT
//  4H → 1H → 15M
//  Aggressive entry: on breakout candle close
//  Conservative entry: on retest confirmation
// ═══════════════════════════════════════════════════════

function strategyBreakout(dfH4, dfH1, dfM15) {
  try {
    if (!dfH4 || dfH4.length < 60) return SIG_HOLD;
    if (!dfH1 || dfH1.length < 60) return SIG_HOLD;
    if (!dfM15 || dfM15.length < 20) return SIG_HOLD;

    const atr4h = calcAtr(dfH4);
    const atr1h = calcAtr(dfH1);
    const atr15 = calcAtr(dfM15);

    // ── PHASE 1: 4H BIAS ─────────────────────────────
    const ema4h = getEma50(dfH4);
    const str4h = getStructure(dfH4, 4);
    if (!ema4h || ema4h.slope === "flat" || str4h === "neutral") return SIG_HOLD;

    const bull4h = ema4h.priceAbove && ema4h.slope === "rising" && str4h === "bullish";
    const bear4h = !ema4h.priceAbove && ema4h.slope === "falling" && str4h === "bearish";
    if (!bull4h && !bear4h) return SIG_HOLD;

    // ── PHASE 2: 1H BREAKOUT CONFIRMATION ────────────
    const { resistance, support } = detectBreakoutLevels(dfH1, atr1h);
    if (!resistance && !support) return SIG_HOLD;
    if (!hasConsolidation(dfH1, 15)) return SIG_HOLD;

    const len1h  = dfH1.length;
    const last1h = dfH1[len1h - 2];
    const prev1h = dfH1[len1h - 3];

    if (bull4h && resistance) {
      // Candle must close above resistance
      if (last1h.close <= resistance) {
        // Check for retest (conservative entry)
        const retest = last1h.low <= resistance * 1.002 &&
                       last1h.close > resistance &&
                       isValidBullTrigger(last1h, prev1h, atr1h);
        if (!retest) return SIG_HOLD;
      }

      // Breakout strength filter
      const range    = candleRange(last1h);
      const bodyPct  = candleBody(last1h) / range;
      const closePos = (last1h.high - last1h.close) / range;

      // Body > 60%, close in top 20%, range > 1.5 × ATR
      if (bodyPct < 0.60) return SIG_HOLD;
      if (closePos > 0.20) return SIG_HOLD;
      if (range < atr1h * 1.5) return SIG_HOLD;
      // Must close above resistance by at least 0.2 × ATR
      if (last1h.close < resistance + 0.2 * atr1h) return SIG_HOLD;

      // ── PHASE 3: 15M ENTRY ──────────────────────
      const len15  = dfM15.length;
      const last15 = dfM15[len15 - 2];
      const prev15 = dfM15[len15 - 3];
      const { highs: h15 } = getSwings(dfM15, 3);

      // Aggressive: momentum continues
      if (isValidBullTrigger(last15, prev15, atr15)) return SIG_BUY;
      // Conservative: break of 15M swing high after retest
      if (h15.length > 0 && last15.close > h15[h15.length - 1].price) return SIG_BUY;
    }

    if (bear4h && support) {
      if (last1h.close >= support) {
        // Retest check
        const retest = last1h.high >= support * 0.998 &&
                       last1h.close < support &&
                       isValidBearTrigger(last1h, prev1h, atr1h);
        if (!retest) return SIG_HOLD;
      }

      const range    = candleRange(last1h);
      const bodyPct  = candleBody(last1h) / range;
      const closePos = (last1h.close - last1h.low) / range;

      if (bodyPct < 0.60) return SIG_HOLD;
      if (closePos > 0.20) return SIG_HOLD;
      if (range < atr1h * 1.5) return SIG_HOLD;
      if (last1h.close > support - 0.2 * atr1h) return SIG_HOLD;

      const len15  = dfM15.length;
      const last15 = dfM15[len15 - 2];
      const prev15 = dfM15[len15 - 3];
      const { lows: l15 } = getSwings(dfM15, 3);

      if (isValidBearTrigger(last15, prev15, atr15)) return SIG_SELL;
      if (l15.length > 0 && last15.close < l15[l15.length - 1].price) return SIG_SELL;
    }

  } catch { return SIG_HOLD; }
  return SIG_HOLD;
}


// ═══════════════════════════════════════════════════════
//  STRATEGY 5 — MEAN REVERSION (HIGH-CONFIDENCE)
//  4H → 1H → 15M — ALL conditions must be satisfied
//
//  Phase 1: 4H extreme filter — RSI≤25/≥75, price ≥2×ATR
//           from EMA50, major S/R zone, 3 consecutive
//           trend candles, exhaustion, ADX≤35
//  Phase 2: 1H confirmation — RSI≤30/≥70, price inside
//           S/R zone, divergence, rejection candle
//  Phase 3: 15M entry — double bottom/top or higher low /
//           lower high, engulfing + swing break + RSI cross
// ═══════════════════════════════════════════════════════

// ── MAJOR S/R ZONE DETECTION ─────────────────────────
// Finds the most recent significant support or resistance
// zone using swing cluster method (3+ touches within ATR)
function findMajorSRZone(df, atr) {
  if (!df || df.length < 30) return { support: null, resistance: null };
  const lookback = Math.min(100, df.length - 2);
  const slice    = df.slice(-lookback - 1, -1);
  const tol      = atr * 1.0; // 1 ATR tolerance for zone clustering

  // Cluster highs → resistance
  const highs = slice.map(c => c.high);
  let resistance = null;
  for (let i = 0; i < highs.length; i++) {
    const touches = highs.filter(h => Math.abs(h - highs[i]) <= tol);
    if (touches.length >= 3) { resistance = highs[i]; break; }
  }

  // Cluster lows → support
  const lows = slice.map(c => c.low).sort((a, b) => a - b);
  let support = null;
  for (let i = 0; i < lows.length; i++) {
    const touches = lows.filter(l => Math.abs(l - lows[i]) <= tol);
    if (touches.length >= 3) { support = lows[i]; break; }
  }

  return { support, resistance };
}

// ── CONSECUTIVE CANDLE COUNT ──────────────────────────
function countConsecutiveCandles(df, direction, minCount = 3) {
  if (!df || df.length < minCount + 1) return 0;
  let count = 0;
  for (let i = df.length - 2; i >= 1; i--) {
    const c = df[i];
    if (direction === "bear" && c.close < c.open) count++;
    else if (direction === "bull" && c.close > c.open) count++;
    else break;
  }
  return count;
}

// ── RSI DIVERGENCE ────────────────────────────────────
// Bullish divergence: price making lower lows, RSI making higher lows
// Bearish divergence: price making higher highs, RSI making lower highs
function detectRsiDivergence(df, rsiValues, direction) {
  if (!df || df.length < 20 || !rsiValues || rsiValues.length < 20) return false;
  const lookback = 20;
  const priceSlice = df.slice(-lookback - 1, -1);
  const rsiSlice   = rsiValues.slice(-lookback);

  if (direction === "bull") {
    // Price: lower low; RSI: higher low
    const priceLow1 = Math.min(...priceSlice.slice(0, 10).map(c => c.low));
    const priceLow2 = Math.min(...priceSlice.slice(10).map(c => c.low));
    const rsiLow1   = Math.min(...rsiSlice.slice(0, 10).filter(v => v !== null));
    const rsiLow2   = Math.min(...rsiSlice.slice(10).filter(v => v !== null));
    return priceLow2 < priceLow1 && rsiLow2 > rsiLow1;
  } else {
    // Price: higher high; RSI: lower high
    const priceHigh1 = Math.max(...priceSlice.slice(0, 10).map(c => c.high));
    const priceHigh2 = Math.max(...priceSlice.slice(10).map(c => c.high));
    const rsiHigh1   = Math.max(...rsiSlice.slice(0, 10).filter(v => v !== null));
    const rsiHigh2   = Math.max(...rsiSlice.slice(10).filter(v => v !== null));
    return priceHigh2 > priceHigh1 && rsiHigh2 < rsiHigh1;
  }
}

// ── RSI SERIES FOR DIVERGENCE ─────────────────────────
function calcRsiSeries(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgG = gains / period, avgL = losses / period;
  result[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    result[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return result;
}

// ── ATR SPIKE DETECTION ───────────────────────────────
function hasAtrSpike(df, period = 14, avgPeriod = 20) {
  return atrAboveAverage(df, period, avgPeriod);
}

// ── LONG WICK DETECTION ───────────────────────────────
function hasLongLowerWick(c, minWickRatio = 0.5) {
  if (!c) return false;
  const range = candleRange(c);
  if (range === 0) return false;
  return (Math.min(c.open, c.close) - c.low) / range >= minWickRatio;
}

function hasLongUpperWick(c, minWickRatio = 0.5) {
  if (!c) return false;
  const range = candleRange(c);
  if (range === 0) return false;
  return (c.high - Math.max(c.open, c.close)) / range >= minWickRatio;
}

// ── DOUBLE BOTTOM / TOP ───────────────────────────────
function hasDoubleBottom(df, atr) {
  const { lows } = getSwings(df, 4);
  if (lows.length < 2) return false;
  const l1 = lows[lows.length - 2].price;
  const l2 = lows[lows.length - 1].price;
  // Two lows within 0.5 × ATR of each other
  return Math.abs(l1 - l2) <= atr * 0.5 && l2 >= l1 * 0.998;
}

function hasDoubleTop(df, atr) {
  const { highs } = getSwings(df, 4);
  if (highs.length < 2) return false;
  const h1 = highs[highs.length - 2].price;
  const h2 = highs[highs.length - 1].price;
  return Math.abs(h1 - h2) <= atr * 0.5 && h2 <= h1 * 1.002;
}

// ── MR REVERSAL CANDLE FILTER ─────────────────────────
// Spec: body >= 60%, lower wick >= 2 × body (bull), close above prev high
// OR bearish: body >= 60%, upper wick >= 2 × body, close below prev low
function isMRBullReversalCandle(c, prev) {
  if (!c || !prev) return false;
  const range = candleRange(c);
  if (range === 0) return false;
  const body      = candleBody(c);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  // Bullish engulfing OR hammer (lower wick >= 2× body) OR strong pin bar
  const isEngulf  = isBullishEngulfing(c, prev);
  const isHammer  = lowerWick >= body * 2 && c.close > c.open;
  const isPinBar  = isBullishPinBar(c);
  const validBody = body / range >= 0.60;
  const closeAbovePrevHigh = c.close > prev.high;
  return (isEngulf || isHammer || isPinBar) && (validBody || isHammer) && closeAbovePrevHigh;
}

function isMRBearReversalCandle(c, prev) {
  if (!c || !prev) return false;
  const range = candleRange(c);
  if (range === 0) return false;
  const body      = candleBody(c);
  const upperWick = c.high - Math.max(c.open, c.close);
  const isEngulf  = isBearishEngulfing(c, prev);
  const isStar    = upperWick >= body * 2 && c.close < c.open;
  const isPinBar  = isBearishPinBar(c);
  const validBody = body / range >= 0.60;
  const closeBelowPrevLow = c.close < prev.low;
  return (isEngulf || isStar || isPinBar) && (validBody || isStar) && closeBelowPrevLow;
}

function strategyMeanReversion(dfH4, dfH1, dfM15) {
  try {
    if (!dfH4 || dfH4.length < 60) return SIG_HOLD;
    if (!dfH1 || dfH1.length < 30) return SIG_HOLD;
    if (!dfM15 || dfM15.length < 25) return SIG_HOLD;

    const atr4h = calcAtr(dfH4);
    const atr1h = calcAtr(dfH1);
    const atr15 = calcAtr(dfM15);

    // ── PHASE 1: 4H EXTREME MARKET FILTER ────────────
    const ema50_4h = getEma50(dfH4);
    if (!ema50_4h) return SIG_HOLD;

    const h4Closes  = dfH4.map(c => c.close);
    const h4RsiSeries = calcRsiSeries(h4Closes, 14);
    const h4Rsi     = h4RsiSeries[h4RsiSeries.length - 2];
    if (h4Rsi === null) return SIG_HOLD;

    // ADX <= 35: not in a strong trend (reject strong trends)
    const adx4h = calcAdx(dfH4);
    if (adx4h > 35) return SIG_HOLD;

    // RSI between 40-60: no extreme, no trade
    if (h4Rsi > 40 && h4Rsi < 60) return SIG_HOLD;

    // Price must be extended from EMA50 by >= 2 × ATR
    const price4h     = dfH4[dfH4.length - 2].close;
    const distFromEma = Math.abs(price4h - ema50_4h.value);
    if (distFromEma < atr4h * 2) return SIG_HOLD;

    // Major S/R zone detection on 4H
    const sr4h = findMajorSRZone(dfH4, atr4h);

    const h4Oversold   = h4Rsi <= 25;
    const h4Overbought = h4Rsi >= 75;
    if (!h4Oversold && !h4Overbought) return SIG_HOLD;

    // ATR above average (volatility expansion after exhaustion)
    if (!atrAboveAverage(dfH4)) return SIG_HOLD;

    // ── BULLISH REVERSAL SETUP (OVERSOLD) ─────────────
    if (h4Oversold) {
      // Price below EMA50
      if (ema50_4h.priceAbove) return SIG_HOLD;
      // Major support zone required
      if (!sr4h.support) return SIG_HOLD;
      // Price at or near support
      if (price4h > sr4h.support * 1.01) return SIG_HOLD;
      // At least 3 consecutive bearish candles
      if (countConsecutiveCandles(dfH4, "bear") < 3) return SIG_HOLD;
      // Exhaustion: long lower wick on last closed 4H candle
      const last4h = dfH4[dfH4.length - 2];
      const exhaustion = hasLongLowerWick(last4h) || hasAtrSpike(dfH4);
      if (!exhaustion) return SIG_HOLD;

      // ── PHASE 2: 1H BUY CONFIRMATION ──────────────
      const h1Closes    = dfH1.map(c => c.close);
      const h1RsiSeries = calcRsiSeries(h1Closes, 14);
      const h1Rsi       = h1RsiSeries[h1RsiSeries.length - 2];
      const h1BB        = calcBB(h1Closes, 20, 2);
      if (h1Rsi === null || !h1BB) return SIG_HOLD;

      const currentH1Price = h1Closes[h1Closes.length - 2];
      const len1h          = dfH1.length;
      const last1h         = dfH1[len1h - 2];
      const prev1h         = dfH1[len1h - 3];

      // RSI <= 30 on 1H
      if (h1Rsi > 30) return SIG_HOLD;
      // Price inside support zone on 1H
      if (sr4h.support && currentH1Price > sr4h.support * 1.015) return SIG_HOLD;
      // Bullish divergence on 1H
      if (!detectRsiDivergence(dfH1, h1RsiSeries, "bull")) return SIG_HOLD;
      // Selling momentum weakening: last 1H candle range < previous 3 average
      const last3Avg = dfH1.slice(-5, -2).reduce((s, c) => s + candleRange(c), 0) / 3;
      if (candleRange(last1h) > last3Avg) return SIG_HOLD; // still strong sell momentum
      // Valid 1H reversal candle
      if (!isMRBullReversalCandle(last1h, prev1h)) return SIG_HOLD;

      // ── PHASE 3: 15M BUY ENTRY ────────────────────
      const m15Closes    = dfM15.map(c => c.close);
      const m15RsiSeries = calcRsiSeries(m15Closes, 14);
      const m15RsiPrev   = m15RsiSeries[m15RsiSeries.length - 3]; // bar before last
      const m15RsiNow    = m15RsiSeries[m15RsiSeries.length - 2];
      if (m15RsiNow === null || m15RsiPrev === null) return SIG_HOLD;

      const len15  = dfM15.length;
      const last15 = dfM15[len15 - 2];
      const prev15 = dfM15[len15 - 3];
      const { highs: h15, lows: l15 } = getSwings(dfM15, 3);

      // Double bottom OR higher low on 15M
      const dbottom = hasDoubleBottom(dfM15, atr15);
      const higherLow = l15.length >= 2 &&
        l15[l15.length - 1].price > l15[l15.length - 2].price;
      if (!dbottom && !higherLow) return SIG_HOLD;

      // Bullish engulfing on 15M
      if (!isBullishEngulfing(last15, prev15)) return SIG_HOLD;
      // Break of previous 15M swing high
      if (h15.length === 0 || last15.close <= h15[h15.length - 1].price) return SIG_HOLD;
      // RSI crosses above 30 on 15M (prev < 30, now >= 30)
      if (!(m15RsiPrev < 30 && m15RsiNow >= 30)) return SIG_HOLD;

      return SIG_BUY;
    }

    // ── BEARISH REVERSAL SETUP (OVERBOUGHT) ───────────
    if (h4Overbought) {
      // Price above EMA50
      if (!ema50_4h.priceAbove) return SIG_HOLD;
      // Major resistance zone required
      if (!sr4h.resistance) return SIG_HOLD;
      // Price at or near resistance
      if (price4h < sr4h.resistance * 0.99) return SIG_HOLD;
      // At least 3 consecutive bullish candles
      if (countConsecutiveCandles(dfH4, "bull") < 3) return SIG_HOLD;
      // Exhaustion: long upper wick on last closed 4H candle
      const last4h = dfH4[dfH4.length - 2];
      const exhaustion = hasLongUpperWick(last4h) || hasAtrSpike(dfH4);
      if (!exhaustion) return SIG_HOLD;

      // ── PHASE 2: 1H SELL CONFIRMATION ─────────────
      const h1Closes    = dfH1.map(c => c.close);
      const h1RsiSeries = calcRsiSeries(h1Closes, 14);
      const h1Rsi       = h1RsiSeries[h1RsiSeries.length - 2];
      const h1BB        = calcBB(h1Closes, 20, 2);
      if (h1Rsi === null || !h1BB) return SIG_HOLD;

      const currentH1Price = h1Closes[h1Closes.length - 2];
      const len1h          = dfH1.length;
      const last1h         = dfH1[len1h - 2];
      const prev1h         = dfH1[len1h - 3];

      // RSI >= 70 on 1H
      if (h1Rsi < 70) return SIG_HOLD;
      // Price inside resistance zone on 1H
      if (sr4h.resistance && currentH1Price < sr4h.resistance * 0.985) return SIG_HOLD;
      // Bearish divergence on 1H
      if (!detectRsiDivergence(dfH1, h1RsiSeries, "bear")) return SIG_HOLD;
      // Buying momentum weakening
      const last3Avg = dfH1.slice(-5, -2).reduce((s, c) => s + candleRange(c), 0) / 3;
      if (candleRange(last1h) > last3Avg) return SIG_HOLD;
      // Valid 1H reversal candle
      if (!isMRBearReversalCandle(last1h, prev1h)) return SIG_HOLD;

      // ── PHASE 3: 15M SELL ENTRY ───────────────────
      const m15Closes    = dfM15.map(c => c.close);
      const m15RsiSeries = calcRsiSeries(m15Closes, 14);
      const m15RsiPrev   = m15RsiSeries[m15RsiSeries.length - 3];
      const m15RsiNow    = m15RsiSeries[m15RsiSeries.length - 2];
      if (m15RsiNow === null || m15RsiPrev === null) return SIG_HOLD;

      const len15  = dfM15.length;
      const last15 = dfM15[len15 - 2];
      const prev15 = dfM15[len15 - 3];
      const { highs: h15, lows: l15 } = getSwings(dfM15, 3);

      // Double top OR lower high on 15M
      const dtop = hasDoubleTop(dfM15, atr15);
      const lowerHigh = h15.length >= 2 &&
        h15[h15.length - 1].price < h15[h15.length - 2].price;
      if (!dtop && !lowerHigh) return SIG_HOLD;

      // Bearish engulfing on 15M
      if (!isBearishEngulfing(last15, prev15)) return SIG_HOLD;
      // Break of previous 15M swing low
      if (l15.length === 0 || last15.close >= l15[l15.length - 1].price) return SIG_HOLD;
      // RSI crosses below 70 on 15M (prev > 70, now <= 70)
      if (!(m15RsiPrev > 70 && m15RsiNow <= 70)) return SIG_HOLD;

      return SIG_SELL;
    }

  } catch { return SIG_HOLD; }
  return SIG_HOLD;
}


// ═══════════════════════════════════════════════════════
//  SIGNAL COLLECTION + CONFLICT ENGINE
// ═══════════════════════════════════════════════════════

export function collectSignals(tf) {
  const { h4, h1, m30, m15 } = tf;

  // All 5 strategies run independently
  const strategies = [
    { name: "TrendFollowing", signal: strategyTrendFollowing(h4, h1, m15) },
    { name: "SupplyDemand",   signal: strategySupplyDemand(h4, h1, m15)   },
    { name: "SMC",            signal: strategySMC(h4, h1, m15)            },
    { name: "Breakout",       signal: strategyBreakout(h4, h1, m15)       },
    { name: "MeanReversion",  signal: strategyMeanReversion(h4, h1, m15)  },
  ];

  let buyCount = 0, sellCount = 0;
  for (const s of strategies) {
    if (s.signal === SIG_BUY)  buyCount++;
    if (s.signal === SIG_SELL) sellCount++;
  }

  const breakdown = strategies.map(s => ({
    name:   s.name,
    signal: s.signal === SIG_BUY ? "BUY" : s.signal === SIG_SELL ? "SELL" : "HOLD",
  }));

  // ── CONFLICT RULES ───────────────────────────────────
  if (buyCount > 0 && sellCount > 0) {
    return { signal: SIG_HOLD, buyCount, sellCount, breakdown, reason: "CONFLICT — BUY+SELL signals present" };
  }
  if (buyCount > 0) {
    return { signal: SIG_BUY,  buyCount, sellCount, breakdown, reason: `${buyCount} BUY signal(s) — no conflicts` };
  }
  if (sellCount > 0) {
    return { signal: SIG_SELL, buyCount, sellCount, breakdown, reason: `${sellCount} SELL signal(s) — no conflicts` };
  }
  return { signal: SIG_HOLD, buyCount, sellCount, breakdown, reason: "No signals — all strategies HOLD" };
}

export function getSignalStrength(tf) {
  const { signal, buyCount, sellCount } = collectSignals(tf);
  if (signal === SIG_HOLD) return 0;
  return Math.round(((signal === SIG_BUY ? buyCount : sellCount) / 5) * 100);
}

export function getTradeReason(tf) {
  const result    = collectSignals(tf);
  const direction = result.signal === SIG_BUY ? "BUY" : result.signal === SIG_SELL ? "SELL" : "HOLD";
  const lines = [
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
// ═══════════════════════════════════════════════════════

export function getLatestSignalMtf(dfM15, dfM30, dfH4, dfH1 = null) {
  return collectSignals({ h4: dfH4, h1: dfH1 || dfM30, m30: dfM30, m15: dfM15 }).signal;
}

export function getSignalStrengthLegacy(dfM15, dfM30 = null, dfH4 = null, dfH1 = null) {
  return getSignalStrength({ h4: dfH4, h1: dfH1 || dfM30, m30: dfM30, m15: dfM15 });
}

export function get15mTrend(dfH1) {
  if (!dfH1 || dfH1.length < 56) return "neutral";
  const ema = getEma50(dfH1);
  if (!ema || ema.slope === "flat") return "neutral";
  if (ema.priceAbove && ema.slope === "rising")  return "bullish";
  if (!ema.priceAbove && ema.slope === "falling") return "bearish";
  return "neutral";
}