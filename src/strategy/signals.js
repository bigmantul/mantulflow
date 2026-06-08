// ═══════════════════════════════════════════════════════
//  src/strategy/signals.js
//
//  Multi-Timeframe Trend Following Strategy
//
//  Timeframes:
//    4H  → Market bias (trend direction)
//    30M  → Confirmation (trend alignment)
//    15M → Entry (pullback + trigger candle)
//
//  Rules:
//    ALL THREE must align — any mismatch = NO TRADE
//    2hr forced close is handled by trader.js
// ═══════════════════════════════════════════════════════

const MIN_BARS_H4  = 50;
const MIN_BARS_M30 = 50;
const MIN_BARS_M15 = 60;

const LONDON_START   = 7;
const LONDON_END     = 16;
const NEW_YORK_START = 12;
const NEW_YORK_END   = 21;


// ═══════════════════════════════════════════════════════
//  MARKET HOURS
// ═══════════════════════════════════════════════════════
const MARKET_SCHEDULE = {
  frxEURUSD: "forex", frxGBPUSD: "forex", frxUSDJPY: "forex",
  frxUSDCHF: "forex", frxAUDUSD: "forex", frxUSDCAD: "forex",
  frxNZDUSD: "forex", frxXAUUSD: "forex", frxXAGUSD: "forex",
  cryBTCUSD: "24/7",  cryETHUSD: "24/7",
 
};

export function isMarketOpen(symbol) {
  const schedule = MARKET_SCHEDULE[symbol];
  if (!schedule || schedule === "24/7") return true;
  const now  = new Date();
  const day  = now.getUTCDay();
  const hour = now.getUTCHours();
  const min  = now.getUTCMinutes();
  const isSaturday         = day === 6;
  const isSundayBeforeOpen = day === 0 && hour < 21;
  const isFridayAfterClose = day === 5 && (hour > 21 || (hour === 21 && min >= 0));
  return !(isSaturday || isSundayBeforeOpen || isFridayAfterClose);
}

export function sessionName() {
  const hour    = new Date().getUTCHours();
  const london  = hour >= LONDON_START   && hour < LONDON_END;
  const newYork = hour >= NEW_YORK_START && hour < NEW_YORK_END;
  if (london && newYork) return "London+NY overlap";
  if (london)  return "London";
  if (newYork) return "New York";
  return "off-session";
}


// ═══════════════════════════════════════════════════════
//  MATH HELPERS
// ═══════════════════════════════════════════════════════
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

