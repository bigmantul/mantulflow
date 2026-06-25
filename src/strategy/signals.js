// ═══════════════════════════════════════════════════════
//  src/strategy/signals.js
//
//  DAILY BIAS STRATEGY (single strategy — full replacement
//  of the previous 5-strategy multi-vote engine)
//
//  Step 1: Daily candle establishes BULLISH / BEARISH /
//          NO BIAS, validated against wick-rejection rules
//  Step 2: Daily bias must align with broader trend
//          structure (HH/HL or LH/LL) — mismatch = NO TRADE
//  Step 3: 1H confluence — look for setups in the bias
//          direction only
//  Step 4: 15M entry — wait for candle close, enter on
//          rejection/engulfing confirmation
//
//  Timeframes used: D1 (daily) → H1 → M15
//  4H/30M are no longer used by this strategy.
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
//  SHARED UTILITIES
// ═══════════════════════════════════════════════════════

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

function candleBody(c)  { return Math.abs(c.close - c.open); }
function candleRange(c) { return c.high - c.low; }

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

// Price above key swing lows (bullish trend support)
function priceAboveSwingLows(df, lookback = 4) {
  const { lows } = getSwings(df, lookback);
  if (!lows.length) return false;
  const price = df[df.length - 2].close;
  return price > lows[lows.length - 1].price;
}

// Price below key swing highs (bearish trend support)
function priceBelowSwingHighs(df, lookback = 4) {
  const { highs } = getSwings(df, lookback);
  if (!highs.length) return false;
  const price = df[df.length - 2].close;
  return price < highs[highs.length - 1].price;
}


// ═══════════════════════════════════════════════════════
//  STEP 1 — DAILY BIAS DETECTION
//
//  Bullish: bullish candle, closes near high, breaks prev
//           day's high, upper wick ≤ 40% of body
//  Bearish: bearish candle, closes near low, breaks prev
//           day's low, lower wick ≤ 40% of body
//  Invalidated: opposing wick > 40% of body → NO BIAS
// ═══════════════════════════════════════════════════════

function getDailyBias(dfD1) {
  if (!dfD1 || dfD1.length < 3) {
    return { bias: "none", reason: "Insufficient daily data" };
  }

  // Last fully CLOSED daily candle (today's candle is still forming)
  const candle   = dfD1[dfD1.length - 2];
  const prevDay   = dfD1[dfD1.length - 3];

  const body  = candleBody(candle);
  const range = candleRange(candle);
  if (range === 0 || body === 0) {
    return { bias: "none", reason: "Zero-range/zero-body daily candle" };
  }

  const isBullishCandle = candle.close > candle.open;
  const isBearishCandle = candle.close < candle.open;

  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;

  const upperWickPct = upperWick / body;
  const lowerWickPct = lowerWick / body;

  // ── BULLISH BIAS CHECK ──
  if (isBullishCandle) {
    const breaksPrevHigh = candle.high > prevDay.high;
    const closesNearHigh  = (candle.high - candle.close) / range <= 0.25; // close in top 25%
    const wickValid        = upperWickPct <= 0.40;

    if (breaksPrevHigh && closesNearHigh && wickValid) {
      return {
        bias: "bullish",
        reason: `Bullish daily: breaks prev high, closes near high, upper wick ${(upperWickPct*100).toFixed(0)}% of body`,
        upperWickPct, lowerWickPct, candle, prevDay,
      };
    }
    if (!wickValid) {
      return { bias: "none", reason: `Invalidated — upper wick ${(upperWickPct*100).toFixed(0)}% of body (>40% = strong rejection)` };
    }
    return { bias: "none", reason: "Bullish candle but doesn't break prev high / close near high" };
  }

  // ── BEARISH BIAS CHECK ──
  if (isBearishCandle) {
    const breaksPrevLow  = candle.low < prevDay.low;
    const closesNearLow   = (candle.close - candle.low) / range <= 0.25; // close in bottom 25%
    const wickValid        = lowerWickPct <= 0.40;

    if (breaksPrevLow && closesNearLow && wickValid) {
      return {
        bias: "bearish",
        reason: `Bearish daily: breaks prev low, closes near low, lower wick ${(lowerWickPct*100).toFixed(0)}% of body`,
        upperWickPct, lowerWickPct, candle, prevDay,
      };
    }
    if (!wickValid) {
      return { bias: "none", reason: `Invalidated — lower wick ${(lowerWickPct*100).toFixed(0)}% of body (>40% = strong rejection)` };
    }
    return { bias: "none", reason: "Bearish candle but doesn't break prev low / close near low" };
  }

  return { bias: "none", reason: "Doji / indecisive daily candle" };
}


