// ═══════════════════════════════════════════════════════
//  src/strategy/signals.js
//
//  DAILY BIAS STRATEGY — 3-STAGE STATE MACHINE
//
//  Stage 1: Daily Bias — computed ONCE per trading day,
//           after the previous daily candle closes.
//  Stage 2: 1H Confirmation — NOT an entry signal. The most
//           recent CLOSED 1H candle must have BOTH its open
//           AND close beyond yesterday's D1 high (bullish)
//           or D1 low (bearish), AND pass the valid-candle
//           body>wick test. Once confirmed, the symbol
//           enters "Entry Mode" (permission to look for an
//           entry granted, but no trade yet) and the epoch
//           of that confirming H1 candle is remembered.
//  Stage 3: 15M Entry — only checked once in Entry Mode.
//           Looks at the 4 fifteen-minute candles that made
//           up the confirming H1 candle. ANY 3 CONSECUTIVE
//           of those 4 (1-2-3 or 2-3-4) must each be a valid
//           candle (body>wick, matching bias direction) with
//           open AND close beyond the same D1 level. Once
//           found, enters at the OPEN of the NEXT 15M candle
//           (not immediately).
//
//  SESSION RULE: Daily bias (Stage 1) is computed any time
//  of day. Stage 2 + Stage 3 only run for FX/Metals during
//  London, New York, or the overlap — outside that window
//  the bias is held and re-checked next session.
//  Synthetics/Crypto run all 3 stages 24/7, unaffected.
//
//  STATE PERSISTENCE: Entry Mode must persist across scan
//  cycles per symbol (the bot "remembers" that 1H gave
//  permission until either a trade is entered or the daily
//  bias becomes invalid). See SymbolStateStore below.
//
//  Timeframes used: D1 → H1 → M15
// ═══════════════════════════════════════════════════════

// ── SIGNAL CONSTANTS ──────────────────────────────────
export const SIG_BUY  =  1;
export const SIG_SELL = -1;
export const SIG_HOLD =  0;

// ── MARKET CLASSIFICATION ─────────────────────────────
// NOTE: actual market OPEN/CLOSED hours, NOT a session
// liquidity filter. FX/Metals are open nearly 24hrs/day
// Mon-Fri (closed Fri ~21:00 UTC -> Sun ~21:00 UTC).
// Synthetics/crypto trade 24/7 with no weekend close.
const SYNTHETIC_SYMBOLS = new Set([
  // Boom Indices
  "BOOM50","BOOM500","BOOM600","BOOM900","BOOM1000",
  // Crash Indices
  "CRASH50","CRASH500","CRASH600","CRASH900","CRASH1000",
  // Jump Indices
  "JD10","JD25","JD50","JD75","JD100",
  // Step Indices
  "STPRNG","STPRNG2","STPRNG3","STPRNG4","STPRNG5",
  // Volatility Indices
  "R_10","R_25","R_50","R_75","R_100",
  // 1Hz Volatility Indices
  "1HZ10V","1HZ15V","1HZ25V","1HZ50V","1HZ75V","1HZ90V","1HZ100V",
]);
const CRYPTO_SYMBOLS = new Set(["cryBTCUSD","cryETHUSD"]);

export function isMarketOpen(symbol) {
  if (SYNTHETIC_SYMBOLS.has(symbol) || CRYPTO_SYMBOLS.has(symbol)) return true;

  // FX / Metals: open Sun 21:00 UTC -> Fri 21:00 UTC (continuous)
  const now  = new Date();
  const day  = now.getUTCDay();   // 0=Sun, 5=Fri, 6=Sat
  const hour = now.getUTCHours();

  if (day === 6) return false;                    // all day Saturday = closed
  if (day === 0 && hour < 21) return false;        // Sunday before 21:00 UTC = closed
  if (day === 5 && hour >= 21) return false;        // Friday after 21:00 UTC = closed
  return true;                                       // otherwise open
}

// Session label is purely informational for logs/Telegram, but
// isInTradingSession() below DOES gate Stage 3/4 for FX/Metals.
const LONDON_START = 7, LONDON_END = 16;
const NY_START     = 12, NY_END    = 21;

