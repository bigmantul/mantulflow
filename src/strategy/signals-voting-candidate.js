// ═══════════════════════════════════════════════════════
//  src/strategy/signals-voting-candidate.js — CANDIDATE, NOT LIVE
//
//  User-authored alternative to signals.js: same Stage 1/2 as
//  before, but Stage 3 embeds a 5-voter confirmation layer directly
//  on the candle that already passes the mandatory gates (valid
//  shape + closes beyond zone), instead of scanning indefinitely
//  once those gates pass.
//
//  NOTE this version does NOT include the 2-attempt-cap +
//  retracement-gate feature added to signals.js last turn — it
//  scans candles indefinitely once Entry Mode starts, same as the
//  very first version of this file. Being tested as its own
//  candidate before deciding whether to combine with that feature.
// ═══════════════════════════════════════════════════════

// ── SIGNAL CONSTANTS ──────────────────────────────────
export const SIG_BUY  =  1;
export const SIG_SELL = -1;
export const SIG_HOLD =  0;

// ── MARKET CLASSIFICATION ─────────────────────────────
const SYNTHETIC_SYMBOLS = new Set([
  "BOOM50","BOOM500","BOOM600","BOOM900","BOOM1000",
  "CRASH50","CRASH500","CRASH600","CRASH900","CRASH1000",
  "JD10","JD25","JD50","JD75","JD100",
  "STPRNG","STPRNG2","STPRNG3","STPRNG4","STPRNG5",
  "R_10","R_25","R_50","R_75","R_100",
  "1HZ10V","1HZ15V","1HZ25V","1HZ50V","1HZ75V","1HZ90V","1HZ100V",
]);
const CRYPTO_SYMBOLS = new Set(["cryBTCUSD","cryETHUSD"]);

export function isMarketOpen(symbol) {
  if (SYNTHETIC_SYMBOLS.has(symbol) || CRYPTO_SYMBOLS.has(symbol)) return true;
  const now  = new Date();
  const day  = now.getUTCDay();
  const hour = now.getUTCHours();
  if (day === 6) return false;
  if (day === 0 && hour < 21) return false;
  if (day === 5 && hour >= 21) return false;
  return true;
}

const LONDON_START = 7, LONDON_END = 16;
const NY_START     = 12, NY_END    = 21;

