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
//           Does NOT enter on the H1 close. Defines a ZONE
//           from the confirming H1 candle's own high/low,
//           then watches subsequent 15M candles for a
//           retracement (opposite-direction candle trading
//           inside the zone) followed by a valid engulfing
//           candle that closes beyond the zone in the bias
//           direction. Enters immediately when that engulfing
//           candle closes (no next-candle delay). Also covers
//           immediate continuation with no retracement at all,
//           since the engulf reference starts as the H1 bar's
//           own last 15M candle.
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
//    - dailyBiasEpoch: the epoch of the most recently CLOSED
//      D1 candle this bias was computed against. Stage 1 is
//      re-evaluated whenever this changes — i.e. driven by
//      the actual arrival of a new closed daily candle in the
//      data, NOT by the wall-clock calendar date. (Keying off
//      wall-clock date used to let the bias get "stuck" if the
//      process's view of "today" ever drifted from when a new
//      daily candle genuinely closed — e.g. cache staleness —
//      and it would then stay stuck until the process/state
//      was restarted, since nothing else would ever trigger a
//      recompute.)
//    - dailyBias: "bullish" | "bearish" | "none"
//    - entryMode: false until 1H confirms, then true
//    - entryModeH1Epoch/H1High/H1Low: identifies the
//      confirming H1 candle and defines the "zone" (its own
//      high/low) that Stage 3 watches for a break.
//    - pulledBack: true once a 15M candle has closed back
//      inside the H1 confirmation zone since Entry Mode
//      started — purely informational for the wait-reason
//      text; entry itself only needs a valid candle to close
//      beyond the zone, whether or not a pullback happened.
//    - m15ScanEpoch: epoch of the most recent 15M candle
//      Stage 3 has already scanned, so each closed candle is
//      only evaluated once across scan cycles.
// ═══════════════════════════════════════════════════════

const symbolState = new Map();

function getState(symbol) {
  if (!symbolState.has(symbol)) {
    symbolState.set(symbol, {
      dailyBiasEpoch: null,
      dailyBias:     "none",
      dailyBiasMeta: null,
      entryMode:     false,
      entryModeReason: "",
      entryModeH1Epoch: null, // epoch of the H1 candle Stage 2 confirmed against
      entryModeH1High:  null, // that H1 candle's own high — top of the "zone"
      entryModeH1Low:   null, // that H1 candle's own low — bottom of the "zone"
      pulledBack:       false, // has price closed back inside the zone since Entry Mode started?
      m15ScanEpoch:     null, // epoch of the last 15M candle already scanned
      lastM15Epoch:  null,
      // NEW — 15M entry window + retracement gate:
      m15EntryAttempts:    0,     // how many 15M candles have had a chance to trigger entry since this zone started (max 2)
      awaitingRetracement: false, // true after a zone is abandoned (2 attempts used, no entry) — blocks Stage 2 from re-arming until an H1 candle closes back inside yesterday's D1 range
    });
  }
  return symbolState.get(symbol);
}

