// ═══════════════════════════════════════════════════════
//  src/strategy/signals.js
//
//  SMC Strategy Engine
//
//  Timeframe stack:
//    4H  → HTF bias (direction — bullish/bearish/neutral)
//    1H  → Trend filter (confirms HTF direction)
//    15m → Entry signal (BOS, sweep, OB, EMA, RSI, Volume)
//          + Confirmation candle
//
//  RULES:
//  1. 4H bias must NOT be neutral → no trade
//  2. 1H trend must AGREE with 4H bias → no trade if disagrees
//  3. Min 5 out of 7 votes on 15m in that direction
// ═══════════════════════════════════════════════════════

const MIN_BARS_H4  = 50;
const MIN_BARS_H1  = 100;
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
  cryLTCUSD: "24/7",  cryBCHUSD: "24/7",
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
  let avgGain = gains / period;
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
  if (pct < 0.00005) return false;
  if (pct > 0.10)    return false;
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
//  LAYER 1 — HTF BIAS (4H)
//  Direction filter — neutral = no trade
// ═══════════════════════════════════════════════════════
function getHtfBias(dfH4) {
  if (!dfH4 || dfH4.length < MIN_BARS_H4) return "neutral";

  const { highs, lows } = getSwingPoints(dfH4, 2);
  if (highs.length < 2 || lows.length < 2) return "neutral";

  const hh = highs[highs.length - 1][1] > highs[highs.length - 2][1];
  const hl = lows[lows.length - 1][1]   > lows[lows.length - 2][1];
  const lh = highs[highs.length - 1][1] < highs[highs.length - 2][1];
  const ll = lows[lows.length - 1][1]   < lows[lows.length - 2][1];

  if (hh && hl) return "bullish";
  if (lh && ll) return "bearish";
  if (hh || hl) return "bullish";
  if (lh || ll) return "bearish";
  return "neutral";
}


// ═══════════════════════════════════════════════════════
//  LAYER 2 — TREND FILTER (1H)
//  Must agree with 4H bias
//  Uses EMA20 vs EMA50 on 1H
// ═══════════════════════════════════════════════════════
function getH1Trend(dfH1) {
  if (!dfH1 || dfH1.length < 50) return "neutral";
  const closes = dfH1.map(c => c.close);
  const e20    = ema(closes, 20)[dfH1.length - 2];
  const e50    = ema(closes, 50)[dfH1.length - 2];
  const price  = closes[dfH1.length - 2];
  if (price > e20 && e20 > e50) return "bullish";
  if (price < e20 && e20 < e50) return "bearish";
  return "neutral";
}


// ═══════════════════════════════════════════════════════
//  VOTE 1 — BOS on 15m
// ═══════════════════════════════════════════════════════
function detectBos(df) {
  if (df.length < 30) return "none";
  const { highs, lows } = getSwingPoints(df, 5);
  if (!highs.length || !lows.length) return "none";
  const close = df[df.length - 2].close;
  if (close > highs[highs.length - 1][1]) return "bullish";
  if (close < lows[lows.length - 1][1])   return "bearish";
  return "none";
}


// ═══════════════════════════════════════════════════════
//  VOTE 2 — LIQUIDITY SWEEP on 15m
// ═══════════════════════════════════════════════════════
function detectLiquiditySweep(df) {
  if (df.length < 20) return "none";
  const { highs, lows } = getSwingPoints(df, 5);
  if (!highs.length || !lows.length) return "none";
  const candle = df[df.length - 2];
  if (candle.low  < lows[lows.length - 1][1]  && candle.close > lows[lows.length - 1][1])   return "bullish_sweep";
  if (candle.high > highs[highs.length - 1][1] && candle.close < highs[highs.length - 1][1]) return "bearish_sweep";
  return "none";
}


// ═══════════════════════════════════════════════════════
//  VOTE 3 — ORDER BLOCK on 15m
// ═══════════════════════════════════════════════════════
function findOrderBlocks(df, atrVal) {
  const obs = [];
  if (df.length < 30) return obs;
  for (let i = 5; i < df.length - 5; i++) {
    const c        = df[i];
    const nextMove = df[i + 3].close - df[i].close;
    if (c.close < c.open && nextMove >  atrVal * 1.5)
      obs.push({ type: "bullish", high: c.high, low: c.low, mid: (c.high + c.low) / 2, index: i, valid: true });
    if (c.close > c.open && nextMove < -atrVal * 1.5)
      obs.push({ type: "bearish", high: c.high, low: c.low, mid: (c.high + c.low) / 2, index: i, valid: true });
  }
  return obs;
}