// ═══════════════════════════════════════════════════════
//  STEP 2 — TREND ALIGNMENT CHECK
//
//  Daily bias must align with broader trend structure.
//  Bullish bias requires: HH+HL structure, price above
//  key swing lows.
//  Bearish bias requires: LH+LL structure, price below
//  key swing highs.
//  Mismatch (e.g. bullish daily candle but bearish trend)
//  → NO BIAS / NO TRADE.
// ═══════════════════════════════════════════════════════

function checkTrendAlignment(dailyBias, dfD1) {
  if (dailyBias === "none") return { aligned: false, reason: "No daily bias to align" };

  const structure = getStructure(dfD1, 3);

  if (dailyBias === "bullish") {
    const structureOk = structure === "bullish";
    const aboveSwingLows = priceAboveSwingLows(dfD1, 3);
    if (structureOk && aboveSwingLows) {
      return { aligned: true, reason: "Bullish daily bias confirmed by HH/HL trend + price above swing lows" };
    }
    return { aligned: false, reason: `Daily candle bullish but trend is ${structure} — bias invalidated, NO TRADE` };
  }

  if (dailyBias === "bearish") {
    const structureOk = structure === "bearish";
    const belowSwingHighs = priceBelowSwingHighs(dfD1, 3);
    if (structureOk && belowSwingHighs) {
      return { aligned: true, reason: "Bearish daily bias confirmed by LH/LL trend + price below swing highs" };
    }
    return { aligned: false, reason: `Daily candle bearish but trend is ${structure} — bias invalidated, NO TRADE` };
  }

  return { aligned: false, reason: "Unknown bias state" };
}


// ═══════════════════════════════════════════════════════
//  CANDLE PATTERN HELPERS (used on 1H + 15M)
// ═══════════════════════════════════════════════════════

function isBullishEngulfing(c, prev) {
  if (!c || !prev) return false;
  return c.close > c.open &&
         c.open  < prev.close &&
         c.close > prev.open &&
         candleBody(c) / candleRange(c) >= 0.5;
}

function isBearishEngulfing(c, prev) {
  if (!c || !prev) return false;
  return c.close < c.open &&
         c.open  > prev.close &&
         c.close < prev.open &&
         candleBody(c) / candleRange(c) >= 0.5;
}

// Strong momentum candle: body >= 60% of range
function isBullishMomentum(c) {
  if (!c) return false;
  const range = candleRange(c);
  if (range === 0) return false;
  return c.close > c.open && candleBody(c) / range >= 0.60;
}

function isBearishMomentum(c) {
  if (!c) return false;
  const range = candleRange(c);
  if (range === 0) return false;
  return c.close < c.open && candleBody(c) / range >= 0.60;
}

// Long lower rejection wick (bullish rejection)
function hasLongLowerWick(c, minPct = 0.5) {
  if (!c) return false;
  const range = candleRange(c);
  if (range === 0) return false;
  const lowerWick = Math.min(c.open, c.close) - c.low;
  return lowerWick / range >= minPct;
}

