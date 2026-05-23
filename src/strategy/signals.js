// ═══════════════════════════════════════════════════════
//  src/strategy/signals.js
//
//  Smart Money Concepts (SMC) Strategy Engine
//  + Market hours check (isMarketOpen)
//
//  Timeframe stack:
//    4H  → HTF bias (overall direction)
//    15m → Entry timeframe (OB, BOS, sweeps)
//    5m  → Execution (confirmation candle, precise entry)
//
//  Vote layers (max 8 points):
//    1. HTF bias         (4H structure)
//    2. BOS              (15m break of structure)
//    3. Liquidity sweep  (15m)
//    4. Order Block      (15m OB in zone)
//    4b. OB + S/R        (bonus confluence)
//    5. Confirmation     (5m candle)
//    6. EMA bias         (15m)
//    7. RSI momentum     (15m)
//
//  Threshold: ≥4 votes to fire a trade
// ═══════════════════════════════════════════════════════

// ── MINIMUM BARS ───────────────────────────────────────
const MIN_BARS_5M  = 60;
const MIN_BARS_15M = 60;
const MIN_BARS_4H  = 50;

// ── SESSION WINDOWS (UTC) ──────────────────────────────
const LONDON_START   = 7;
const LONDON_END     = 16;
const NEW_YORK_START = 12;
const NEW_YORK_END   = 21;


// ═══════════════════════════════════════════════════════
// MARKET HOURS — isMarketOpen()
//
// Volatility indices (R_*) trade 24/7 — always open
// Forex + metals (frx*): closed Friday 21:00 → Sunday 21:00 UTC
// Crypto (cry*): 24/7 on Deriv
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

/**
 * Returns true if the market is currently open for trading.
 * Volatility indices and crypto are always open.
 * Forex/metals are closed from Friday 21:00 UTC to Sunday 21:00 UTC.
 */
export function isMarketOpen(symbol) {
  const schedule = MARKET_SCHEDULE[symbol];

  // Unknown symbol — assume open
  if (!schedule) return true;

  // 24/7 markets — always open
  if (schedule === "24/7") return true;

  // Forex/metals market hours:
  //   Opens:  Sunday   21:00 UTC
  //   Closes: Friday   21:00 UTC
  const now  = new Date();
  const day  = now.getUTCDay();   // 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
  const hour = now.getUTCHours();
  const min  = now.getUTCMinutes();

  const isSaturday          = day === 6;
  const isSundayBeforeOpen  = day === 0 && (hour < 21);
  const isFridayAfterClose  = day === 5 && (hour > 21 || (hour === 21 && min >= 0));

  if (isSaturday || isSundayBeforeOpen || isFridayAfterClose) {
    return false;
  }

  return true;
}


// ═══════════════════════════════════════════════════════
// SESSION HELPERS
// ═══════════════════════════════════════════════════════
export function sessionName() {
  const hour = new Date().getUTCHours();
  const london  = hour >= LONDON_START   && hour < LONDON_END;
  const newYork = hour >= NEW_YORK_START && hour < NEW_YORK_END;
  if (london && newYork) return "London+NY overlap";
  if (london)  return "London";
  if (newYork) return "New York";
  return "off-session";
}


// ═══════════════════════════════════════════════════════
// HELPERS — replaces pandas/ta with plain JS arrays
//
// Each "df" is an array of candle objects:
//   { open, high, low, close, time }
// ═══════════════════════════════════════════════════════

function ema(values, period) {
  const result = new Array(values.length).fill(null);
  const k      = 2 / (period + 1);
  const start  = period - 1;
  const seed   = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[start] = seed;
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
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-10));
  }
  return result;
}