/**
 * Gates Stage 3 (1H confirmation) and Stage 4 (15M entry) ONLY.
 * Daily bias (Stage 1/2) is NOT gated by this — it's computed
 * any time of day since it only depends on the daily candle.
 *
 * FX / Metals: only during London, New York, or the overlap.
 * Synthetics / Crypto: always true (24/7 markets).
 */
export function isInTradingSession(symbol) {
  if (SYNTHETIC_SYMBOLS.has(symbol) || CRYPTO_SYMBOLS.has(symbol)) return true;

  const hour   = new Date().getUTCHours();
  const london = hour >= LONDON_START && hour < LONDON_END;
  const ny     = hour >= NY_START     && hour < NY_END;
  return london || ny; // covers the overlap automatically (12:00-16:00 UTC)
}

export function sessionName() {
  const hour   = new Date().getUTCHours();
  const london = hour >= LONDON_START && hour < LONDON_END;
  const ny     = hour >= NY_START     && hour < NY_END;
  if (london && ny) return "London+NY overlap";
  if (london)       return "London";
  if (ny)           return "New York";
  return "Asian/off-peak";
}


// ═══════════════════════════════════════════════════════
//  SYMBOL STATE STORE
//
//  Tracks per-symbol state across scan cycles:
//    - dailyBiasDate: which calendar day this bias was
//      computed for (so it's only recomputed once/day)
//    - dailyBias: "bullish" | "bearish" | "none"
//    - entryMode: false until 1H confirms, then true
//    - pendingEntry: set when a 15M signal candle just
//      closed — the ACTUAL entry happens on the NEXT 15M
//      candle's open, so we need to remember "enter on the
//      next tick" between scan cycles.
//    - lastM15Epoch: the epoch of the most recent M15
//      candle we've already evaluated, so we don't
//      re-process the same closed candle twice.
// ═══════════════════════════════════════════════════════

const symbolState = new Map();

function getState(symbol) {
  if (!symbolState.has(symbol)) {
    symbolState.set(symbol, {
      dailyBiasDate: null,
      dailyBias:     "none",
      dailyBiasMeta: null,
      entryMode:     false,
      entryModeReason: "",
      entryModeH1Epoch: null, // epoch of the H1 candle Stage 2 confirmed against
      pendingEntry:  null,   // { direction, signalEpoch } or null
      lastM15Epoch:  null,
    });
  }
  return symbolState.get(symbol);
}