// Long upper rejection wick (bearish rejection)
function hasLongUpperWick(c, minPct = 0.5) {
  if (!c) return false;
  const range = candleRange(c);
  if (range === 0) return false;
  const upperWick = c.high - Math.max(c.open, c.close);
  return upperWick / range >= minPct;
}

// Bullish rejection candle = bullish engulfing OR long lower wick + bullish close
function isBullishRejection(c, prev) {
  return isBullishEngulfing(c, prev) ||
         (hasLongLowerWick(c) && c.close > c.open);
}

function isBearishRejection(c, prev) {
  return isBearishEngulfing(c, prev) ||
         (hasLongUpperWick(c) && c.close < c.open);
}

// Pullback detection — price dipped (bull) or rallied (bear) before current candle
function hasBullishPullback(df, lookback = 8) {
  if (df.length < lookback + 2) return false;
  const slice  = df.slice(-lookback - 2, -1).map(c => c.close);
  const minVal = Math.min(...slice.slice(0, -1));
  return minVal < slice[0];
}

function hasBearishPullback(df, lookback = 8) {
  if (df.length < lookback + 2) return false;
  const slice  = df.slice(-lookback - 2, -1).map(c => c.close);
  const maxVal = Math.max(...slice.slice(0, -1));
  return maxVal > slice[0];
}

// Consecutive higher lows / lower highs (1H confluence check)
function hasConsecutiveHigherLows(df, lookback = 3, count = 2) {
  const { lows } = getSwings(df, lookback);
  if (lows.length < count + 1) return false;
  for (let i = lows.length - count; i < lows.length; i++) {
    if (lows[i].price <= lows[i - 1].price) return false;
  }
  return true;
}

function hasConsecutiveLowerHighs(df, lookback = 3, count = 2) {
  const { highs } = getSwings(df, lookback);
  if (highs.length < count + 1) return false;
  for (let i = highs.length - count; i < highs.length; i++) {
    if (highs[i].price >= highs[i - 1].price) return false;
  }
  return true;
}

// Avoid filter: large opposing engulfing candle present recently on 1H
function hasRecentOpposingEngulfing(df, direction, lookback = 5) {
  const recent = df.slice(-lookback - 1, -1);
  for (let i = 1; i < recent.length; i++) {
    if (direction === "bull" && isBearishEngulfing(recent[i], recent[i - 1])) return true;
    if (direction === "bear" && isBullishEngulfing(recent[i], recent[i - 1])) return true;
  }
  return false;
}


// ═══════════════════════════════════════════════════════
//  STEP 3 — 1H CONFLUENCE CHECK
//
//  Only search for setups in the direction of daily bias.
//  Bullish: bullish engulfing, strong bullish momentum,
//           long lower rejection wicks, small pullback +
//           strong bullish close, consecutive higher lows.
//  Bearish: mirror of the above.
//  Avoid: large opposing engulfing, repeated rejection
//         from resistance/support.
// ═══════════════════════════════════════════════════════

