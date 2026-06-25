// ═══════════════════════════════════════════════════════
//  src/data/candles.js
//
//  Timeframe stack (Daily Bias Strategy):
//    d1  = 86400s  → Daily bias detection
//    h1  = 3600s   → 1H confluence check
//    m15 = 900s    → Entry confirmation
//
//  4H/30M are no longer used by the current strategy.
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
 * Fetch the 3 timeframes used by the Daily Bias strategy:
 *
 *   d1  = 86400s  (Daily — bias detection)
 *   h1  = 3600s   (1H — confluence check)
 *   m15 = 900s    (15M — entry confirmation)
 *
 * Daily candles need fewer bars (60 = ~2 months is plenty
 * for prev-day-high/low + swing structure checks) — no
 * need to request 200 daily candles.
 */
export async function getMultiTf(ws, symbol) {
  const [d1, h1, m15] = await Promise.all([
    getCandles(ws, symbol, 86400, 60),
    getCandles(ws, symbol, 3600,  200),
    getCandles(ws, symbol, 900,   200),
  ]);
  return { d1, h1, m15 };
}