function atr(df, period = 14) {
  const tr = [];
  for (let i = 1; i < df.length; i++) {
    tr.push(Math.max(
      df[i].high - df[i].low,
      Math.abs(df[i].high - df[i - 1].close),
      Math.abs(df[i].low  - df[i - 1].close)
    ));
  }
  const vals = new Array(tr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  vals[period - 1] = sum / period;
  for (let i = period; i < tr.length; i++) {
    vals[i] = (vals[i - 1] * (period - 1) + tr[i]) / period;
  }
  return vals;
}

function clip(v, min, max) { return Math.max(min, Math.min(max, v)); }


// ═══════════════════════════════════════════════════════
//  ATR / VOLATILITY
// ═══════════════════════════════════════════════════════
export function getAtr(df, period = 14) {
  const vals = atr(df, period);
  return vals[df.length - 3] ?? 0;
}

export function getAtrPct(df, period = 14) {
  return getAtr(df, period) / df[df.length - 2].close;
}

export function marketIsTradeable(df) {
  if (df.length < 20) return false;
  const pct = getAtrPct(df);
  return pct >= 0.00005 && pct <= 0.10;
}

export function getVolatilityScalar(df) {
  return parseFloat(clip(0.003 / Math.max(getAtrPct(df), 0.0001), 0.25, 1.0).toFixed(4));
}


// ═══════════════════════════════════════════════════════
//  SWING POINT DETECTION
// ═══════════════════════════════════════════════════════
function getSwingPoints(df, lookback = 5) {
  const highs = [], lows = [];
  for (let i = lookback; i < df.length - lookback; i++) {
    const slice = df.slice(i - lookback, i + lookback + 1);
    if (df[i].high === Math.max(...slice.map(c => c.high))) highs.push([i, df[i].high]);
    if (df[i].low  === Math.min(...slice.map(c => c.low)))  lows.push([i, df[i].low]);
  }
  return { highs, lows };
}

/**
 * Detect market structure:
 * Returns "bullish" (HH+HL), "bearish" (LH+LL), or "neutral"
 */
function getMarketStructure(df, lookback = 3) {
  const { highs, lows } = getSwingPoints(df, lookback);
  if (highs.length < 2 || lows.length < 2) return "neutral";

  const hh = highs[highs.length - 1][1] > highs[highs.length - 2][1];
  const hl = lows[lows.length - 1][1]   > lows[lows.length - 2][1];
  const lh = highs[highs.length - 1][1] < highs[highs.length - 2][1];
  const ll = lows[lows.length - 1][1]   < lows[lows.length - 2][1];

  if (hh && hl) return "bullish";
  if (lh && ll) return "bearish";
  return "neutral";
}

/**
 * Check if latest swing high/low has been broken
 * Returns "bullish_break", "bearish_break", or "none"
 */
function getStructureBreak(df) {
  const { highs, lows } = getSwingPoints(df, 5);
  if (!highs.length || !lows.length) return "none";
  const close    = df[df.length - 2].close;
  const prevHigh = highs[highs.length - 1][1];
  const prevLow  = lows[lows.length - 1][1];
  if (close > prevHigh) return "bullish_break";
  if (close < prevLow)  return "bearish_break";
  return "none";
}


// ═══════════════════════════════════════════════════════
//  EMA ANALYSIS
// ═══════════════════════════════════════════════════════
function getEmaAnalysis(df) {
  if (df.length < 55) return { priceAbove: false, slope: "flat", valid: false };

  const closes  = df.map(c => c.close);
  const ema50   = ema(closes, 50);
  const len     = df.length;
  const e50Now  = ema50[len - 2];
  const e50Prev = ema50[len - 6]; // 5 bars ago for slope

  if (e50Now === null || e50Prev === null) return { priceAbove: false, slope: "flat", valid: false };

  const price      = closes[len - 2];
  const priceAbove = price > e50Now;
  const slopeDiff  = e50Now - e50Prev;
  const pricePct   = Math.abs(slopeDiff) / e50Now;

  let slope;
  if (pricePct < 0.0001) slope = "flat";    // EMA is flat — no trade
  else if (slopeDiff > 0) slope = "rising";
  else                    slope = "falling";

  return { priceAbove, slope, e50: e50Now, valid: true };
}


// ═══════════════════════════════════════════════════════
//  CANDLE QUALITY FILTER
//  Reject: body < 50% range, doji, spinning top, inside bar
//  Accept: strong body, close near high/low
// ═══════════════════════════════════════════════════════
function getCandleQuality(candle, prevCandle = null) {
  const body   = Math.abs(candle.close - candle.open);
  const range  = candle.high - candle.low;
  const wickHi = candle.high - Math.max(candle.open, candle.close);
  const wickLo = Math.min(candle.open, candle.close) - candle.low;

  if (range === 0) return { valid: false, type: "doji" };

  const bodyRatio = body / range;

  // Doji — body too small
  if (bodyRatio < 0.1) return { valid: false, type: "doji" };

  // Spinning top — body < 30% with large wicks on both sides
  if (bodyRatio < 0.3 && wickHi > body && wickLo > body)
    return { valid: false, type: "spinning_top" };

  // Inside bar — entire range within previous candle
  if (prevCandle && candle.high <= prevCandle.high && candle.low >= prevCandle.low)
    return { valid: false, type: "inside_bar" };

  // Body must be >= 50% of range
  if (bodyRatio < 0.5) return { valid: false, type: "weak_body" };

  const bullish = candle.close > candle.open;

  // Close must be near high (bullish) or near low (bearish)
  if (bullish) {
    const closeNearHigh = (candle.high - candle.close) / range < 0.3;
    if (!closeNearHigh) return { valid: false, type: "weak_close" };
    return { valid: true, direction: "bullish", type: "strong" };
  } else {
    const closeNearLow = (candle.close - candle.low) / range < 0.3;
    if (!closeNearLow) return { valid: false, type: "weak_close" };
    return { valid: true, direction: "bearish", type: "strong" };
  }
}


// ═══════════════════════════════════════════════════════
//  CONFIRMATION CANDLE PATTERNS
//  Bullish engulfing, pin bar, momentum candle
//  Bearish engulfing, pin bar, momentum candle
// ═══════════════════════════════════════════════════════
function getConfirmationCandle(df) {
  if (df.length < 3) return "none";

  const c1    = df[df.length - 3];  // previous candle
  const c2    = df[df.length - 2];  // current closed candle
  const body2 = Math.abs(c2.close - c2.open);
  const range2 = c2.high - c2.low;
  const wickLo = Math.min(c2.open, c2.close) - c2.low;
  const wickHi = c2.high - Math.max(c2.open, c2.close);

  if (range2 === 0) return "none";

  // Check candle quality first
  const quality = getCandleQuality(c2, c1);
  if (!quality.valid) return "none";

  // Bullish engulfing
  if (c1.close < c1.open &&
      c2.close > c2.open &&
      c2.close > c1.open &&
      c2.open  < c1.close) return "bullish_engulfing";

  // Bearish engulfing
  if (c1.close > c1.open &&
      c2.close < c2.open &&
      c2.close < c1.open &&
      c2.open  > c1.close) return "bearish_engulfing";

  // Bullish pin bar (hammer)
  if (wickLo > body2 * 2 &&
      wickHi < body2 &&
      c2.close > c2.open) return "bullish_pin";

  // Bearish pin bar (shooting star)
  if (wickHi > body2 * 2 &&
      wickLo < body2 &&
      c2.close < c2.open) return "bearish_pin";

  // Strong bullish momentum candle
  if (c2.close > c2.open && body2 / range2 >= 0.7) return "bullish_momentum";

  // Strong bearish momentum candle
  if (c2.close < c2.open && body2 / range2 >= 0.7) return "bearish_momentum";

  return "none";
}


// ═══════════════════════════════════════════════════════
//  PULLBACK DETECTION
//  After a trend move, price retraces before next entry
// ═══════════════════════════════════════════════════════
function isPullbackComplete(df, direction) {
  if (df.length < 10) return false;

  const recent = df.slice(-10);
  const closes = recent.map(c => c.close);

  if (direction === "bullish") {
    // In uptrend: look for at least 2-3 lower closes followed by bounce
    const low   = Math.min(...closes.slice(0, 8));
    const last2 = closes.slice(-2);
    return last2[1] > last2[0] && last2[0] < closes[5]; // bouncing up from pullback
  }

  if (direction === "bearish") {
    // In downtrend: look for at least 2-3 higher closes followed by drop
    const high  = Math.max(...closes.slice(0, 8));
    const last2 = closes.slice(-2);
    return last2[1] < last2[0] && last2[0] > closes[5]; // dropping from pullback
  }

  return false;
}

/**
 * Check if 15M has formed a higher low (bullish) or lower high (bearish)
 */
function hasReversePoint(df, direction) {
  const { highs, lows } = getSwingPoints(df, 3);

  if (direction === "bullish") {
    // Need a higher low — latest low > previous low
    if (lows.length < 2) return false;
    return lows[lows.length - 1][1] > lows[lows.length - 2][1];
  }

  if (direction === "bearish") {
    // Need a lower high — latest high < previous high
    if (highs.length < 2) return false;
    return highs[highs.length - 1][1] < highs[highs.length - 2][1];
  }

  return false;
}

/**
 * Check if 15M has broken a swing high (buy) or swing low (sell)
 */
function hasBreakout(df, direction) {
  const { highs, lows } = getSwingPoints(df, 3);
  const close = df[df.length - 2].close;

  if (direction === "bullish") {
    if (!highs.length) return false;
    return close > highs[highs.length - 1][1];
  }
  if (direction === "bearish") {
    if (!lows.length) return false;
    return close < lows[lows.length - 1][1];
  }
  return false;
}


// ═══════════════════════════════════════════════════════
//  PHASE 1 — 4H BIAS
// ═══════════════════════════════════════════════════════
function get4HBias(dfH4) {
  if (!dfH4 || dfH4.length < MIN_BARS_H4) {
    return { bias: "neutral", reason: "Insufficient 4H data" };
  }

  const emaData   = getEmaAnalysis(dfH4);
  const structure = getMarketStructure(dfH4, 3);
  const bosBreak  = getStructureBreak(dfH4);

  // EMA flat = no trade
  if (!emaData.valid || emaData.slope === "flat") {
    return { bias: "neutral", reason: "4H EMA is flat — ranging market" };
  }

  // Market structure unclear
  if (structure === "neutral") {
    return { bias: "neutral", reason: "4H market structure unclear" };
  }

  // ── BULLISH: Need EMA + slope + structure (BOS is bonus) ──
  // Removed strict BOS requirement — BOS often lags
  if (emaData.priceAbove && emaData.slope === "rising" && structure === "bullish") {
    return {
      bias:     "bullish",
      reason:   `Price above EMA50 | HH+HL | EMA rising${bosBreak==="bullish_break"?" | BOS confirmed ✅":""}`,
      emaSlope: emaData.slope,
      structure,
      bosBreak,
    };
  }

  // ── BEARISH: Need EMA + slope + structure ──────────────
  if (!emaData.priceAbove && emaData.slope === "falling" && structure === "bearish") {
    return {
      bias:     "bearish",
      reason:   `Price below EMA50 | LH+LL | EMA falling${bosBreak==="bearish_break"?" | BOS confirmed ✅":""}`,
      emaSlope: emaData.slope,
      structure,
      bosBreak,
    };
  }

  // ── PARTIAL — need at least EMA + slope aligned ────────
  // e.g. EMA rising + price above but structure unclear
  if (emaData.priceAbove && emaData.slope === "rising") {
    return { bias: "neutral", reason: `4H EMA bullish but structure unclear (${structure}) — waiting` };
  }
  if (!emaData.priceAbove && emaData.slope === "falling") {
    return { bias: "neutral", reason: `4H EMA bearish but structure unclear (${structure}) — waiting` };
  }

  return {
    bias:   "neutral",
    reason: `4H: EMA ${emaData.slope} | Structure ${structure} — no clear bias`,
  };
}


// ═══════════════════════════════════════════════════════
//  PHASE 2 — 30M CONFIRMATION
// ═══════════════════════════════════════════════════════
function get30MConfirmation(dfM30, requiredBias) {
  if (!dfM30 || dfM30.length < MIN_BARS_M30) {
    return { confirmed: false, reason: "Insufficient 30M data" };
  }

  const emaData   = getEmaAnalysis(dfM30);
  const structure = getMarketStructure(dfM30, 3);
  const confirm   = getConfirmationCandle(dfM30);

  if (!emaData.valid) {
    return { confirmed: false, reason: "30M EMA calculation failed" };
  }

  if (requiredBias === "bullish") {
    // All conditions must pass
    if (!emaData.priceAbove) {
      return { confirmed: false, reason: "30M price below EMA50" };
    }
    if (structure !== "bullish") {
      return { confirmed: false, reason: `30M structure is ${structure} — need bullish HH+HL` };
    }
    const pullback = isPullbackComplete(dfM30, "bullish");
    if (!pullback) {
      return { confirmed: false, reason: "30M pullback not complete yet" };
    }
    const bullishCandles = ["bullish_engulfing", "bullish_pin", "bullish_momentum"];
    if (!bullishCandles.includes(confirm)) {
      return { confirmed: false, reason: `30M no bullish candle (got: ${confirm})` };
    }
    return {
      confirmed: true,
      reason:    `30M: EMA above ✅ | HH+HL ✅ | Pullback done ✅ | ${confirm} ✅`,
      candle:    confirm,
    };
  }

  if (requiredBias === "bearish") {
    if (emaData.priceAbove) {
      return { confirmed: false, reason: "30M price above EMA50" };
    }
    if (structure !== "bearish") {
      return { confirmed: false, reason: `30M structure is ${structure} — need bearish LH+LL` };
    }
    const pullback = isPullbackComplete(dfM30, "bearish");
    if (!pullback) {
      return { confirmed: false, reason: "30M pullback not complete yet" };
    }
    const bearishCandles = ["bearish_engulfing", "bearish_pin", "bearish_momentum"];
    if (!bearishCandles.includes(confirm)) {
      return { confirmed: false, reason: `30M no bearish candle (got: ${confirm})` };
    }
    return {
      confirmed: true,
      reason:    `30M: EMA below ✅ | LH+LL ✅ | Pullback done ✅ | ${confirm} ✅`,
      candle:    confirm,
    };
  }

  return { confirmed: false, reason: "Unknown bias" };
}


// ═══════════════════════════════════════════════════════
//  PHASE 3 — 15M ENTRY
// ═══════════════════════════════════════════════════════
function get15MEntry(dfM15, requiredBias) {
  if (!dfM15 || dfM15.length < MIN_BARS_M15) {
    return { valid: false, reason: "Insufficient 15M data" };
  }

  const triggerCandle = getConfirmationCandle(dfM15);
  const reversePoint  = hasReversePoint(dfM15, requiredBias);
  const breakout      = hasBreakout(dfM15, requiredBias);

  if (requiredBias === "bullish") {
    // Must have pullback forming higher low
    if (!reversePoint) {
      return { valid: false, reason: "15M no higher low formed yet" };
    }
    // Must have bullish trigger candle OR breakout of swing high
    const bullishTriggers = ["bullish_engulfing", "bullish_pin", "bullish_momentum"];
    if (!bullishTriggers.includes(triggerCandle) && !breakout) {
      return { valid: false, reason: `15M no trigger (candle: ${triggerCandle}, breakout: ${breakout})` };
    }
    const entryType = breakout ? "swing_high_breakout" : triggerCandle;
    return {
      valid:  true,
      reason: `15M: Higher low ✅ | Entry: ${entryType} ✅`,
      entry:  entryType,
    };
  }

  if (requiredBias === "bearish") {
    if (!reversePoint) {
      return { valid: false, reason: "15M no lower high formed yet" };
    }
    const bearishTriggers = ["bearish_engulfing", "bearish_pin", "bearish_momentum"];
    if (!bearishTriggers.includes(triggerCandle) && !breakout) {
      return { valid: false, reason: `15M no trigger (candle: ${triggerCandle}, breakout: ${breakout})` };
    }
    const entryType = breakout ? "swing_low_breakout" : triggerCandle;
    return {
      valid:  true,
      reason: `15M: Lower high ✅ | Entry: ${entryType} ✅`,
      entry:  entryType,
    };
  }

  return { valid: false, reason: "Unknown bias" };
}


// ═══════════════════════════════════════════════════════
//  MASTER SIGNAL ENGINE
// ═══════════════════════════════════════════════════════
function getSignal(dfM15, dfM30, dfH4) {
  const result = {
    signal:      0,
    phase1:      null,
    phase2:      null,
    phase3:      null,
    rejectAt:    null,
    rejectReason: null,
    session:     sessionName(),
  };

  // Market quality check
  if (!dfM15 || dfM15.length < MIN_BARS_M15) {
    result.rejectAt = "data"; result.rejectReason = "Insufficient 15M data";
    return result;
  }
  if (!marketIsTradeable(dfM15)) {
    result.rejectAt = "market"; result.rejectReason = "Poor market conditions";
    return result;
  }

  // ── PHASE 1: 4H BIAS ──────────────────────────────────
  const phase1 = get4HBias(dfH4);
  result.phase1 = phase1;

  if (phase1.bias === "neutral") {
    result.rejectAt = "phase1"; result.rejectReason = phase1.reason;
    return result;
  }

  // ── PHASE 2: 30M CONFIRMATION ──────────────────────────
  const phase2 = get30MConfirmation(dfM30, phase1.bias);
  result.phase2 = phase2;

  if (!phase2.confirmed) {
    result.rejectAt = "phase2"; result.rejectReason = phase2.reason;
    return result;
  }

  // ── PHASE 3: 15M ENTRY ────────────────────────────────
  const phase3 = get15MEntry(dfM15, phase1.bias);
  result.phase3 = phase3;

  if (!phase3.valid) {
    result.rejectAt = "phase3"; result.rejectReason = phase3.reason;
    return result;
  }

  // ALL THREE ALIGNED — fire signal
  result.signal = phase1.bias === "bullish" ? 1 : -1;
  return result;
}


// ═══════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════

export function getLatestSignalMtf(dfM15, dfM30, dfH4 = null) {
  return getSignal(dfM15, dfM30, dfH4).signal;
}

export function getSignalStrength(dfM15, dfM30 = null, dfH4 = null) {
  const r = getSignal(dfM15, dfM30, dfH4);
  // Strength based on how many phases passed
  if (r.signal !== 0)      return 100;
  if (r.rejectAt === "phase3") return 67;
  if (r.rejectAt === "phase2") return 33;
  return 0;
}

export function getTradeReason(dfM15, dfM30, dfH4 = null) {
  const r = getSignal(dfM15, dfM30, dfH4);
  const direction = r.signal === 1 ? "BUY" : r.signal === -1 ? "SELL" : "HOLD";

  const lines = [`TREND FOLLOW SIGNAL — ${direction}`];
  lines.push(`  Session  : ${r.session}`);
  lines.push(`  ─────────────────────────`);

  // Phase 1
  if (r.phase1) {
    const icon = r.phase1.bias !== "neutral" ? "✅" : "❌";
    lines.push(`  Phase 1 (4H) : ${r.phase1.bias.toUpperCase()} ${icon}`);
    lines.push(`    ${r.phase1.reason}`);
  } else {
    lines.push(`  Phase 1 (4H) : ❌ no data`);
  }

  // Phase 2
  if (r.phase2) {
    const icon = r.phase2.confirmed ? "✅" : "❌";
    lines.push(`  Phase 2 (30M) : ${r.phase2.confirmed ? "CONFIRMED" : "FAILED"} ${icon}`);
    lines.push(`    ${r.phase2.reason}`);
  } else {
    lines.push(`  Phase 2 (30M) : ⏸ skipped (Phase 1 failed)`);
  }

  // Phase 3
  if (r.phase3) {
    const icon = r.phase3.valid ? "✅" : "❌";
    lines.push(`  Phase 3 (15M): ${r.phase3.valid ? "ENTRY VALID" : "NO ENTRY"} ${icon}`);
    lines.push(`    ${r.phase3.reason}`);
  } else {
    lines.push(`  Phase 3 (15M): ⏸ skipped (Phase 2 failed)`);
  }

  lines.push(`  ─────────────────────────`);
  if (r.signal !== 0) {
    lines.push(`  ✅ ALL 3 PHASES ALIGNED — TRADE FIRES`);
    lines.push(`  ⏱️  Will force-close in 2 hours if SL/TP not hit`);
  } else {
    lines.push(`  ❌ REJECTED at ${r.rejectAt?.toUpperCase() || "unknown"}: ${r.rejectReason}`);
  }

  return lines.join("\n");
}

export function get15mTrend(dfM30) {
  if (!dfM30 || dfM30.length < 55) return "neutral";
  const emaData = getEmaAnalysis(dfM30);
  if (!emaData.valid || emaData.slope === "flat") return "neutral";
  if (emaData.priceAbove && emaData.slope === "rising")  return "bullish";
  if (!emaData.priceAbove && emaData.slope === "falling") return "bearish";
  return "neutral";
}