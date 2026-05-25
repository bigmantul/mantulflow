// ═══════════════════════════════════════════════════════
//  src/strategy/signals.js
//
//  Smart Money Concepts (SMC) Strategy Engine
//  ── REWRITTEN per new rules ──
//
//  RULES:
//  1. HTF BIAS (4H) — NON-NEGOTIABLE
//     · Bullish HTF → only BUY signals
//     · Bearish HTF → only SELL signals
//     · Neutral HTF → NO TRADE (immediate skip)
//
//  2. MARKET STRUCTURE — HARD REQUIREMENT
//     · Must have BOS OR liquidity sweep on 15m
//     · If BOTH are "none" → immediate reject, no trade
//
//  3. VOTE THRESHOLD
//     · Minimum 6 out of 7 votes required
//     · Votes: BOS, Sweep, Order Block, 5m Confirm,
//              EMA, RSI, Volume
//
//  Timeframe stack:
//    4H  → HTF bias (direction filter)
//    15m → Entry: BOS, sweep, OB, EMA, RSI, Volume
//    5m  → Execution: confirmation candle
// ═══════════════════════════════════════════════════════

const MIN_BARS_5M  = 60;
const MIN_BARS_15M = 60;
const MIN_BARS_4H  = 50;

const LONDON_START   = 7;
const LONDON_END     = 16;
const NEW_YORK_START = 12;
const NEW_YORK_END   = 21;


// ═══════════════════════════════════════════════════════
//  MARKET HOURS
// ═══════════════════════════════════════════════════════
const MARKET_SCHEDULE = {
  R_10:      "24/7",
  R_25:      "24/7",
  R_50:      "24/7",
  R_75:      "24/7",
  R_100:     "24/7",
  frxXAUUSD: "forex",
  frxXAGUSD: "forex",
  cryBTCUSD: "24/7",
  cryETHUSD: "24/7",
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


// ═══════════════════════════════════════════════════════
//  SESSION
// ═══════════════════════════════════════════════════════
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
//  (replaces pandas/ta — pure JS, no dependencies)
// ═══════════════════════════════════════════════════════

function ema(values, period) {
  const result = new Array(values.length).fill(null);
  const k      = 2 / (period + 1);
  const start  = period - 1;
  result[start] = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = start + 1; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

function rsi(values, period = 14) {
  const result = new Array(values.length).fill(null);
  if (values.length < period + 1) return result;

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains  += diff;
    else           losses -= diff;
  }

  let avgGain = gains  / period;
  let avgLoss = losses / period;
  result[period] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-10));

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    result[i] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-10));
  }
  return result;
}

function atr(df, period = 14) {
  const trValues = [];
  for (let i = 1; i < df.length; i++) {
    trValues.push(Math.max(
      df[i].high - df[i].low,
      Math.abs(df[i].high - df[i - 1].close),
      Math.abs(df[i].low  - df[i - 1].close)
    ));
  }
  const atrVals = new Array(trValues.length).fill(null);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trValues[i];
  atrVals[period - 1] = sum / period;
  for (let i = period; i < trValues.length; i++) {
    atrVals[i] = (atrVals[i - 1] * (period - 1) + trValues[i]) / period;
  }
  return atrVals;
}

function clip(value, min, max) {
  return Math.max(min, Math.min(max, value));
}


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
  if (pct < 0.0003) return false;
  if (pct > 0.05)   return false;
  return true;
}

export function getVolatilityScalar(df) {
  const scalar = 0.003 / Math.max(getAtrPct(df), 0.0001);
  return parseFloat(clip(scalar, 0.25, 1.0).toFixed(4));
}


// ═══════════════════════════════════════════════════════
//  SWING POINTS
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


// ═══════════════════════════════════════════════════════
//  RULE 1 — HTF BIAS (4H) — NON-NEGOTIABLE
//  Neutral = no trade, period.
// ═══════════════════════════════════════════════════════

function getHtfBias(df4h) {
  if (!df4h || df4h.length < MIN_BARS_4H) return "neutral";

  const { highs, lows } = getSwingPoints(df4h, 3);
  if (highs.length < 2 || lows.length < 2) return "neutral";

  const hh = highs[highs.length - 1][1] > highs[highs.length - 2][1];
  const hl = lows[lows.length - 1][1]   > lows[lows.length - 2][1];
  const lh = highs[highs.length - 1][1] < highs[highs.length - 2][1];
  const ll = lows[lows.length - 1][1]   < lows[lows.length - 2][1];

  if (hh && hl) return "bullish";
  if (lh && ll) return "bearish";
  return "neutral";
}


// ═══════════════════════════════════════════════════════
//  RULE 2 — MARKET STRUCTURE (HARD REQUIREMENT)
//  Must have BOS OR sweep — if both "none" → reject
// ═══════════════════════════════════════════════════════