export function resetSymbolState(symbol) {
  symbolState.delete(symbol);
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

// Trend-STRENGTH classifier (trending vs. ranging), distinct from
// getSimpleTrend() above which only answers direction (bullish/
// bearish/neutral). Uses Kaufman's Efficiency Ratio: net
// displacement across the window divided by the sum of every
// candle-to-candle move. Used by src/strategy/confluence-votes.js
// as the "trend strength" vote — not called anywhere else in this
// file, and nothing in collectSignals() below is affected by it.
export function classifyD1Regime(d1Window, { lookback = 30, excludeForming = true, trendThreshold = 0.15 } = {}) {
  if (!d1Window || d1Window.length < 3) return { trending: false, agreeRatio: 0 };

  let candles = excludeForming ? d1Window.slice(0, -1) : d1Window;
  if (lookback && candles.length > lookback) candles = candles.slice(-lookback);
  if (candles.length < 3) return { trending: false, agreeRatio: 0 };

  const netMove = Math.abs(candles[candles.length - 1].close - candles[0].close);
  let sumMoves = 0;
  for (let i = 1; i < candles.length; i++) {
    sumMoves += Math.abs(candles[i].close - candles[i - 1].close);
  }
  const agreeRatio = sumMoves > 0 ? netMove / sumMoves : 0;
  return { trending: agreeRatio >= trendThreshold, agreeRatio: +agreeRatio.toFixed(4) };
}

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

// ═══════════════════════════════════════════════════════
//  RETRACEMENT GATE — used after a 15M entry window is
//  abandoned (see check15mEntry's 2-attempt cap below).
//
//  Once abandoned, Stage 2 will NOT re-arm on just any later
//  H1 breakout — it first requires a CLOSED H1 candle to close
//  fully back inside yesterday's D1 high/low (the same daily
//  level Stage 2's breakout check uses). Only after that's
//  observed does the normal check1hConfirmation() get run
//  again, watching for a fresh breakout.
// ═══════════════════════════════════════════════════════
function checkRetracementIntoDailyZone(dfH1, dfD1) {
  if (!dfH1 || dfH1.length < 2) return { retraced: false, reason: "Insufficient 1H data" };
  if (!dfD1 || dfD1.length < 2) return { retraced: false, reason: "Insufficient daily data" };

  const last = dfH1[dfH1.length - 2]; // most recent CLOSED 1H candle
  const yesterday = dfD1[dfD1.length - 2];
  const yesterdayHigh = yesterday.high;
  const yesterdayLow  = yesterday.low;

  const closedInside = last.close <= yesterdayHigh && last.close >= yesterdayLow;
  if (closedInside) {
    return { retraced: true, reason: `1H candle closed at ${last.close.toFixed(5)} — back inside yesterday's range (${yesterdayLow.toFixed(5)} - ${yesterdayHigh.toFixed(5)})` };
  }
  return { retraced: false, reason: `Waiting for an 1H candle to close back inside yesterday's range (${yesterdayLow.toFixed(5)} - ${yesterdayHigh.toFixed(5)}) — most recent closed at ${last.close.toFixed(5)}` };
}

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

    return { confirmed: true, h1Epoch: last.epoch, h1High: last.high, h1Low: last.low, reason: `1H candle opened (${last.open.toFixed(5)}) AND closed (${last.close.toFixed(5)}) above yesterday's high (${yesterdayHigh.toFixed(5)}) AND ${shape.reason}` };
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

    return { confirmed: true, h1Epoch: last.epoch, h1High: last.high, h1Low: last.low, reason: `1H candle opened (${last.open.toFixed(5)}) AND closed (${last.close.toFixed(5)}) below yesterday's low (${yesterdayLow.toFixed(5)}) AND ${shape.reason}` };
  }

  return { confirmed: false, reason: "No daily bias" };
}


// ═══════════════════════════════════════════════════════
//  STAGE 3 — 15M ENTRY (reset v2: retracement + engulfing)
//
//  Only evaluated while in Entry Mode. Does NOT enter when
//  the H1 confirmation candle closes.
//
//  ZONE = [H1 confirmation candle's low, H1 confirmation
//          candle's high] — i.e. that candle's own range,
//          NOT the D1 level.
//
//  Starting from the 15M candle that opens right after the
//  H1 confirmation candle closes, scan forward candle by
//  candle, one time each:
//
//  - A "reference candle" is what the next entry candle must
//    engulf. It starts as the LAST (4th) 15M candle of the
//    confirming H1 bar.
//  - Any 15M candle that trades INSIDE the zone AND whose own
//    direction is OPPOSITE the daily bias becomes the NEW
//    reference candle (keeps updating to the most recent one
//    — this is the "retracement").
//  - On every scanned candle, check if THIS candle is the
//    entry trigger:
//      - passes validateDailyCandle (body > wick), matching
//        the daily bias direction
//      - its body fully ENGULFS the reference candle's body
//      - its CLOSE is beyond the zone (above zone high for
//        bullish, below zone low for bearish)
//    If all three hold, ENTER IMMEDIATELY on that candle's
//    close (no next-candle delay). This naturally covers both
//    "retrace then reverse" (reference = a real pullback
//    candle) AND "immediate continuation, no retrace at all"
//    (reference is still the H1 bar's own last candle).
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
//  STAGE 3: 15M ENTRY
//
//  The "zone" is the confirming H1 candle's own high/low.
//  Scanning starts from the first 15M candle that OPENS
//  after that H1 candle CLOSES (h1Epoch + 3600) — the H1
//  bar's own 15M sub-candles are not evaluated.
//
//  For each new closed 15M candle, in order:
//    - If it's a valid candle (per the Stage 1 body/wick
//      test) in the daily-bias direction, AND it closes
//      beyond the zone (above zoneHigh for bullish, below
//      zoneLow for bearish) → ENTER IMMEDIATELY. This covers
//      both a straight continuation (the very first candle
//      after H1 close already breaks out) and a pullback
//      that later resolves in the bias direction.
//    - If instead it closes back INSIDE the zone, that's a
//      pullback/retracement — no entry, just keep watching.
//      We remember that a pullback happened (state.pulledBack)
//      purely so the "waiting" reason is accurate; it doesn't
//      gate the entry check above in either direction.
//    - Anything else (e.g. closes beyond the zone but isn't a
//      valid/clean candle) is also just a "keep waiting".
// ═══════════════════════════════════════════════════════

