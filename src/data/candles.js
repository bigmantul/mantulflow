// ═══════════════════════════════════════════════════════
//  src/data/candles.js
//
//  Fetches OHLC candle data via Deriv WebSocket
//
//  NEW Timeframe stack:
//    daily  = 86400s  → HTF bias (was 4H/14400s)
//    h1     = 3600s   → Entry: BOS, OB, EMA, RSI (was 15m/900s)
//    m15    = 900s    → Confirmation candle (was 5m/300s)
// ═══════════════════════════════════════════════════════

import { sendMessage } from "../utils/ws-client.js";

const EMPTY = [];

export async function getCandles(ws, symbol, granularity = 3600, count = 200) {
  let resp;
  try {
    resp = await sendMessage(ws, {
      ticks_history: symbol,
      style:         "candles",
      granularity,
      count,
      end:           "latest",
    }, "candles");
  } catch (e) {
    console.error(`API error getting candles for ${symbol} (g=${granularity}):`, e.message);
    return EMPTY;
  }

  const rawCandles = resp?.candles ?? [];
  if (!rawCandles.length) {
    console.warn(`Warning: No candles for ${symbol} (g=${granularity})`);
    return EMPTY;
  }

  const required = ["epoch", "open", "high", "low", "close"];
  if (!required.every(k => k in rawCandles[0])) {
    console.error(`Invalid candle format for ${symbol}`);
    return EMPTY;
  }

  const seen = new Set();
  return rawCandles
    .map(c => ({
      time:  new Date(c.epoch * 1000),
      open:  parseFloat(c.open),
      high:  parseFloat(c.high),
      low:   parseFloat(c.low),
      close: parseFloat(c.close),
      epoch: c.epoch,
    }))
    .sort((a, b) => a.epoch - b.epoch)
    .filter(c => {
      if (seen.has(c.epoch)) return false;
      seen.add(c.epoch);
      return true;
    });
}

/**
 * Fetch all three timeframes in parallel
 *
 * NEW stack:
 *   daily = 86400s  (HTF bias)
 *   h1    = 3600s   (entry — BOS, OB, EMA, RSI, sweep)
 *   m15   = 900s    (confirmation candle)
 */
export async function getMultiTf(ws, symbol) {
  const [daily, h1, m15] = await Promise.all([
    getCandles(ws, symbol, 86400, 100),  // Daily candles — HTF bias
    getCandles(ws, symbol, 3600,  200),  // 1H candles   — entry TF
    getCandles(ws, symbol, 900,   200),  // 15m candles  — confirmation
  ]);
  return { daily, h1, m15 };
}