// VOTE 1 — Break of Structure (15m)
function detectBos(df) {
  if (df.length < 30) return "none";
  const { highs, lows } = getSwingPoints(df, 5);
  if (!highs.length || !lows.length) return "none";
  const close = df[df.length - 2].close;
  if (close > highs[highs.length - 1][1]) return "bullish";
  if (close < lows[lows.length - 1][1])   return "bearish";
  return "none";
}

// VOTE 2 — Liquidity Sweep (15m)
function detectLiquiditySweep(df) {
  if (df.length < 20) return "none";
  const { highs, lows } = getSwingPoints(df, 5);
  if (!highs.length || !lows.length) return "none";
  const candle = df[df.length - 2];
  if (candle.low  < lows[lows.length - 1][1]   && candle.close > lows[lows.length - 1][1])   return "bullish_sweep";
  if (candle.high > highs[highs.length - 1][1]  && candle.close < highs[highs.length - 1][1]) return "bearish_sweep";
  return "none";
}


// ═══════════════════════════════════════════════════════
//  VOTE 3 — ORDER BLOCK (15m)
// ═══════════════════════════════════════════════════════

function findOrderBlocks(df, atrVal) {
  const obs = [];
  if (df.length < 30) return obs;
  for (let i = 5; i < df.length - 5; i++) {
    const c        = df[i];
    const nextMove = df[i + 3].close - df[i].close;
    if (c.close < c.open && nextMove >  atrVal * 1.5) obs.push({ type: "bullish", high: c.high, low: c.low, mid: (c.high + c.low) / 2, index: i, valid: true });
    if (c.close > c.open && nextMove < -atrVal * 1.5) obs.push({ type: "bearish", high: c.high, low: c.low, mid: (c.high + c.low) / 2, index: i, valid: true });
  }
  return obs;
}

function getNearestValidOb(df, direction, atrVal) {
  const price = df[df.length - 2].close;
  const candidates = findOrderBlocks(df, atrVal)
    .filter(ob => {
      if (ob.type !== direction || !ob.valid) return false;
      if (direction === "bullish") {
        if (price < ob.low - 1.5 * atrVal) return false;
        const dist = price - ob.low;
        return dist >= -0.2 * atrVal && dist <= 0.7 * atrVal;
      } else {
        if (price > ob.high + 1.5 * atrVal) return false;
        const dist = ob.high - price;
        return dist >= -0.2 * atrVal && dist <= 0.7 * atrVal;
      }
    });
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => a.index > b.index ? a : b);
}

function obNearSR(ob, df, atrVal) {
  if (!ob) return false;
  const { highs, lows } = getSwingPoints(df, 10);
  return [...highs.map(h => h[1]), ...lows.map(l => l[1])]
    .some(level => Math.abs(ob.mid - level) < atrVal * 0.5);
}


// ═══════════════════════════════════════════════════════
//  VOTE 4 — CONFIRMATION CANDLE (5m)
// ═══════════════════════════════════════════════════════

function getConfirmationCandle(df5) {
  if (df5.length < 5) return "none";
  const c1 = df5[df5.length - 3];
  const c2 = df5[df5.length - 2];
  const body2  = Math.abs(c2.close - c2.open);
  const range2 = c2.high - c2.low;
  const wickLo = Math.min(c2.open, c2.close) - c2.low;
  const wickHi = c2.high - Math.max(c2.open, c2.close);

  // Bullish engulfing
  if (c1.close < c1.open && c2.close > c2.open && c2.close > c1.open && c2.open < c1.close) return "bullish";
  // Bearish engulfing
  if (c1.close > c1.open && c2.close < c2.open && c2.close < c1.open && c2.open > c1.close) return "bearish";
  // Bullish pin bar
  if (wickLo > body2 * 2 && c2.close > c2.open) return "bullish";
  // Bearish pin bar
  if (wickHi > body2 * 2 && c2.close < c2.open) return "bearish";
  // Strong body candle
  if (range2 > 0 && body2 > range2 * 0.7) return c2.close > c2.open ? "bullish" : "bearish";

  return "none";
}


// ═══════════════════════════════════════════════════════
//  VOTE 5 — EMA BIAS (15m)
// ═══════════════════════════════════════════════════════

function getEmaBias(df) {
  if (df.length < 50) return "neutral";
  const closes = df.map(c => c.close);
  const e20    = ema(closes, 20)[df.length - 2];
  const e50    = ema(closes, 50)[df.length - 2];
  const price  = closes[df.length - 2];
  if (price > e20 && e20 > e50) return "bullish";
  if (price < e20 && e20 < e50) return "bearish";
  return "neutral";
}


