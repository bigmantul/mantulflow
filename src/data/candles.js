// ═══════════════════════════════════════════════════════
//  src/data/candles.js
//
//  Timeframe stack:
//    h4  = 14400s  → HTF bias (4H)
//    m30 = 1800s   → Trend filter (30M)
//    m15 = 900s    → Entry + confirmation (15M)
// ═══════════════════════════════════════════════════════

import { sendMessage } from "../utils/ws-client.js";

const EMPTY = [];

export async function getCandles(ws, symbol, granularity = 3600, count = 200) {
  try {
    const resp = await sendMessage(ws, {
      ticks_history: symbol,
      style:         "candles",
      granularity,
      count,
      end:           "latest",
    }, "candles");

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
  } catch (e) {
    console.error(`API error getting candles for ${symbol} (g=${granularity}):`, e.message);
    return EMPTY;
  }
}

/**
 * Fetch all three timeframes
 *
 *   h4  = 14400s  (4H  — HTF bias)
 *   m30 = 1800s   (30M — trend filter)
 *   m15 = 900s    (15M — entry)
 */
export async function getMultiTf(ws, symbol) {
  const [h4, m30, m15] = await Promise.all([
    getCandles(ws, symbol, 14400, 200),
    getCandles(ws, symbol, 1800,  200),
    getCandles(ws, symbol, 900,   200),
  ]);
  return { h4, m30, m15 };
}