function check1hConfluence(dailyBias, dfH1) {
  if (!dfH1 || dfH1.length < 20) {
    return { confluence: false, reason: "Insufficient 1H data" };
  }

  const len  = dfH1.length;
  const last = dfH1[len - 2];
  const prev = dfH1[len - 3];

  if (dailyBias === "bullish") {
    // Avoid filter first
    if (hasRecentOpposingEngulfing(dfH1, "bull")) {
      return { confluence: false, reason: "1H shows recent large bearish engulfing — avoid" };
    }

    const engulfing   = isBullishEngulfing(last, prev);
    const momentum     = isBullishMomentum(last);
    const longWick      = hasLongLowerWick(last);
    const pullbackThenStrong = hasBullishPullback(dfH1, 6) && isBullishMomentum(last);
    const higherLows    = hasConsecutiveHigherLows(dfH1, 3, 2);

    const signals = [engulfing, momentum, longWick, pullbackThenStrong, higherLows];
    const matchCount = signals.filter(Boolean).length;

    if (matchCount >= 1) {
      const reasons = [];
      if (engulfing) reasons.push("bullish engulfing");
      if (momentum) reasons.push("strong bullish momentum");
      if (longWick) reasons.push("long lower rejection wick");
      if (pullbackThenStrong) reasons.push("pullback + strong bullish close");
      if (higherLows) reasons.push("consecutive higher lows");
      return { confluence: true, reason: `1H bullish confluence: ${reasons.join(", ")}` };
    }
    return { confluence: false, reason: "No bullish confluence pattern found on 1H" };
  }

  if (dailyBias === "bearish") {
    if (hasRecentOpposingEngulfing(dfH1, "bear")) {
      return { confluence: false, reason: "1H shows recent large bullish engulfing — avoid" };
    }

    const engulfing   = isBearishEngulfing(last, prev);
    const momentum     = isBearishMomentum(last);
    const longWick      = hasLongUpperWick(last);
    const rallyThenStrong = hasBearishPullback(dfH1, 6) && isBearishMomentum(last);
    const lowerHighs    = hasConsecutiveLowerHighs(dfH1, 3, 2);

    const signals = [engulfing, momentum, longWick, rallyThenStrong, lowerHighs];
    const matchCount = signals.filter(Boolean).length;

    if (matchCount >= 1) {
      const reasons = [];
      if (engulfing) reasons.push("bearish engulfing");
      if (momentum) reasons.push("strong bearish momentum");
      if (longWick) reasons.push("long upper rejection wick");
      if (rallyThenStrong) reasons.push("small rally + strong bearish close");
      if (lowerHighs) reasons.push("consecutive lower highs");
      return { confluence: true, reason: `1H bearish confluence: ${reasons.join(", ")}` };
    }
    return { confluence: false, reason: "No bearish confluence pattern found on 1H" };
  }

  return { confluence: false, reason: "No daily bias to check confluence against" };
}


// ═══════════════════════════════════════════════════════
//  STEP 4 — 15M ENTRY
//
//  Wait for candle CLOSE.
//  Buy: daily bullish + 1H bullish confluence + 15M
//       pullback + bullish rejection/engulfing closes.
//  Sell: daily bearish + 1H bearish confluence + 15M
//        retracement + bearish rejection/engulfing closes.
// ═══════════════════════════════════════════════════════

function check15mEntry(dailyBias, dfM15) {
  if (!dfM15 || dfM15.length < 15) {
    return { signal: SIG_HOLD, reason: "Insufficient 15M data" };
  }

  const len  = dfM15.length;
  const last = dfM15[len - 2]; // last CLOSED candle
  const prev = dfM15[len - 3];

  if (dailyBias === "bullish") {
    const pullback = hasBullishPullback(dfM15, 8);
    if (!pullback) {
      return { signal: SIG_HOLD, reason: "No 15M pullback yet — waiting" };
    }
    const rejection = isBullishRejection(last, prev);
    if (!rejection) {
      return { signal: SIG_HOLD, reason: "15M pullback present but no bullish rejection/engulfing candle closed yet" };
    }
    return { signal: SIG_BUY, reason: "15M pullback + bullish rejection/engulfing candle closed — BUY" };
  }

  if (dailyBias === "bearish") {
    const retracement = hasBearishPullback(dfM15, 8);
    if (!retracement) {
      return { signal: SIG_HOLD, reason: "No 15M retracement yet — waiting" };
    }
    const rejection = isBearishRejection(last, prev);
    if (!rejection) {
      return { signal: SIG_HOLD, reason: "15M retracement present but no bearish rejection/engulfing candle closed yet" };
    }
    return { signal: SIG_SELL, reason: "15M retracement + bearish rejection/engulfing candle closed — SELL" };
  }

  return { signal: SIG_HOLD, reason: "No daily bias" };
}


