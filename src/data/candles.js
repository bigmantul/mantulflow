// ═══════════════════════════════════════════════════════
//  src/data/candles.js
//
//  Fetches OHLC candle data via Deriv WebSocket
//
//  Timeframe stack:
//    h4  = 14400s  → HTF bias (4H)
//    m30  = 3600s   → Trend filter (30M)
//    m15 = 900s    → Entry signal + confirmation (15m)
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
 *   h4  = 14400s  (4H  — HTF bias)
 *   m30  = 3600s   (m30  — trend / entry filter)
 *   m15 = 900s    (15m — entry signal + confirmation)
 */
export async function getMultiTf(ws, symbol) {
  const [h4, m30, m15] = await Promise.all([
    getCandles(ws, symbol, 14400, 200),  // 4H  — HTF bias
    getCandles(ws, symbol, 3600,  200),  // 30M  — trend
    getCandles(ws, symbol, 900,   200),  // 15m — entry
  ]);
  return { h4, m30, m15 };
}