export function resetSymbolState(symbol) {
  symbolState.delete(symbol);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
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

// Simple majority-vote HTF trend: among the most recent `lookback`
// CLOSED daily candles (excludes the still-forming last array
// element), count bullish (close > open) vs bearish (close < open).
// Whichever has more candles determines the trend; a tie is neutral.
// Used by Rule B in computeDailyBias.
function getSimpleTrend(dfD1, lookback = 30) {
  if (!dfD1 || dfD1.length < 2) return "neutral";
  const closed = dfD1.slice(0, dfD1.length - 1); // exclude still-forming candle
  const recent = closed.slice(-lookback);
  let bullishCount = 0, bearishCount = 0;
  for (const c of recent) {
    if (c.close > c.open) bullishCount++;
    else if (c.close < c.open) bearishCount++;
    // c.close === c.open (doji) counts toward neither
  }
  if (bearishCount > bullishCount) return "bearish";
  if (bullishCount > bearishCount) return "bullish";
  return "neutral";
}


// ═══════════════════════════════════════════════════════
//  STAGE 1 — DAILY BIAS (computed once per trading day)
//
//  Step 1 — Validate each daily candle independently:
//    Valid Bullish: Close > Open, AND Body > Upper Wick
//                   (Body = Close-Open, Upper Wick = High-Close)
//    Valid Bearish: Close < Open, AND Body > Lower Wick
//                   (Body = Open-Close, Lower Wick = Close-Low)
//    Rule: the body must be strictly bigger than the relevant
//    wick. Equal size (wick = 100% of body) or wick >= body
//    is invalid.
//
//  Step 2 — Count consecutive valid candles of the SAME
//    direction. ANY invalid candle (wrong direction, or
//    wick >= body) resets count to zero. Never count an
//    invalid candle toward the
//    3-candle confirmation.
//
//  Step 3 — Determine bias:
//    Bearish if (Rule A: yesterday valid bearish AND
//                completes 3 consecutive valid bearish)
//             OR (Rule B: HTF trend is bearish)
//    Bullish if (Rule A: yesterday valid bullish AND
//                completes 3 consecutive valid bullish)
//             OR (Rule B: HTF trend is bullish)
//    Otherwise: HOLD (no bias)
// ═══════════════════════════════════════════════════════

/**
 * Validates a single daily candle per the new rules.
 * Returns { valid: bool, direction: "bullish"|"bearish"|null, wickPct, reason }
 */
function validateDailyCandle(candle) {
  const body  = candle.close - candle.open; // signed: positive = bullish, negative = bearish
  const range = candleRange(candle);

  if (range === 0 || body === 0) {
    return { valid: false, direction: null, reason: "Zero-range/zero-body candle" };
  }

  if (body > 0) {
    // ── BULLISH CANDLE ──
    // Step 1: Close > Open (already confirmed by body > 0)
    // Step 2: Body = Close - Open
    const bodyAbs = body;
    // Step 3: Upper Wick = High - Close
    const upperWick = candle.high - candle.close;
    // Step 4: Valid if Body > Upper Wick, else Invalid
    // (the body must be bigger than the wick — equal or smaller is invalid)
    const wickValid = bodyAbs > upperWick;
    const upperWickPct = (upperWick / bodyAbs) * 100; // kept for logging only

    if (wickValid) {
      return { valid: true, direction: "bullish", wickPct: upperWickPct, reason: `Valid bullish — body (${bodyAbs.toFixed(5)}) > upper wick (${upperWick.toFixed(5)})` };
    }
    return { valid: false, direction: "bullish", wickPct: upperWickPct, reason: `Invalid bullish — upper wick (${upperWick.toFixed(5)}) >= body (${bodyAbs.toFixed(5)})` };
  }

  if (body < 0) {
    // ── BEARISH CANDLE ──
    // Step 1: Close < Open (already confirmed by body < 0)
    // Step 2: Body = Open - Close
    const bodyAbs = -body;
    // Step 3: Lower Wick = Close - Low
    const lowerWick = candle.close - candle.low;
    // Step 4: Valid if Body > Lower Wick, else Invalid
    const wickValid = bodyAbs > lowerWick;
    const lowerWickPct = (lowerWick / bodyAbs) * 100; // kept for logging only

    if (wickValid) {
      return { valid: true, direction: "bearish", wickPct: lowerWickPct, reason: `Valid bearish — body (${bodyAbs.toFixed(5)}) > lower wick (${lowerWick.toFixed(5)})` };
    }
    return { valid: false, direction: "bearish", wickPct: lowerWickPct, reason: `Invalid bearish — lower wick (${lowerWick.toFixed(5)}) >= body (${bodyAbs.toFixed(5)})` };
  }

  return { valid: false, direction: null, reason: "Doji / indecisive candle" };
}

/**
 * Counts consecutive valid candles of the SAME direction,
 * walking backward from the most recent CLOSED daily candle.
 * Stops counting the moment any candle is invalid OR flips
 * direction — per spec, invalid candles must never count
 * toward the 3-candle confirmation and reset the sequence.
 *
 * Returns { count, direction, yesterdayValid, yesterdayDirection }
 */
function countConsecutiveValidCandles(dfD1) {
  // dfD1[len-1] is today's still-forming candle (excluded);
  // dfD1[len-2] is "yesterday" — the most recent CLOSED candle.
  const len = dfD1.length;
  if (len < 3) return { count: 0, direction: null, yesterdayValid: false, yesterdayDirection: null };

  const yesterday = validateDailyCandle(dfD1[len - 2]);

  if (!yesterday.valid) {
    // Yesterday itself is invalid — sequence count is 0 regardless
    // of what came before (an invalid candle resets the count).
    return { count: 0, direction: null, yesterdayValid: false, yesterdayDirection: yesterday.direction, yesterdayReason: yesterday.reason };
  }

  // Walk backward counting consecutive valid candles of the SAME direction as yesterday
  let count = 0;
  const direction = yesterday.direction;
  for (let i = len - 2; i >= 0; i--) {
    const v = validateDailyCandle(dfD1[i]);
    if (v.valid && v.direction === direction) {
      count++;
    } else {
      break; // any invalid candle OR direction flip stops the count
    }
  }

  return { count, direction, yesterdayValid: true, yesterdayDirection: direction, yesterdayReason: yesterday.reason };
}

function computeDailyBias(dfD1) {
  if (!dfD1 || dfD1.length < 5) {
    return { bias: "none", reason: "Insufficient daily data (need at least 5 candles)" };
  }

  const seq = countConsecutiveValidCandles(dfD1);
  const htfTrend = getSimpleTrend(dfD1, 30); // "bullish" | "bearish" | "neutral" — majority of last 30 closed candles

  // ── Rule A check: yesterday valid + completes 3 consecutive ──
  const ruleA_bearish = seq.yesterdayValid && seq.yesterdayDirection === "bearish" && seq.count >= 3;
  const ruleA_bullish = seq.yesterdayValid && seq.yesterdayDirection === "bullish" && seq.count >= 3;

  // ── Rule B check: higher-timeframe trend ──
  const ruleB_bearish = htfTrend === "bearish";
  const ruleB_bullish = htfTrend === "bullish";

  // ── PRECEDENCE: Rule A (fresh 3-candle reversal) OVERRIDES Rule B
  // (broader HTF trend) whenever they conflict. A confirmed 3-candle
  // reversal is more current evidence than the older trend reading —
  // e.g. trend is bullish, but the last 3 daily candles are all valid
  // bearish -> bias flips to bearish. Same logic in reverse.

  // ── Rule A fired bearish: bias is bearish, regardless of Rule B ──
  if (ruleA_bearish) {
    const parts = [`Rule A: ${seq.count} consecutive valid bearish candles (overrides HTF trend if conflicting)`];
    if (ruleB_bearish) parts.push(`Rule B also agrees: more bearish than bullish candles in last 30`);
    else if (ruleB_bullish) parts.push(`NOTE: more bullish than bearish candles in last 30, but Rule A reversal takes precedence`);
    return { bias: "bearish", reason: `Bearish bias — ${parts.join(" + ")}` };
  }

  // ── Rule A fired bullish: bias is bullish, regardless of Rule B ──
  if (ruleA_bullish) {
    const parts = [`Rule A: ${seq.count} consecutive valid bullish candles (overrides HTF trend if conflicting)`];
    if (ruleB_bullish) parts.push(`Rule B also agrees: more bullish than bearish candles in last 30`);
    else if (ruleB_bearish) parts.push(`NOTE: more bearish than bullish candles in last 30, but Rule A reversal takes precedence`);
    return { bias: "bullish", reason: `Bullish bias — ${parts.join(" + ")}` };
  }

  // ── Rule A did NOT fire either direction — fall back to Rule B alone ──
  // GATE: Rule B only counts as a real bias if the LAST daily candle
  // (yesterday) is itself a VALID candle matching that trend direction.
  // e.g. trend is bullish (more bullish than bearish in last 30) but
  // yesterday's candle is invalid OR is a valid bearish candle -> Rule B
  // does NOT fire. This does not touch Rule A's override priority above
  // — only gates the fallback.
  if (ruleB_bearish) {
    if (seq.yesterdayValid && seq.yesterdayDirection === "bearish") {
      return { bias: "bearish", reason: `Bearish bias — Rule B: more bearish than bullish candles in last 30, confirmed by valid bearish daily candle` };
    }
    const why = !seq.yesterdayValid
      ? (seq.yesterdayReason || "yesterday's candle is invalid")
      : `yesterday's candle is valid but ${seq.yesterdayDirection}, not bearish — doesn't confirm the trend`;
    return { bias: "none", reason: `HOLD — Rule B trend is bearish but yesterday's candle doesn't confirm it (${why})` };
  }
  if (ruleB_bullish) {
    if (seq.yesterdayValid && seq.yesterdayDirection === "bullish") {
      return { bias: "bullish", reason: `Bullish bias — Rule B: more bullish than bearish candles in last 30, confirmed by valid bullish daily candle` };
    }
    const why = !seq.yesterdayValid
      ? (seq.yesterdayReason || "yesterday's candle is invalid")
      : `yesterday's candle is valid but ${seq.yesterdayDirection}, not bullish — doesn't confirm the trend`;
    return { bias: "none", reason: `HOLD — Rule B trend is bullish but yesterday's candle doesn't confirm it (${why})` };
  }

  // ── NEITHER RULE SATISFIED → HOLD ──
  const yReason = seq.yesterdayValid
    ? `yesterday valid ${seq.yesterdayDirection} but only ${seq.count} consecutive (need 3)`
    : (seq.yesterdayReason || "yesterday's candle is invalid");
  return { bias: "none", reason: `HOLD — Rule A failed (${yReason}), Rule B failed (HTF trend is ${htfTrend})` };
}


// ═══════════════════════════════════════════════════════
//  CANDLE PATTERN HELPERS (1H + 15M)
// ═══════════════════════════════════════════════════════

function isBullishEngulfing(c, prev) {
  if (!c || !prev) return false;
  return c.close > c.open && c.open < prev.close && c.close > prev.open &&
         candleBody(c) / candleRange(c) >= 0.5;
}
function isBearishEngulfing(c, prev) {
  if (!c || !prev) return false;
  return c.close < c.open && c.open > prev.close && c.close < prev.open &&
         candleBody(c) / candleRange(c) >= 0.5;
}
function isBullishMomentum(c) {
  if (!c) return false;
  const range = candleRange(c);
  return range > 0 && c.close > c.open && candleBody(c) / range >= 0.60;
}
function isBearishMomentum(c) {
  if (!c) return false;
  const range = candleRange(c);
  return range > 0 && c.close < c.open && candleBody(c) / range >= 0.60;
}
function hasLongLowerWick(c, minPct = 0.5) {
  if (!c) return false;
  const range = candleRange(c);
  if (range === 0) return false;
  return (Math.min(c.open, c.close) - c.low) / range >= minPct;
}
function hasLongUpperWick(c, minPct = 0.5) {
  if (!c) return false;
  const range = candleRange(c);
  if (range === 0) return false;
  return (c.high - Math.max(c.open, c.close)) / range >= minPct;
}
function isBullishRejection(c, prev) {
  return isBullishEngulfing(c, prev) || (hasLongLowerWick(c) && c.close > c.open);
}
function isBearishRejection(c, prev) {
  return isBearishEngulfing(c, prev) || (hasLongUpperWick(c) && c.close < c.open);
}
function hasBullishPullback(df, lookback = 8) {
  if (df.length < lookback + 2) return false;
  const slice  = df.slice(-lookback - 2, -1).map(c => c.close);
  return Math.min(...slice.slice(0, -1)) < slice[0];
}
function hasBearishPullback(df, lookback = 8) {
  if (df.length < lookback + 2) return false;
  const slice  = df.slice(-lookback - 2, -1).map(c => c.close);
  return Math.max(...slice.slice(0, -1)) > slice[0];
}
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


// ═══════════════════════════════════════════════════════
//  STAGE 2 — 1H CONFIRMATION → ENTRY MODE
//
//  NOT an entry trigger. Just grants permission to look
//  for a 15M entry. Checked every cycle while NOT already
//  in Entry Mode for this symbol+bias.
//
//  RULE (reset version): the most recent CLOSED 1H candle
//  must have BOTH its open AND its close beyond yesterday's
//  D1 level — above the D1 high for bullish, below the D1
//  low for bearish — i.e. the entire candle body sits past
//  the level, not just the close. It must also be a VALID
//  candle per validateDailyCandle (body > wick, matching
//  direction).
// ═══════════════════════════════════════════════════════

function check1hConfirmation(dailyBias, dfH1, dfD1) {
  if (!dfH1 || dfH1.length < 3) {
    return { confirmed: false, reason: "Insufficient 1H data" };
  }
  if (!dfD1 || dfD1.length < 2) {
    return { confirmed: false, reason: "Insufficient daily data for yesterday's high/low" };
  }

  // Most recent CLOSED 1H candle (dfH1[len-1] may still be forming).
  const len  = dfH1.length;
  const last = dfH1[len - 2];

  // "Yesterday" = the most recent CLOSED daily candle — same
  // dfD1[len-2] convention used by Stage 1 (countConsecutiveValidCandles).
  const yesterday = dfD1[dfD1.length - 2];
  const yesterdayHigh = yesterday.high;
  const yesterdayLow  = yesterday.low;

  if (dailyBias === "bullish") {
    const openAbove  = last.open  > yesterdayHigh;
    const closeAbove = last.close > yesterdayHigh;
    if (!openAbove || !closeAbove) {
      return { confirmed: false, reason: `Waiting — 1H candle (open ${last.open.toFixed(5)}, close ${last.close.toFixed(5)}) has not fully opened+closed above yesterday's high (${yesterdayHigh.toFixed(5)})` };
    }

    const shape = validateDailyCandle(last);
    if (!shape.valid || shape.direction !== "bullish") {
      return { confirmed: false, reason: `1H open+close above yesterday's high (${yesterdayHigh.toFixed(5)}) but candle shape invalid — ${shape.reason}` };
    }

    return { confirmed: true, h1Epoch: last.epoch, reason: `1H candle opened (${last.open.toFixed(5)}) AND closed (${last.close.toFixed(5)}) above yesterday's high (${yesterdayHigh.toFixed(5)}) AND ${shape.reason}` };
  }

  if (dailyBias === "bearish") {
    const openBelow  = last.open  < yesterdayLow;
    const closeBelow = last.close < yesterdayLow;
    if (!openBelow || !closeBelow) {
      return { confirmed: false, reason: `Waiting — 1H candle (open ${last.open.toFixed(5)}, close ${last.close.toFixed(5)}) has not fully opened+closed below yesterday's low (${yesterdayLow.toFixed(5)})` };
    }

    const shape = validateDailyCandle(last);
    if (!shape.valid || shape.direction !== "bearish") {
      return { confirmed: false, reason: `1H open+close below yesterday's low (${yesterdayLow.toFixed(5)}) but candle shape invalid — ${shape.reason}` };
    }

    return { confirmed: true, h1Epoch: last.epoch, reason: `1H candle opened (${last.open.toFixed(5)}) AND closed (${last.close.toFixed(5)}) below yesterday's low (${yesterdayLow.toFixed(5)}) AND ${shape.reason}` };
  }

  return { confirmed: false, reason: "No daily bias" };
}


// ═══════════════════════════════════════════════════════
//  STAGE 3 — 15M ENTRY
//
//  Only evaluated while in Entry Mode. Looks INSIDE the
//  specific 1H candle that Stage 2 just confirmed against
//  (identified by state.entryModeH1Epoch) — i.e. the 4
//  fifteen-minute candles that make up that H1 bar.
//
//  RULE (reset version): among those 4 fifteen-minute
//  candles, ANY 3 CONSECUTIVE candles (candles 1-2-3 OR
//  2-3-4) must each be:
//    - a VALID candle per validateDailyCandle (body > wick),
//      matching the daily bias direction, AND
//    - both its open AND close beyond the SAME D1 level
//      Stage 2 confirmed against (D1 high for bullish, D1
//      low for bearish).
//
//  Per spec: the bot does NOT enter immediately once the
//  pattern is found — it enters at the OPEN of the NEXT 15M
//  candle. So this function flags "pendingEntry" once the
//  pattern is confirmed, and the actual BUY/SELL signal
//  fires one cycle later once a new 15M candle has opened.
// ═══════════════════════════════════════════════════════

function check15mEntry(dailyBias, dfM15, dfD1, state) {
  if (!dfM15 || dfM15.length < 3) {
    return { signal: SIG_HOLD, reason: "Insufficient 15M data" };
  }
  if (!dfD1 || dfD1.length < 2) {
    return { signal: SIG_HOLD, reason: "Insufficient daily data for daily high/low" };
  }
  if (!state.entryModeH1Epoch) {
    return { signal: SIG_HOLD, reason: "No confirmed H1 bar recorded for entry mode" };
  }

  const len        = dfM15.length;
  const lastClosed = dfM15[len - 2]; // most recent fully closed 15M candle

  // ── If we have a pending entry from a PRIOR cycle, check if
  //    a NEW 15M candle has opened since the pattern confirmed.
  //    If so, fire the trade now (entering at this new candle's open).
  if (state.pendingEntry) {
    const signalEpoch = state.pendingEntry.signalEpoch;
    if (lastClosed.epoch > signalEpoch) {
      const direction = state.pendingEntry.direction;
      state.pendingEntry = null; // consume it — one-shot entry
      return {
        signal: direction === "buy" ? SIG_BUY : SIG_SELL,
        reason: `Entering at open of next 15M candle after 3-consecutive-valid pattern confirmed`,
      };
    }
    return { signal: SIG_HOLD, reason: "Pattern confirmed — waiting for next 15M candle to open for entry" };
  }

  if (dailyBias !== "bullish" && dailyBias !== "bearish") {
    return { signal: SIG_HOLD, reason: "No daily bias" };
  }

  // ── Gather the 4 fifteen-minute candles that formed the ──
  // ── confirming H1 bar (epoch window [h1Epoch, h1Epoch+3600)) ──
  const h1Epoch = state.entryModeH1Epoch;
  const barCandles = dfM15
    .filter(c => c.epoch >= h1Epoch && c.epoch < h1Epoch + 3600)
    .sort((a, b) => a.epoch - b.epoch);

  if (barCandles.length < 4) {
    return { signal: SIG_HOLD, reason: `Waiting for all 4 fifteen-minute candles of the confirming H1 bar (have ${barCandles.length}/4)` };
  }
  const bar = barCandles.slice(0, 4);

  // Same D1 level Stage 2 confirmed against.
  const yesterday = dfD1[dfD1.length - 2];
  const level = dailyBias === "bullish" ? yesterday.high : yesterday.low;
  const wantDirection = dailyBias; // "bullish" | "bearish"

  function qualifies(c) {
    const shape = validateDailyCandle(c);
    if (!shape.valid || shape.direction !== wantDirection) return false;
    return wantDirection === "bullish"
      ? (c.open > level && c.close > level)
      : (c.open < level && c.close < level);
  }

  const flags = bar.map(qualifies);
  const window123 = flags[0] && flags[1] && flags[2];
  const window234 = flags[1] && flags[2] && flags[3];

  if (!window123 && !window234) {
    return { signal: SIG_HOLD, reason: `No 3 consecutive valid ${wantDirection} 15M candles (open+close beyond ${level.toFixed(5)}) inside the confirming H1 bar` };
  }

  const which = window123 && window234 ? "candles 1-2-3 and 2-3-4" : (window123 ? "candles 1-2-3" : "candles 2-3-4");
  const direction = dailyBias === "bullish" ? "buy" : "sell";
  state.pendingEntry = { direction, signalEpoch: bar[3].epoch };
  return { signal: SIG_HOLD, reason: `3 consecutive valid ${wantDirection} 15M candles found (${which}) inside H1 bar — entry queued for next 15M candle open` };
}


// ═══════════════════════════════════════════════════════
//  MAIN SIGNAL FUNCTION — full 4-stage state machine
//  tf = { d1, h1, m15, symbol }
// ═══════════════════════════════════════════════════════

export function collectSignals(tf) {
  const { d1, h1, m15, symbol } = tf;
  const state = getState(symbol || "default");
  const breakdown = [];

  // ── STAGE 1: DAILY BIAS — computed ONCE per trading day ──
  const today = todayKey();
  if (state.dailyBiasDate !== today) {
    const result = computeDailyBias(d1);
    state.dailyBiasDate = today;
    state.dailyBias      = result.bias;
    state.dailyBiasMeta  = result.reason;
    // New trading day — reset entry mode / pending entry from yesterday
    state.entryMode      = false;
    state.entryModeReason = "";
    state.entryModeH1Epoch = null;
    state.pendingEntry    = null;
  }

  breakdown.push({ step: "Stage1 DailyBias", result: state.dailyBias.toUpperCase(), reason: state.dailyBiasMeta });

  if (state.dailyBias === "none") {
    return { signal: SIG_HOLD, breakdown, reason: `NO TRADE TODAY — ${state.dailyBiasMeta}`, dailyBias: "none" };
  }

  // ── SESSION GATE (FX/Metals only) ──
  // Daily bias (Stage 1/2) is computed regardless of time of day —
  // it only depends on the daily candle. But Stage 3 (1H confirm)
  // and Stage 4 (15M entry) only run for FX/Metals during London,
  // New York, or the overlap. Synthetics/crypto are unaffected
  // (isInTradingSession returns true 24/7 for them).
  if (!isInTradingSession(symbol)) {
    breakdown.push({ step: "Stage2 1H Confirm", result: "OUTSIDE SESSION", reason: `${symbol} — waiting for London/NY session (FX only)` });
    return { signal: SIG_HOLD, breakdown, reason: "Outside London/NY trading session — bias held for next session", dailyBias: state.dailyBias };
  }

  // ── STAGE 2: 1H CONFIRMATION → ENTRY MODE ──
  if (!state.entryMode) {
    const confirmation = check1hConfirmation(state.dailyBias, h1, d1);
    breakdown.push({ step: "Stage2 1H Confirm", result: confirmation.confirmed ? "ENTRY MODE" : "WAITING", reason: confirmation.reason });

    if (!confirmation.confirmed) {
      return { signal: SIG_HOLD, breakdown, reason: `WAITING — ${confirmation.reason}`, dailyBias: state.dailyBias };
    }

    state.entryMode = true;
    state.entryModeReason = confirmation.reason;
    state.entryModeH1Epoch = confirmation.h1Epoch;
  } else {
    breakdown.push({ step: "Stage2 1H Confirm", result: "ENTRY MODE (active)", reason: state.entryModeReason });
  }

  // ── STAGE 3: 15M ENTRY ──
  const entry = check15mEntry(state.dailyBias, m15, d1, state);
  breakdown.push({
    step: "Stage3 15M Entry",
    result: entry.signal === SIG_HOLD ? "WAIT" : (entry.signal === SIG_BUY ? "BUY" : "SELL"),
    reason: entry.reason,
  });

  // If a trade actually fires, exit Entry Mode (symbol gets locked
  // by the trade-lock system anyway, and tomorrow starts fresh)
  if (entry.signal !== SIG_HOLD) {
    state.entryMode = false;
  }

  return {
    signal: entry.signal,
    breakdown,
    reason: entry.reason,
    dailyBias: state.dailyBias,
  };
}

export function getTradeReason(tf) {
  const result = collectSignals(tf);
  const direction = result.signal === SIG_BUY ? "BUY" : result.signal === SIG_SELL ? "SELL" : "HOLD/WAIT";

  const lines = [
    `DAILY BIAS STRATEGY (4-Stage) — ${direction}`,
    `  Session   : ${sessionName()}`,
    `  Daily Bias: ${(result.dailyBias || "none").toUpperCase()}`,
    `  ──────────────────────────────`,
  ];

  for (const step of result.breakdown) {
    const icon = ["BULLISH","AGREES","ENTRY MODE","BUY"].some(s => step.result.includes(s)) ? "🟢"
      : ["BEARISH","SELL"].some(s => step.result.includes(s)) ? "🔴"
      : "⬜";
    lines.push(`  ${icon} ${step.step.padEnd(20)}: ${step.result}`);
    lines.push(`     ${step.reason}`);
  }

  lines.push(`  ──────────────────────────────`);
  lines.push(`  Decision  : ${direction}`);

  return lines.join("\n");
}


// ═══════════════════════════════════════════════════════
//  LEGACY COMPATIBILITY EXPORTS
// ═══════════════════════════════════════════════════════

export function getLatestSignalMtf(dfM15, dfH1, dfD1, symbol) {
  return collectSignals({ d1: dfD1, h1: dfH1, m15: dfM15, symbol }).signal;
}

export function get15mTrend(dfD1) {
  const result = computeDailyBias(dfD1);
  if (result.bias === "bullish") return "bullish";
  if (result.bias === "bearish") return "bearish";
  return "neutral";
}