function check15mEntry(dailyBias, dfM15, dfD1, state) {
  if (!dfM15 || dfM15.length < 3) {
    return { signal: SIG_HOLD, reason: "Insufficient 15M data" };
  }
  if (!state.entryModeH1Epoch) {
    return { signal: SIG_HOLD, reason: "No confirmed H1 bar recorded for entry mode" };
  }
  if (dailyBias !== "bullish" && dailyBias !== "bearish") {
    return { signal: SIG_HOLD, reason: "No daily bias" };
  }

  const zoneHigh = state.entryModeH1High;
  const zoneLow  = state.entryModeH1Low;
  const h1Epoch  = state.entryModeH1Epoch;

  // First time Stage 3 runs for this H1 confirmation: start scanning
  // from the first 15M candle that opens after the H1 bar closes.
  if (state.m15ScanEpoch === null) {
    state.m15ScanEpoch = h1Epoch + 3600 - 1;
  }

  // ── Gather CLOSED 15M candles we haven't scanned yet, in order ──
  const len             = dfM15.length;
  const lastClosedEpoch = dfM15[len - 2].epoch; // dfM15[len-1] may still be forming
  const toScan = dfM15
    .filter(c => c.epoch > state.m15ScanEpoch && c.epoch <= lastClosedEpoch)
    .sort((a, b) => a.epoch - b.epoch);

  const waitingReason = () => state.pulledBack
    ? `Pulled back inside the H1 confirmation zone (${zoneLow.toFixed(5)} - ${zoneHigh.toFixed(5)}) — waiting for a valid ${dailyBias} candle to close back beyond it (attempt ${state.m15EntryAttempts}/2)`
    : `Watching for a valid ${dailyBias} candle to close beyond the H1 confirmation zone (${zoneLow.toFixed(5)} - ${zoneHigh.toFixed(5)}) (attempt ${state.m15EntryAttempts}/2)`;

  if (toScan.length === 0) {
    return { signal: SIG_HOLD, reason: waitingReason() };
  }

  for (const c of toScan) {
    state.m15ScanEpoch = c.epoch; // mark processed regardless of outcome
    state.m15EntryAttempts++;      // this candle is attempt #1 or #2 (or later, if already abandoned once this call — but abandonment returns immediately below, so a fresh call never sees >2)

    const shape            = validateDailyCandle(c);
    const shapeOk           = shape.valid && shape.direction === dailyBias;
    const closesBeyondZone  = dailyBias === "bullish" ? c.close > zoneHigh : c.close < zoneLow;

    if (shapeOk && closesBeyondZone) {
      const direction = dailyBias === "bullish" ? "buy" : "sell";
      return {
        signal: direction === "buy" ? SIG_BUY : SIG_SELL,
        reason: `Valid ${dailyBias} candle closed ${dailyBias === "bullish" ? "above" : "below"} the H1 confirmation zone (${zoneLow.toFixed(5)} - ${zoneHigh.toFixed(5)}) on attempt ${state.m15EntryAttempts}/2 — entering now`,
      };
    }

    // Pullback: candle closed back inside the zone. Not an entry —
    // just remember it happened so the wait-reason reflects it.
    const closesInsideZone = c.close >= zoneLow && c.close <= zoneHigh;
    if (closesInsideZone) {
      state.pulledBack = true;
    }

    // NEW — 2-attempt cap: only the 1st and 2nd 15M candles after the
    // H1 breakout get a chance to trigger entry. If this was attempt
    // #2 and it didn't fire, abandon this zone entirely rather than
    // keep watching indefinitely. collectSignals() reacts to
    // `abandoned: true` by resetting entry mode and requiring price
    // to retrace back inside yesterday's D1 range before Stage 2 is
    // allowed to re-arm (see checkRetracementIntoDailyZone above).
    if (state.m15EntryAttempts >= 2) {
      return {
        signal: SIG_HOLD,
        abandoned: true,
        reason: `Neither the 1st nor 2nd 15M candle after the H1 breakout closed beyond the zone (${zoneLow.toFixed(5)} - ${zoneHigh.toFixed(5)}) — abandoning this setup. Waiting for price to retrace back inside yesterday's daily range before watching for a fresh breakout.`,
      };
    }
  }

  return { signal: SIG_HOLD, reason: waitingReason() };
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
  // Driven by the actual data: recompute whenever the most recently
  // CLOSED D1 candle's epoch changes (i.e. a genuinely new daily
  // candle has appeared), not by comparing wall-clock calendar dates.
  // This is what "yesterday's candle" means in Stage 1 — the epoch
  // IS the identity of that candle, so as long as we've already
  // computed bias against this exact candle, there's nothing new to
  // do; the moment d1 rolls forward to a new closed candle, we know
  // for certain (from the data itself) that it's time to recompute.
  const latestClosedD1Epoch = (d1 && d1.length >= 2) ? d1[d1.length - 2].epoch : null;

  if (latestClosedD1Epoch !== null && state.dailyBiasEpoch !== latestClosedD1Epoch) {
    const result = computeDailyBias(d1);
    state.dailyBiasEpoch = latestClosedD1Epoch;
    state.dailyBias      = result.bias;
    state.dailyBiasMeta  = result.reason;
    // New trading day — reset entry mode / pending entry from yesterday
    state.entryMode      = false;
    state.entryModeReason = "";
    state.entryModeH1Epoch = null;
    state.entryModeH1High  = null;
    state.entryModeH1Low   = null;
    state.pulledBack        = false;
    state.m15ScanEpoch      = null;
    state.m15EntryAttempts    = 0;
    state.awaitingRetracement = false;
  } else if (latestClosedD1Epoch === null && state.dailyBiasEpoch === null) {
    // No usable D1 data yet at all — fall through to the
    // "insufficient data" branch of computeDailyBias below.
    const result = computeDailyBias(d1);
    state.dailyBias     = result.bias;
    state.dailyBiasMeta = result.reason;
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
    // NEW — if the previous zone was abandoned (2 attempts used, no
    // entry), Stage 2 will NOT re-arm on just any later breakout. It
    // first requires a closed 1H candle to retrace fully back inside
    // yesterday's D1 range. Only once that's observed does the
    // normal breakout check below run again.
    if (state.awaitingRetracement) {
      const retracement = checkRetracementIntoDailyZone(h1, d1);
      breakdown.push({ step: "Stage2 Retracement Gate", result: retracement.retraced ? "RETRACED" : "WAITING", reason: retracement.reason });
      if (!retracement.retraced) {
        return { signal: SIG_HOLD, breakdown, reason: `WAITING — ${retracement.reason}`, dailyBias: state.dailyBias };
      }
      // Retracement confirmed — clear the gate and fall through to
      // the normal breakout check in this same cycle. Safe to do in
      // one pass: a candle closing inside the zone (retracement) and
      // closing beyond it (breakout) are mutually exclusive for the
      // same candle, so this can't accidentally double-count one bar.
      state.awaitingRetracement = false;
    }

    const confirmation = check1hConfirmation(state.dailyBias, h1, d1);
    breakdown.push({ step: "Stage2 1H Confirm", result: confirmation.confirmed ? "ENTRY MODE" : "WAITING", reason: confirmation.reason });

    if (!confirmation.confirmed) {
      return { signal: SIG_HOLD, breakdown, reason: `WAITING — ${confirmation.reason}`, dailyBias: state.dailyBias };
    }

    state.entryMode = true;
    state.entryModeReason = confirmation.reason;
    state.entryModeH1Epoch = confirmation.h1Epoch;
    state.entryModeH1High  = confirmation.h1High;
    state.entryModeH1Low   = confirmation.h1Low;
    state.pulledBack        = false; // Stage 3 restarts scanning fresh
    state.m15ScanEpoch      = null;
    state.m15EntryAttempts  = 0; // NEW — fresh zone, fresh 2-attempt window
  } else {
    breakdown.push({ step: "Stage2 1H Confirm", result: "ENTRY MODE (active)", reason: state.entryModeReason });
  }

  // ── STAGE 3: 15M ENTRY ──
  const entry = check15mEntry(state.dailyBias, m15, d1, state);
  breakdown.push({
    step: "Stage3 15M Entry",
    result: entry.signal === SIG_HOLD ? (entry.abandoned ? "ABANDONED" : "WAIT") : (entry.signal === SIG_BUY ? "BUY" : "SELL"),
    reason: entry.reason,
  });

  // NEW — 2-attempt window used up with no entry: reset entry mode
  // entirely and require a retracement into yesterday's D1 range
  // before Stage 2 will look for a fresh breakout (see above).
  if (entry.abandoned) {
    state.entryMode         = false;
    state.entryModeReason   = "";
    state.entryModeH1Epoch  = null;
    state.entryModeH1High   = null;
    state.entryModeH1Low    = null;
    state.pulledBack        = false;
    state.m15ScanEpoch      = null;
    state.m15EntryAttempts  = 0;
    state.awaitingRetracement = true;
    return { signal: SIG_HOLD, breakdown, reason: entry.reason, dailyBias: state.dailyBias };
  }

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