// ═══════════════════════════════════════════════════════
//  MAIN SIGNAL FUNCTION
//  tf = { d1, h1, m15 }  (h4/m30 no longer used)
// ═══════════════════════════════════════════════════════

export function collectSignals(tf) {
  const { d1, h1, m15 } = tf;

  // ── STEP 1: DAILY BIAS ──
  const dailyResult = getDailyBias(d1);
  const breakdown = [{ step: "DailyBias", result: dailyResult.bias.toUpperCase(), reason: dailyResult.reason }];

  if (dailyResult.bias === "none") {
    return {
      signal: SIG_HOLD,
      breakdown,
      reason: `NO TRADE — ${dailyResult.reason}`,
      dailyBias: "none",
    };
  }

  // ── STEP 2: TREND ALIGNMENT ──
  const alignment = checkTrendAlignment(dailyResult.bias, d1);
  breakdown.push({ step: "TrendAlignment", result: alignment.aligned ? "ALIGNED" : "MISMATCH", reason: alignment.reason });

  if (!alignment.aligned) {
    return {
      signal: SIG_HOLD,
      breakdown,
      reason: `NO TRADE — ${alignment.reason}`,
      dailyBias: dailyResult.bias,
    };
  }

  // ── STEP 3: 1H CONFLUENCE ──
  const confluence = check1hConfluence(dailyResult.bias, h1);
  breakdown.push({ step: "1H Confluence", result: confluence.confluence ? "CONFIRMED" : "NONE", reason: confluence.reason });

  if (!confluence.confluence) {
    return {
      signal: SIG_HOLD,
      breakdown,
      reason: `WAIT — ${confluence.reason}`,
      dailyBias: dailyResult.bias,
    };
  }

  // ── STEP 4: 15M ENTRY ──
  const entry = check15mEntry(dailyResult.bias, m15);
  breakdown.push({ step: "15M Entry", result: entry.signal === SIG_HOLD ? "WAIT" : (entry.signal === SIG_BUY ? "BUY" : "SELL"), reason: entry.reason });

  return {
    signal: entry.signal,
    breakdown,
    reason: entry.reason,
    dailyBias: dailyResult.bias,
  };
}

export function getTradeReason(tf) {
  const result = collectSignals(tf);
  const direction = result.signal === SIG_BUY ? "BUY" : result.signal === SIG_SELL ? "SELL" : "HOLD/WAIT";

  const lines = [
    `DAILY BIAS STRATEGY — ${direction}`,
    `  Session   : ${sessionName()}`,
    `  Daily Bias: ${(result.dailyBias || "none").toUpperCase()}`,
    `  ──────────────────────────────`,
  ];

  for (const step of result.breakdown) {
    const icon = step.result === "BUY" || step.result === "BULLISH" || step.result === "ALIGNED" || step.result === "CONFIRMED"
      ? "🟢"
      : step.result === "SELL" || step.result === "BEARISH"
      ? "🔴"
      : "⬜";
    lines.push(`  ${icon} ${step.step.padEnd(16)}: ${step.result}`);
    lines.push(`     ${step.reason}`);
  }

  lines.push(`  ──────────────────────────────`);
  lines.push(`  Decision  : ${direction}`);

  return lines.join("\n");
}


// ═══════════════════════════════════════════════════════
//  LEGACY COMPATIBILITY EXPORTS
//  (kept so bot-manager.js / index.js need minimal changes
//   beyond passing d1 instead of h4/m30)
// ═══════════════════════════════════════════════════════

export function getLatestSignalMtf(dfM15, dfH1, dfD1) {
  return collectSignals({ d1: dfD1, h1: dfH1, m15: dfM15 }).signal;
}

// Kept for any dashboard display code that still calls this —
// now reflects the daily bias trend instead of 4H EMA trend.
export function get15mTrend(dfD1) {
  const result = getDailyBias(dfD1);
  if (result.bias === "bullish") return "bullish";
  if (result.bias === "bearish") return "bearish";
  return "neutral";
}