function atr(df, period = 14) {
  const trValues = [];
  for (let i = 1; i < df.length; i++) {
    const high  = df[i].high;
    const low   = df[i].low;
    const prevC = df[i - 1].close;
    trValues.push(Math.max(high - low, Math.abs(high - prevC), Math.abs(low - prevC)));
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
// ATR VOLATILITY ENGINE
// ═══════════════════════════════════════════════════════

export function getAtr(df, period = 14) {
  const vals = atr(df, period);
  return vals[df.length - 3] ?? 0;
}

export function getAtrPct(df, period = 14) {
  const atrVal = getAtr(df, period);
  const close  = df[df.length - 2].close;
  return atrVal / close;
}

export function marketIsTradeable(df) {
  if (df.length < 20) return false;
  const pct = getAtrPct(df);
  if (pct < 0.0003) return false;
  if (pct > 0.05)   return false;
  return true;
}

export function getVolatilityScalar(df) {
  const atrPct   = getAtrPct(df);
  const baseline = 0.003;
  const scalar   = baseline / Math.max(atrPct, 0.0001);
  return parseFloat(clip(scalar, 0.25, 1.0).toFixed(4));
}


// ═══════════════════════════════════════════════════════
// MARKET STRUCTURE — SWING POINTS
// ═══════════════════════════════════════════════════════

function getSwingPoints(df, lookback = 5) {
  const highs = [];
  const lows  = [];
  for (let i = lookback; i < df.length - lookback; i++) {
    const windowHighs = df.slice(i - lookback, i + lookback + 1).map(c => c.high);
    const windowLows  = df.slice(i - lookback, i + lookback + 1).map(c => c.low);
    if (df[i].high === Math.max(...windowHighs)) highs.push([i, df[i].high]);
    if (df[i].low  === Math.min(...windowLows))  lows.push([i, df[i].low]);
  }
  return { highs, lows };
}


// ═══════════════════════════════════════════════════════
// LAYER 1 — HTF BIAS (4H)
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
// LAYER 2 — BREAK OF STRUCTURE (15m)
// ═══════════════════════════════════════════════════════
function detectBos(df) {
  if (df.length < 30) return "none";
  const { highs, lows } = getSwingPoints(df, 5);
  if (!highs.length || !lows.length) return "none";
  const prevHigh = highs[highs.length - 1][1];
  const prevLow  = lows[lows.length - 1][1];
  const close    = df[df.length - 2].close;
  if (close > prevHigh) return "bullish";
  if (close < prevLow)  return "bearish";
  return "none";
}


// ═══════════════════════════════════════════════════════
// LAYER 3 — LIQUIDITY SWEEP (15m)
// ═══════════════════════════════════════════════════════
function detectLiquiditySweep(df) {
  if (df.length < 20) return "none";
  const { highs, lows } = getSwingPoints(df, 5);
  if (!highs.length || !lows.length) return "none";
  const prevHigh = highs[highs.length - 1][1];
  const prevLow  = lows[lows.length - 1][1];
  const candle   = df[df.length - 2];
  if (candle.low < prevLow && candle.close > prevLow)    return "bullish_sweep";
  if (candle.high > prevHigh && candle.close < prevHigh) return "bearish_sweep";
  return "none";
}


// ═══════════════════════════════════════════════════════
// LAYER 4 — ORDER BLOCK DETECTION (15m)
// ═══════════════════════════════════════════════════════
function findOrderBlocks(df, atrVal) {
  const obs = [];
  if (df.length < 30) return obs;
  for (let i = 5; i < df.length - 5; i++) {
    const candle   = df[i];
    const nextMove = df[i + 3].close - df[i].close;
    if (candle.close < candle.open && nextMove > atrVal * 1.5) {
      obs.push({ type: "bullish", high: candle.high, low: candle.low,
        mid: (candle.high + candle.low) / 2, index: i, touches: 0, valid: true, strength: "fresh" });
    }
    if (candle.close > candle.open && nextMove < -atrVal * 1.5) {
      obs.push({ type: "bearish", high: candle.high, low: candle.low,
        mid: (candle.high + candle.low) / 2, index: i, touches: 0, valid: true, strength: "fresh" });
    }
  }
  return obs;
}

function getNearestValidOb(df, direction, atrVal) {
  const obs   = findOrderBlocks(df, atrVal);
  const price = df[df.length - 2].close;
  const candidates = [];
  for (const ob of obs) {
    if (ob.type !== direction || !ob.valid) continue;
    if (direction === "bullish" && price < ob.low - 1.5 * atrVal) continue;
    if (direction === "bearish" && price > ob.high + 1.5 * atrVal) continue;
    const entryBuffer = 0.2 * atrVal;
    const ignoreZone  = 0.7 * atrVal;
    if (direction === "bullish") {
      const dist = price - ob.low;
      if (dist < -entryBuffer || dist > ignoreZone) continue;
    }
    if (direction === "bearish") {
      const dist = ob.high - price;
      if (dist < -entryBuffer || dist > ignoreZone) continue;
    }
    candidates.push(ob);
  }
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (a.index > b.index ? a : b));
}


// ═══════════════════════════════════════════════════════
// LAYER 4b — S/R CONFLUENCE BONUS
// ═══════════════════════════════════════════════════════
function obNearSR(ob, df, atrVal) {
  if (!ob) return false;
  const { highs, lows } = getSwingPoints(df, 10);
  const srLevels = [...highs.map(h => h[1]), ...lows.map(l => l[1])];
  return srLevels.some(level => Math.abs(ob.mid - level) < atrVal * 0.5);
}


// ═══════════════════════════════════════════════════════
// LAYER 5 — CONFIRMATION CANDLE (5m)
// ═══════════════════════════════════════════════════════
function getConfirmationCandle(df5) {
  if (df5.length < 5) return "none";
  const c1 = df5[df5.length - 3];
  const c2 = df5[df5.length - 2];
  const o1 = c1.open, c1v = c1.close;
  const o2 = c2.open, c2v = c2.close;
  const h2 = c2.high, l2  = c2.low;
  const body2  = Math.abs(c2v - o2);
  const range2 = h2 - l2;
  const wickLo = Math.min(o2, c2v) - l2;
  const wickHi = h2 - Math.max(o2, c2v);
  if (c1v < o1 && c2v > o2 && c2v > o1 && o2 < c1v) return "bullish";
  if (c1v > o1 && c2v < o2 && c2v < o1 && o2 > c1v) return "bearish";
  if (wickLo > body2 * 2 && c2v > o2) return "bullish";
  if (wickHi > body2 * 2 && c2v < o2) return "bearish";
  if (range2 > 0 && body2 > range2 * 0.7) return c2v > o2 ? "bullish" : "bearish";
  return "none";
}


// ═══════════════════════════════════════════════════════
// LAYER 6 — EMA BIAS (15m)
// ═══════════════════════════════════════════════════════
function getEmaBias(df) {
  if (df.length < 50) return "neutral";
  const closes = df.map(c => c.close);
  const ema20  = ema(closes, 20);
  const ema50  = ema(closes, 50);
  const e20    = ema20[df.length - 2];
  const e50    = ema50[df.length - 2];
  const price  = closes[df.length - 2];
  if (price > e20 && e20 > e50) return "bullish";
  if (price < e20 && e20 < e50) return "bearish";
  return "neutral";
}


// ═══════════════════════════════════════════════════════
// LAYER 7 — RSI MOMENTUM (15m)
// ═══════════════════════════════════════════════════════
function getRsiBias(df) {
  if (df.length < 20) return "neutral";
  const closes  = df.map(c => c.close);
  const rsiVals = rsi(closes, 14);
  const rsiVal  = rsiVals[df.length - 2];
  if (rsiVal > 55) return "bullish";
  if (rsiVal < 45) return "bearish";
  return "neutral";
}


// ═══════════════════════════════════════════════════════
// MASTER SIGNAL ENGINE
// ═══════════════════════════════════════════════════════
function getSmcSignal(df5, df15, df4h) {
  const votes = {
    htfBias: "neutral", bos: "none", sweep: "none",
    ob: null, obSR: false, confirm: "none",
    ema: "neutral", rsi: "neutral",
    session: sessionName(), buyVotes: 0, sellVotes: 0,
  };

  if (!df5  || df5.length  < MIN_BARS_5M)  return [0, votes];
  if (!df15 || df15.length < MIN_BARS_15M) return [0, votes];
  if (!marketIsTradeable(df5))             return [0, votes];

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

  // ── BUY VOTES ─────────────────────────────────────────
  let buyScore = 0;
  if (htfBias === "bullish")       buyScore += 1;
  if (bos     === "bullish")       buyScore += 1;
  if (sweep   === "bullish_sweep") buyScore += 1;
  const bullOb = getNearestValidOb(df15, "bullish", atr15);
  if (bullOb) {
    buyScore += 1;
    votes.ob = bullOb;
    if (obNearSR(bullOb, df15, atr15)) { buyScore += 1; votes.obSR = true; }
  }
  if (confirm === "bullish") buyScore += 1;
  if (emaBias === "bullish") buyScore += 1;
  if (rsiBias === "bullish") buyScore += 1;

  // ── SELL VOTES ────────────────────────────────────────
  let sellScore = 0;
  if (htfBias === "bearish")       sellScore += 1;
  if (bos     === "bearish")       sellScore += 1;
  if (sweep   === "bearish_sweep") sellScore += 1;
  const bearOb = getNearestValidOb(df15, "bearish", atr15);
  if (bearOb) {
    sellScore += 1;
    if (obNearSR(bearOb, df15, atr15)) { sellScore += 1; votes.obSR = true; }
  }
  if (confirm === "bearish") sellScore += 1;
  if (emaBias === "bearish") sellScore += 1;
  if (rsiBias === "bearish") sellScore += 1;

  votes.buyVotes  = buyScore;
  votes.sellVotes = sellScore;

  // All 7 confluences must align — no partial signals
if (buyScore  === 7) return [1,  votes];
if (sellScore === 7) return [-1, votes];
  return [0, votes];
}


// ═══════════════════════════════════════════════════════
// PUBLIC API
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
  const lines = [`SMC TRADE REASON — ${direction}`];
  lines.push(`  Session      : ${v.session} (informational)`);
  lines.push(`  HTF Bias     : ${v.htfBias.toUpperCase()} ${v.htfBias !== "neutral" ? "✅" : "❌"}`);
  lines.push(`  BOS (15m)    : ${v.bos} ${v.bos !== "none" ? "✅" : "❌"}`);
  lines.push(`  Sweep (15m)  : ${v.sweep} ${v.sweep !== "none" ? "✅" : "❌"}`);
  if (v.ob) {
    const srTag = v.obSR ? " + S/R confluence ✅" : "";
    lines.push(`  Order Block  : ${v.ob.type.toUpperCase()} OB @ ${v.ob.low.toFixed(4)}–${v.ob.high.toFixed(4)}${srTag}`);
  } else {
    lines.push(`  Order Block  : ❌ none in zone`);
  }
  lines.push(`  Confirm (5m) : ${v.confirm} ${v.confirm !== "none" ? "✅" : "❌"}`);
  lines.push(`  EMA Bias     : ${v.ema} ${v.ema !== "neutral" ? "✅" : "❌"}`);
  lines.push(`  RSI Bias     : ${v.rsi} ${v.rsi !== "neutral" ? "✅" : "❌"}`);
  lines.push(`  Buy  votes   : ${v.buyVotes}/7`);
  lines.push(`  Sell votes   : ${v.sellVotes}/7`);
  lines.push(`  Threshold    : ALL 7 required — ${Math.max(v.buyVotes, v.sellVotes) === 7 ? "✅ MET" : "❌ NOT MET"}`);
  return lines.join("\n");
}

export function get15mTrend(df15) {
  return getHtfBias(df15);
}