// ═══════════════════════════════════════════════════════
//  VOTE 6 — RSI MOMENTUM (15m)
// ═══════════════════════════════════════════════════════

function getRsiBias(df) {
  if (df.length < 20) return "neutral";
  const rsiVal = rsi(df.map(c => c.close), 14)[df.length - 2];
  if (rsiVal > 55) return "bullish";
  if (rsiVal < 45) return "bearish";
  return "neutral";
}


// ═══════════════════════════════════════════════════════
//  VOTE 7 — VOLUME CONFIRMATION (15m)
//  Bullish: last closed candle volume > 20-bar average
//  Bearish: same condition (high volume on move down)
//  Uses candle body size as volume proxy if no volume data
// ═══════════════════════════════════════════════════════

function getVolumeBias(df, direction) {
  if (df.length < 20) return false;

  const candle = df[df.length - 2];

  // If real volume data exists (ticks_history includes volume)
  if (candle.volume !== undefined && candle.volume !== null) {
    const avgVol = df.slice(-21, -1).reduce((s, c) => s + (c.volume || 0), 0) / 20;
    return candle.volume > avgVol * 1.1; // 10% above average
  }

  // Fallback: use candle body size as volume proxy
  const bodySize   = Math.abs(candle.close - candle.open);
  const avgBody    = df.slice(-21, -1)
    .reduce((s, c) => s + Math.abs(c.close - c.open), 0) / 20;

  // Direction must match candle direction
  if (direction === "bullish" && candle.close <= candle.open) return false;
  if (direction === "bearish" && candle.close >= candle.open) return false;

  return bodySize > avgBody * 1.1;
}


// ═══════════════════════════════════════════════════════
//  MASTER SIGNAL ENGINE
// ═══════════════════════════════════════════════════════

function getSmcSignal(df5, df15, df4h) {
  const votes = {
    htfBias:   "neutral",
    bos:       "none",
    sweep:     "none",
    ob:        null,
    obSR:      false,
    confirm:   "none",
    ema:       "neutral",
    rsi:       "neutral",
    volume:    false,
    session:   sessionName(),
    buyVotes:  0,
    sellVotes: 0,
    rejectReason: null,
  };

  // ── HARD BLOCKS ───────────────────────────────────────
  if (!df5  || df5.length  < MIN_BARS_5M)  { votes.rejectReason = "Insufficient 5m data";  return [0, votes]; }
  if (!df15 || df15.length < MIN_BARS_15M) { votes.rejectReason = "Insufficient 15m data"; return [0, votes]; }
  if (!marketIsTradeable(df5))             { votes.rejectReason = "Poor market conditions"; return [0, votes]; }

  // ── COMPUTE INDICATORS ────────────────────────────────
  const atr15   = getAtr(df15);
  const htfBias = getHtfBias(df4h);
  const bos     = detectBos(df15);
  const sweep   = detectLiquiditySweep(df15);
  const emaBias = getEmaBias(df15);
  const rsiBias = getRsiBias(df15);
  const confirm = getConfirmationCandle(df5);

  votes.htfBias = htfBias;
  votes.bos     = bos;
  votes.sweep   = sweep;
  votes.ema     = emaBias;
  votes.rsi     = rsiBias;
  votes.confirm = confirm;

  // ── RULE 1: HTF BIAS — NON-NEGOTIABLE ─────────────────
  // Neutral HTF = no trade, period
  if (htfBias === "neutral") {
    votes.rejectReason = "HTF bias is neutral — no trade";
    return [0, votes];
  }

  // ── RULE 2: MARKET STRUCTURE — HARD REQUIREMENT ───────
  // Must have BOS OR sweep — both "none" = immediate reject
  const hasBullishStructure = bos === "bullish" || sweep === "bullish_sweep";
  const hasBearishStructure = bos === "bearish" || sweep === "bearish_sweep";

  if (htfBias === "bullish" && !hasBullishStructure) {
    votes.rejectReason = "No bullish BOS or sweep on 15m — rejected";
    return [0, votes];
  }
  if (htfBias === "bearish" && !hasBearishStructure) {
    votes.rejectReason = "No bearish BOS or sweep on 15m — rejected";
    return [0, votes];
  }

  // ── RULE 3: VOTE COUNTING (direction locked by HTF) ───
  // HTF already determined direction — only count votes
  // in that direction. Opposite direction is ignored.

  if (htfBias === "bullish") {

    let score = 0;

    // Vote 1 — BOS
    if (bos === "bullish")       { score += 1; }
    // Vote 2 — Sweep
    if (sweep === "bullish_sweep") { score += 1; }
    // Vote 3 — Order Block
    const bullOb = getNearestValidOb(df15, "bullish", atr15);
    if (bullOb) {
      score += 1;
      votes.ob = bullOb;
      if (obNearSR(bullOb, df15, atr15)) {
        // S/R confluence is a bonus — counts as extra half vote
        // but we round, so only counts if strong
        votes.obSR = true;
      }
    }
    // Vote 4 — 5m Confirmation
    if (confirm === "bullish")   { score += 1; }
    // Vote 5 — EMA
    if (emaBias === "bullish")   { score += 1; }
    // Vote 6 — RSI
    if (rsiBias === "bullish")   { score += 1; }
    // Vote 7 — Volume
    const volBull = getVolumeBias(df15, "bullish");
    if (volBull) { score += 1; votes.volume = true; }

    votes.buyVotes = score;

    // Minimum 6 out of 7
    if (score >= 6) return [1, votes];

    votes.rejectReason = `Only ${score}/7 bullish votes (need 6)`;
    return [0, votes];
  }

  if (htfBias === "bearish") {

    let score = 0;

    // Vote 1 — BOS
    if (bos === "bearish")        { score += 1; }
    // Vote 2 — Sweep
    if (sweep === "bearish_sweep") { score += 1; }
    // Vote 3 — Order Block
    const bearOb = getNearestValidOb(df15, "bearish", atr15);
    if (bearOb) {
      score += 1;
      votes.ob = bearOb;
      if (obNearSR(bearOb, df15, atr15)) votes.obSR = true;
    }
    // Vote 4 — 5m Confirmation
    if (confirm === "bearish")    { score += 1; }
    // Vote 5 — EMA
    if (emaBias === "bearish")    { score += 1; }
    // Vote 6 — RSI
    if (rsiBias === "bearish")    { score += 1; }
    // Vote 7 — Volume
    const volBear = getVolumeBias(df15, "bearish");
    if (volBear) { score += 1; votes.volume = true; }

    votes.sellVotes = score;

    // Minimum 6 out of 7
    if (score >= 6) return [-1, votes];

    votes.rejectReason = `Only ${score}/7 bearish votes (need 6)`;
    return [0, votes];
  }

  return [0, votes];
}