export function isInTradingSession(symbol) {
  if (SYNTHETIC_SYMBOLS.has(symbol) || CRYPTO_SYMBOLS.has(symbol)) return true;
  const hour   = new Date().getUTCHours();
  const london = hour >= LONDON_START && hour < LONDON_END;
  const ny     = hour >= NY_START     && hour < NY_END;
  return london || ny;
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

const symbolState = new Map();

function getState(symbol) {
  if (!symbolState.has(symbol)) {
    symbolState.set(symbol, {
      dailyBiasEpoch: null,
      dailyBias:     "none",
      dailyBiasMeta: null,
      entryMode:     false,
      entryModeReason: "",
      entryModeH1Epoch: null,
      entryModeH1High:  null,
      entryModeH1Low:   null,
      pulledBack:       false,
      m15ScanEpoch:     null,
      lastM15Epoch:  null,
      lastVoteReason: null,
    });
  }
  return symbolState.get(symbol);
}

export function resetSymbolState(symbol) {
  symbolState.delete(symbol);
}

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

function getSimpleTrend(dfD1, lookback = 30) {
  if (!dfD1 || dfD1.length < 2) return "neutral";
  const closed = dfD1.slice(0, dfD1.length - 1);
  const recent = closed.slice(-lookback);
  let bullishCount = 0, bearishCount = 0;
  for (const c of recent) {
    if (c.close > c.open) bullishCount++;
    else if (c.close < c.open) bearishCount++;
  }
  if (bearishCount > bullishCount) return "bearish";
  if (bullishCount > bearishCount) return "bullish";
  return "neutral";
}

function validateDailyCandle(candle) {
  const body  = candle.close - candle.open;
  const range = candleRange(candle);
  if (range === 0 || body === 0) {
    return { valid: false, direction: null, reason: "Zero-range/zero-body candle" };
  }
  if (body > 0) {
    const bodyAbs = body;
    const upperWick = candle.high - candle.close;
    const wickValid = bodyAbs > upperWick;
    const upperWickPct = (upperWick / bodyAbs) * 100;
    if (wickValid) return { valid: true, direction: "bullish", wickPct: upperWickPct, reason: `Valid bullish — body (${bodyAbs.toFixed(5)}) > upper wick (${upperWick.toFixed(5)})` };
    return { valid: false, direction: "bullish", wickPct: upperWickPct, reason: `Invalid bullish — upper wick (${upperWick.toFixed(5)}) >= body (${bodyAbs.toFixed(5)})` };
  }
  if (body < 0) {
    const bodyAbs = -body;
    const lowerWick = candle.close - candle.low;
    const wickValid = bodyAbs > lowerWick;
    const lowerWickPct = (lowerWick / bodyAbs) * 100;
    if (wickValid) return { valid: true, direction: "bearish", wickPct: lowerWickPct, reason: `Valid bearish — body (${bodyAbs.toFixed(5)}) > lower wick (${lowerWick.toFixed(5)})` };
    return { valid: false, direction: "bearish", wickPct: lowerWickPct, reason: `Invalid bearish — lower wick (${lowerWick.toFixed(5)}) >= body (${bodyAbs.toFixed(5)})` };
  }
  return { valid: false, direction: null, reason: "Doji / indecisive candle" };
}

function countConsecutiveValidCandles(dfD1) {
  const len = dfD1.length;
  if (len < 3) return { count: 0, direction: null, yesterdayValid: false, yesterdayDirection: null };
  const yesterday = validateDailyCandle(dfD1[len - 2]);
  if (!yesterday.valid) {
    return { count: 0, direction: null, yesterdayValid: false, yesterdayDirection: yesterday.direction, yesterdayReason: yesterday.reason };
  }
  let count = 0;
  const direction = yesterday.direction;
  for (let i = len - 2; i >= 0; i--) {
    const v = validateDailyCandle(dfD1[i]);
    if (v.valid && v.direction === direction) count++; else break;
  }
  return { count, direction, yesterdayValid: true, yesterdayDirection: direction, yesterdayReason: yesterday.reason };
}

function computeDailyBias(dfD1) {
  if (!dfD1 || dfD1.length < 5) {
    return { bias: "none", reason: "Insufficient daily data (need at least 5 candles)" };
  }
  const seq = countConsecutiveValidCandles(dfD1);
  const htfTrend = getSimpleTrend(dfD1, 30);
  const ruleA_bearish = seq.yesterdayValid && seq.yesterdayDirection === "bearish" && seq.count >= 3;
  const ruleA_bullish = seq.yesterdayValid && seq.yesterdayDirection === "bullish" && seq.count >= 3;
  const ruleB_bearish = htfTrend === "bearish";
  const ruleB_bullish = htfTrend === "bullish";

  if (ruleA_bearish) {
    const parts = [`Rule A: ${seq.count} consecutive valid bearish candles (overrides HTF trend if conflicting)`];
    if (ruleB_bearish) parts.push(`Rule B also agrees`);
    else if (ruleB_bullish) parts.push(`NOTE: Rule A reversal takes precedence over conflicting HTF trend`);
    return { bias: "bearish", reason: `Bearish bias — ${parts.join(" + ")}` };
  }
  if (ruleA_bullish) {
    const parts = [`Rule A: ${seq.count} consecutive valid bullish candles (overrides HTF trend if conflicting)`];
    if (ruleB_bullish) parts.push(`Rule B also agrees`);
    else if (ruleB_bearish) parts.push(`NOTE: Rule A reversal takes precedence over conflicting HTF trend`);
    return { bias: "bullish", reason: `Bullish bias — ${parts.join(" + ")}` };
  }
  if (ruleB_bearish) {
    if (seq.yesterdayValid && seq.yesterdayDirection === "bearish") {
      return { bias: "bearish", reason: `Bearish bias — Rule B trend, confirmed by valid bearish daily candle` };
    }
    return { bias: "none", reason: `HOLD — Rule B trend is bearish but yesterday's candle doesn't confirm it` };
  }
  if (ruleB_bullish) {
    if (seq.yesterdayValid && seq.yesterdayDirection === "bullish") {
      return { bias: "bullish", reason: `Bullish bias — Rule B trend, confirmed by valid bullish daily candle` };
    }
    return { bias: "none", reason: `HOLD — Rule B trend is bullish but yesterday's candle doesn't confirm it` };
  }
  return { bias: "none", reason: `HOLD — Rule A failed, Rule B failed (HTF trend is ${htfTrend})` };
}

// ═══════════════════════════════════════════════════════
//  STAGE 3 VOTING LAYER — 5 independent confirmation voters
// ═══════════════════════════════════════════════════════

const VOTE_THRESHOLD        = 3; // need 3 of 5 voters to agree
const RSI_PERIOD            = 14;
const EMA_PERIOD             = 20;
const EMA_SLOPE_LOOKBACK    = 5;
const STREAK_MIN            = 3;
const STRONG_CLOSE_PCT       = 0.75;
const ZONE_BUFFER_ATR_MULT  = 0.10;

function calcRsiSeries(dfM15, period = RSI_PERIOD) {
  const closes = dfM15.map(c => c.close);
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

function calcEmaSeries(dfM15, period = EMA_PERIOD) {
  const closes = dfM15.map(c => c.close);
  const ema = new Array(closes.length).fill(null);
  if (closes.length < period) return ema;
  const k = 2 / (period + 1);
  let seed = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  ema[period - 1] = seed;
  for (let i = period; i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function countCloseStreak(dfM15, idx, direction) {
  let count = 0;
  for (let i = idx; i >= 0; i--) {
    const c = dfM15[i];
    const matches = direction === "bullish" ? c.close > c.open : c.close < c.open;
    if (matches) count++; else break;
  }
  return count;
}

function voteRsiReversal(rsiSeries, idx, dailyBias) {
  if (idx < 1 || rsiSeries[idx] == null || rsiSeries[idx - 1] == null) return false;
  if (dailyBias === "bullish") return rsiSeries[idx - 1] <= 30 && rsiSeries[idx] > 30;
  return rsiSeries[idx - 1] >= 70 && rsiSeries[idx] < 70;
}

function voteMaSlope(emaSeries, dfM15, idx, dailyBias) {
  const lookIdx = idx - EMA_SLOPE_LOOKBACK;
  if (lookIdx < 0 || emaSeries[idx] == null || emaSeries[lookIdx] == null) return false;
  if (dailyBias === "bullish") return emaSeries[idx] > emaSeries[lookIdx] && dfM15[idx].close > emaSeries[idx];
  return emaSeries[idx] < emaSeries[lookIdx] && dfM15[idx].close < emaSeries[idx];
}

function voteStreak(dfM15, idx, dailyBias) {
  return countCloseStreak(dfM15, idx, dailyBias) >= STREAK_MIN;
}

function voteStrongClose(c, dailyBias) {
  const range = candleRange(c);
  if (range === 0) return false;
  if (dailyBias === "bullish") return (c.close - c.low) / range >= STRONG_CLOSE_PCT;
  return (c.high - c.close) / range >= STRONG_CLOSE_PCT;
}

function voteDistanceFromZone(c, dailyBias, zoneHigh, zoneLow, atrM15) {
  const buffer = atrM15 * ZONE_BUFFER_ATR_MULT;
  if (dailyBias === "bullish") return (c.close - zoneHigh) >= buffer;
  return (zoneLow - c.close) >= buffer;
}

function runVotes(c, idx, dfM15, dailyBias, zoneHigh, zoneLow, ctx) {
  const details = [
    { name: "RSI reversal",       pass: voteRsiReversal(ctx.rsiSeries, idx, dailyBias) },
    { name: "MA slope/alignment", pass: voteMaSlope(ctx.emaSeries, dfM15, idx, dailyBias) },
    { name: "Streak count",       pass: voteStreak(dfM15, idx, dailyBias) },
    { name: "Strong close",       pass: voteStrongClose(c, dailyBias) },
    { name: "Distance from zone", pass: voteDistanceFromZone(c, dailyBias, zoneHigh, zoneLow, ctx.atrM15) },
  ];
  const votesPassed = details.filter(v => v.pass).length;
  return { votesPassed, total: details.length, details };
}

function check1hConfirmation(dailyBias, dfH1, dfD1) {
  if (!dfH1 || dfH1.length < 3) return { confirmed: false, reason: "Insufficient 1H data" };
  if (!dfD1 || dfD1.length < 2) return { confirmed: false, reason: "Insufficient daily data for yesterday's high/low" };
  const len  = dfH1.length;
  const last = dfH1[len - 2];
  const yesterday = dfD1[dfD1.length - 2];
  const yesterdayHigh = yesterday.high;
  const yesterdayLow  = yesterday.low;

  if (dailyBias === "bullish") {
    const openAbove  = last.open  > yesterdayHigh;
    const closeAbove = last.close > yesterdayHigh;
    if (!openAbove || !closeAbove) {
      return { confirmed: false, reason: `Waiting — 1H candle has not fully opened+closed above yesterday's high (${yesterdayHigh.toFixed(5)})` };
    }
    const shape = validateDailyCandle(last);
    if (!shape.valid || shape.direction !== "bullish") {
      return { confirmed: false, reason: `1H open+close above yesterday's high but candle shape invalid — ${shape.reason}` };
    }
    return { confirmed: true, h1Epoch: last.epoch, h1High: last.high, h1Low: last.low, reason: `1H candle confirmed above yesterday's high (${yesterdayHigh.toFixed(5)})` };
  }
  if (dailyBias === "bearish") {
    const openBelow  = last.open  < yesterdayLow;
    const closeBelow = last.close < yesterdayLow;
    if (!openBelow || !closeBelow) {
      return { confirmed: false, reason: `Waiting — 1H candle has not fully opened+closed below yesterday's low (${yesterdayLow.toFixed(5)})` };
    }
    const shape = validateDailyCandle(last);
    if (!shape.valid || shape.direction !== "bearish") {
      return { confirmed: false, reason: `1H open+close below yesterday's low but candle shape invalid — ${shape.reason}` };
    }
    return { confirmed: true, h1Epoch: last.epoch, h1High: last.high, h1Low: last.low, reason: `1H candle confirmed below yesterday's low (${yesterdayLow.toFixed(5)})` };
  }
  return { confirmed: false, reason: "No daily bias" };
}

function check15mEntry(dailyBias, dfM15, dfD1, state) {
  if (!dfM15 || dfM15.length < 3) return { signal: SIG_HOLD, reason: "Insufficient 15M data" };
  if (!state.entryModeH1Epoch) return { signal: SIG_HOLD, reason: "No confirmed H1 bar recorded for entry mode" };
  if (dailyBias !== "bullish" && dailyBias !== "bearish") return { signal: SIG_HOLD, reason: "No daily bias" };

  const zoneHigh = state.entryModeH1High;
  const zoneLow  = state.entryModeH1Low;
  const h1Epoch  = state.entryModeH1Epoch;

  if (state.m15ScanEpoch === null) {
    state.m15ScanEpoch = h1Epoch + 3600 - 1;
  }

  const len             = dfM15.length;
  const lastClosedEpoch = dfM15[len - 2].epoch;
  const toScan = dfM15
    .filter(c => c.epoch > state.m15ScanEpoch && c.epoch <= lastClosedEpoch)
    .sort((a, b) => a.epoch - b.epoch);

  const waitingReason = () => state.pulledBack
    ? `Pulled back inside the H1 confirmation zone (${zoneLow.toFixed(5)} - ${zoneHigh.toFixed(5)}) — waiting for a valid ${dailyBias} candle to close back beyond it`
    : `Watching for a valid ${dailyBias} candle to close beyond the H1 confirmation zone (${zoneLow.toFixed(5)} - ${zoneHigh.toFixed(5)})`;

  if (toScan.length === 0) return { signal: SIG_HOLD, reason: waitingReason() };

  // PERFORMANCE FIX (not a logic change): the original computed
  // RSI/EMA/ATR over the ENTIRE growing history array from scratch on
  // every single scan cycle. As history accumulates (backtest OR live,
  // since the bot's growing window only ever gets longer over time),
  // that gets progressively slower — measured at 6+ seconds per symbol
  // per call on real 1yr data. RSI(14)/EMA(20) only need a reasonable
  // recent buffer, not the full history, so this windows it down
  // without changing what any vote actually measures.
  const INDICATOR_WINDOW = 300;
  const windowStart = Math.max(0, dfM15.length - INDICATOR_WINDOW);
  const windowedM15 = dfM15.slice(windowStart);

  const rsiSeries = calcRsiSeries(windowedM15);
  const emaSeries = calcEmaSeries(windowedM15);
  const atrM15    = calcAtr(windowedM15);
  const voteCtx   = { rsiSeries, emaSeries, atrM15 };

  for (const c of toScan) {
    state.m15ScanEpoch = c.epoch;
    const shape            = validateDailyCandle(c);
    const shapeOk           = shape.valid && shape.direction === dailyBias;
    const closesBeyondZone  = dailyBias === "bullish" ? c.close > zoneHigh : c.close < zoneLow;

    if (shapeOk && closesBeyondZone) {
      const idx = windowedM15.findIndex(x => x.epoch === c.epoch);
      const { votesPassed, total, details } = runVotes(c, idx, windowedM15, dailyBias, zoneHigh, zoneLow, voteCtx);

      if (votesPassed >= VOTE_THRESHOLD) {
        const direction  = dailyBias === "bullish" ? "buy" : "sell";
        const votesList  = details.filter(v => v.pass).map(v => v.name).join(", ");
        return {
          signal: direction === "buy" ? SIG_BUY : SIG_SELL,
          reason: `Valid ${dailyBias} candle closed beyond zone AND passed ${votesPassed}/${total} votes (${votesList}) — entering now`,
        };
      }
      const failedList = details.filter(v => !v.pass).map(v => v.name).join(", ");
      state.lastVoteReason = `Closed beyond zone but only ${votesPassed}/${total} votes passed (need ${VOTE_THRESHOLD}) — missing: ${failedList}`;
      continue;
    }

    const closesInsideZone = c.close >= zoneLow && c.close <= zoneHigh;
    if (closesInsideZone) state.pulledBack = true;
  }

  if (state.lastVoteReason) return { signal: SIG_HOLD, reason: state.lastVoteReason };
  return { signal: SIG_HOLD, reason: waitingReason() };
}

export function collectSignals(tf) {
  const { d1, h1, m15, symbol } = tf;
  const state = getState(symbol || "default");
  const breakdown = [];

  const latestClosedD1Epoch = (d1 && d1.length >= 2) ? d1[d1.length - 2].epoch : null;

  if (latestClosedD1Epoch !== null && state.dailyBiasEpoch !== latestClosedD1Epoch) {
    const result = computeDailyBias(d1);
    state.dailyBiasEpoch = latestClosedD1Epoch;
    state.dailyBias      = result.bias;
    state.dailyBiasMeta  = result.reason;
    state.entryMode      = false;
    state.entryModeReason = "";
    state.entryModeH1Epoch = null;
    state.entryModeH1High  = null;
    state.entryModeH1Low   = null;
    state.pulledBack        = false;
    state.m15ScanEpoch      = null;
    state.lastVoteReason    = null;
  } else if (latestClosedD1Epoch === null && state.dailyBiasEpoch === null) {
    const result = computeDailyBias(d1);
    state.dailyBias     = result.bias;
    state.dailyBiasMeta = result.reason;
  }

  breakdown.push({ step: "Stage1 DailyBias", result: state.dailyBias.toUpperCase(), reason: state.dailyBiasMeta });

  if (state.dailyBias === "none") {
    return { signal: SIG_HOLD, breakdown, reason: `NO TRADE TODAY — ${state.dailyBiasMeta}`, dailyBias: "none" };
  }

  if (!isInTradingSession(symbol)) {
    breakdown.push({ step: "Stage2 1H Confirm", result: "OUTSIDE SESSION", reason: `${symbol} — waiting for London/NY session (FX only)` });
    return { signal: SIG_HOLD, breakdown, reason: "Outside London/NY trading session — bias held for next session", dailyBias: state.dailyBias };
  }

  if (!state.entryMode) {
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
    state.pulledBack        = false;
    state.m15ScanEpoch      = null;
    state.lastVoteReason    = null;
  } else {
    breakdown.push({ step: "Stage2 1H Confirm", result: "ENTRY MODE (active)", reason: state.entryModeReason });
  }

  const entry = check15mEntry(state.dailyBias, m15, d1, state);
  breakdown.push({
    step: "Stage3 15M Entry",
    result: entry.signal === SIG_HOLD ? "WAIT" : (entry.signal === SIG_BUY ? "BUY" : "SELL"),
    reason: entry.reason,
  });

  if (entry.signal !== SIG_HOLD) {
    state.entryMode = false;
  }

  return { signal: entry.signal, breakdown, reason: entry.reason, dailyBias: state.dailyBias };
}

export function getTradeReason(tf) {
  const result = collectSignals(tf);
  const direction = result.signal === SIG_BUY ? "BUY" : result.signal === SIG_SELL ? "SELL" : "HOLD/WAIT";
  const lines = [`DAILY BIAS STRATEGY (voting candidate) — ${direction}`];
  for (const step of result.breakdown) lines.push(`  ${step.step}: ${step.result} — ${step.reason}`);
  return lines.join("\n");
}

export function getLatestSignalMtf(dfM15, dfH1, dfD1, symbol) {
  return collectSignals({ d1: dfD1, h1: dfH1, m15: dfM15, symbol }).signal;
}

export function get15mTrend(dfD1) {
  const result = computeDailyBias(dfD1);
  if (result.bias === "bullish") return "bullish";
  if (result.bias === "bearish") return "bearish";
  return "neutral";
}