function getNearestValidOb(df, direction, atrVal) {
  const price      = df[df.length - 2].close;
  const candidates = findOrderBlocks(df, atrVal).filter(ob => {
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


// ═══════════════════════════════════════════════════════
//  VOTE 4 — CONFIRMATION CANDLE on 15m
// ═══════════════════════════════════════════════════════
function getConfirmationCandle(dfM15) {
  if (dfM15.length < 5) return "none";
  const c1     = dfM15[dfM15.length - 3];
  const c2     = dfM15[dfM15.length - 2];
  const body2  = Math.abs(c2.close - c2.open);
  const range2 = c2.high - c2.low;
  const wickLo = Math.min(c2.open, c2.close) - c2.low;
  const wickHi = c2.high - Math.max(c2.open, c2.close);
  if (c1.close < c1.open && c2.close > c2.open && c2.close > c1.open && c2.open < c1.close) return "bullish";
  if (c1.close > c1.open && c2.close < c2.open && c2.close < c1.open && c2.open > c1.close) return "bearish";
  if (wickLo > body2 * 2 && c2.close > c2.open) return "bullish";
  if (wickHi > body2 * 2 && c2.close < c2.open) return "bearish";
  if (range2 > 0 && body2 > range2 * 0.7) return c2.close > c2.open ? "bullish" : "bearish";
  return "none";
}


// ═══════════════════════════════════════════════════════
//  VOTE 5 — EMA BIAS on 15m
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
//  VOTE 6 — RSI on 15m
// ═══════════════════════════════════════════════════════
function getRsiBias(df) {
  if (df.length < 20) return "neutral";
  const rsiVal = rsi(df.map(c => c.close), 14)[df.length - 2];
  if (rsiVal > 55) return "bullish";
  if (rsiVal < 45) return "bearish";
  return "neutral";
}


// ═══════════════════════════════════════════════════════
//  VOTE 7 — VOLUME on 15m
// ═══════════════════════════════════════════════════════
function getVolumeBias(df) {
  if (df.length < 20) return false;
  const candle   = df[df.length - 2];
  if (candle.volume != null) {
    const avgVol = df.slice(-21, -1).reduce((s, c) => s + (c.volume || 0), 0) / 20;
    return candle.volume > avgVol * 1.1;
  }
  const bodySize = Math.abs(candle.close - candle.open);
  const avgBody  = df.slice(-21, -1).reduce((s, c) => s + Math.abs(c.close - c.open), 0) / 20;
  return bodySize > avgBody * 1.1;
}


// ═══════════════════════════════════════════════════════
//  MASTER SIGNAL ENGINE
// ═══════════════════════════════════════════════════════
function getSmcSignal(dfM15, dfH1, dfH4) {
  const votes = {
    htfBias: "neutral", h1Trend: "neutral",
    bos: "none", sweep: "none", ob: null,
    confirm: "none", ema: "neutral",
    rsi: "neutral", volume: false,
    session: sessionName(),
    buyVotes: 0, sellVotes: 0,
    rejectReason: null,
  };

  // ── HARD BLOCKS ───────────────────────────────────────
  if (!dfM15 || dfM15.length < MIN_BARS_M15) { votes.rejectReason = "Insufficient 15m data";  return [0, votes]; }
  if (!dfH1  || dfH1.length  < MIN_BARS_H1)  { votes.rejectReason = "Insufficient 1H data";   return [0, votes]; }
  if (!marketIsTradeable(dfM15))              { votes.rejectReason = "Poor market conditions"; return [0, votes]; }

  // ── LAYER 1: 4H BIAS ──────────────────────────────────
  const htfBias = getHtfBias(dfH4);
  votes.htfBias = htfBias;

  if (htfBias === "neutral") {
    votes.rejectReason = "4H bias neutral — no clear direction";
    return [0, votes];
  }

  // ── LAYER 2: 1H TREND FILTER ──────────────────────────
  const h1Trend = getH1Trend(dfH1);
  votes.h1Trend = h1Trend;

  // 1H must not OPPOSE 4H — neutral is allowed, only opposite blocks
  // e.g. 4H bullish + 1H bearish = skip
  // e.g. 4H bullish + 1H neutral = allowed (pullback phase)
  // e.g. 4H bullish + 1H bullish = best case
  if ((htfBias === "bullish" && h1Trend === "bearish") ||
      (htfBias === "bearish" && h1Trend === "bullish")) {
    votes.rejectReason = `1H trend (${h1Trend}) OPPOSES 4H bias (${htfBias}) — skipping`;
    return [0, votes];
  }

  // ── LAYER 3: 15m VOTE COUNTING ────────────────────────
  const atrM15  = getAtr(dfM15);
  const bos     = detectBos(dfM15);
  const sweep   = detectLiquiditySweep(dfM15);
  const emaBias = getEmaBias(dfM15);
  const rsiBias = getRsiBias(dfM15);
  const confirm = getConfirmationCandle(dfM15);
  const volume  = getVolumeBias(dfM15);

  votes.bos     = bos;
  votes.sweep   = sweep;
  votes.ema     = emaBias;
  votes.rsi     = rsiBias;
  votes.confirm = confirm;
  votes.volume  = volume;

  if (htfBias === "bullish") {
    let score = 0;
    if (bos === "bullish")         score += 1;  // Vote 1
    if (sweep === "bullish_sweep") score += 1;  // Vote 2
    const bullOb = getNearestValidOb(dfM15, "bullish", atrM15);
    if (bullOb) { score += 1; votes.ob = bullOb; }  // Vote 3
    if (confirm === "bullish")     score += 1;  // Vote 4
    if (emaBias === "bullish")     score += 1;  // Vote 5
    if (rsiBias === "bullish")     score += 1;  // Vote 6
    if (volume)                    score += 1;  // Vote 7

    votes.buyVotes = score;
    if (score >= 4) return [1, votes];
    votes.rejectReason = `${score}/7 bullish votes on 15m (need 4)`;
    return [0, votes];
  }

  if (htfBias === "bearish") {
    let score = 0;
    if (bos === "bearish")          score += 1;
    if (sweep === "bearish_sweep")  score += 1;
    const bearOb = getNearestValidOb(dfM15, "bearish", atrM15);
    if (bearOb) { score += 1; votes.ob = bearOb; }
    if (confirm === "bearish")      score += 1;
    if (emaBias === "bearish")      score += 1;
    if (rsiBias === "bearish")      score += 1;
    if (volume)                     score += 1;

    votes.sellVotes = score;
    if (score >= 4) return [-1, votes];
    votes.rejectReason = `${score}/7 bearish votes on 15m (need 4)`;
    return [0, votes];
  }

  return [0, votes];
}


// ═══════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════
export function getLatestSignalMtf(dfM15, dfH1, dfH4 = null) {
  const [signal] = getSmcSignal(dfM15, dfH1, dfH4);
  return signal;
}

export function getSignalStrength(dfM15, dfH1 = null, dfH4 = null) {
  const [, votes] = getSmcSignal(dfM15, dfH1, dfH4);
  const best = Math.max(votes.buyVotes, votes.sellVotes);
  return parseFloat(((best / 7) * 100).toFixed(1));
}

export function getTradeReason(dfM15, dfH1, dfH4 = null) {
  const [signal, v] = getSmcSignal(dfM15, dfH1, dfH4);
  const direction   = signal === 1 ? "BUY" : signal === -1 ? "SELL" : "HOLD";
  const score       = Math.max(v.buyVotes, v.sellVotes);

  const lines = [`SMC TRADE REASON — ${direction}`];
  lines.push(`  Session   : ${v.session}`);
  lines.push(`  4H Bias   : ${v.htfBias.toUpperCase()} ${v.htfBias !== "neutral" ? "✅" : "❌"}`);

  if (v.rejectReason) {
    lines.push(`  ⛔ ${v.rejectReason}`);
    return lines.join("\n");
  }

  lines.push(`  1H Trend  : ${v.h1Trend.toUpperCase()} ✅ (agrees with 4H)`);
  lines.push(`  ─────────────────────────`);
  lines.push(`  [1] BOS (15m)    : ${v.bos} ${v.bos !== "none" ? "✅" : "❌"}`);
  lines.push(`  [2] Sweep (15m)  : ${v.sweep} ${v.sweep !== "none" ? "✅" : "❌"}`);
  if (v.ob) {
    lines.push(`  [3] OB (15m)     : ${v.ob.type.toUpperCase()} @ ${v.ob.low.toFixed(5)}–${v.ob.high.toFixed(5)} ✅`);
  } else {
    lines.push(`  [3] OB (15m)     : ❌ none in zone`);
  }
  lines.push(`  [4] Confirm (15m): ${v.confirm} ${v.confirm !== "none" ? "✅" : "❌"}`);
  lines.push(`  [5] EMA (15m)    : ${v.ema} ${v.ema !== "neutral" ? "✅" : "❌"}`);
  lines.push(`  [6] RSI (15m)    : ${v.rsi} ${v.rsi !== "neutral" ? "✅" : "❌"}`);
  lines.push(`  [7] Volume (15m) : ${v.volume ? "✅ above avg" : "❌ below avg"}`);
  lines.push(`  ─────────────────────────`);
  lines.push(`  Score     : ${score}/7 — ${score >= 4 ? "✅ TRADE FIRES" : "❌ need 4"}`);

  return lines.join("\n");
}

export function get15mTrend(dfH1) {
  return getH1Trend(dfH1);
}