// ═══════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════

export function getLatestSignalMtf(df5, df15, df4h = null) {
  const [signal] = getSmcSignal(df5, df15, df4h);
  return signal;
}

export function getSignalStrength(df5, df15 = null, df4h = null) {
  const [, votes] = getSmcSignal(df5, df15, df4h);
  const best = Math.max(votes.buyVotes, votes.sellVotes);
  return parseFloat(((best / 7) * 100).toFixed(1));
}

export function getTradeReason(df5, df15, df4h = null) {
  const [signal, v] = getSmcSignal(df5, df15, df4h);
  const direction   = signal === 1 ? "BUY" : signal === -1 ? "SELL" : "HOLD";
  const score       = Math.max(v.buyVotes, v.sellVotes);

  const lines = [`SMC TRADE REASON — ${direction}`];
  lines.push(`  Session   : ${v.session}`);
  lines.push(`  HTF Bias  : ${v.htfBias.toUpperCase()} ${v.htfBias !== "neutral" ? "✅" : "❌ (NO TRADE)"}`);

  if (v.rejectReason) {
    lines.push(`  ⛔ REJECTED: ${v.rejectReason}`);
    return lines.join("\n");
  }

  lines.push(`  ──────────────────────────`);
  lines.push(`  [1] BOS (15m)    : ${v.bos} ${v.bos !== "none" ? "✅" : "❌"}`);
  lines.push(`  [2] Sweep (15m)  : ${v.sweep} ${v.sweep !== "none" ? "✅" : "❌"}`);

  if (v.ob) {
    const sr = v.obSR ? " + S/R ✅" : "";
    lines.push(`  [3] Order Block  : ${v.ob.type.toUpperCase()} @ ${v.ob.low.toFixed(4)}–${v.ob.high.toFixed(4)}${sr} ✅`);
  } else {
    lines.push(`  [3] Order Block  : ❌ none in zone`);
  }

  lines.push(`  [4] Confirm (5m) : ${v.confirm} ${v.confirm !== "none" ? "✅" : "❌"}`);
  lines.push(`  [5] EMA Bias     : ${v.ema} ${v.ema !== "neutral" ? "✅" : "❌"}`);
  lines.push(`  [6] RSI Bias     : ${v.rsi} ${v.rsi !== "neutral" ? "✅" : "❌"}`);
  lines.push(`  [7] Volume       : ${v.volume ? "✅ above average" : "❌ below average"}`);
  lines.push(`  ──────────────────────────`);
  lines.push(`  Score     : ${score}/7 ${score >= 6 ? "✅ MET" : "❌ NOT MET (need 6)"}`);

  return lines.join("\n");
}

export function get15mTrend(df15) {
  return getHtfBias(df15);
}