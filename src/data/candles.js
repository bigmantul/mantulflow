// ═══════════════════════════════════════════════════════
//  src/data/candles.js
//
//  Converted from data.py — logic is 1:1 identical
//
//  Fetches OHLC candle data via Deriv WebSocket.
//  Returns plain JS arrays of { time, open, high, low, close }
//  (replaces pandas DataFrames — signals.js works with these directly)
//
//  Granularities:
//    300   =  5 minutes  (execution / confirmation)
//    900   = 15 minutes  (entry — OB, BOS, sweeps)
//    14400 =  4 hours    (HTF bias / market structure)
// ═══════════════════════════════════════════════════════

import { sendMessage } from "../utils/ws-client.js";

// Empty candle array — equivalent to pd.DataFrame(columns=[...])
const EMPTY = [];

/**
 * Fetch OHLC candles for a symbol at a given granularity.
 * Equivalent to Python's get_candles()
 *
 * @param {WebSocket} ws
 * @param {string}  symbol      - e.g. "R_100", "frxXAUUSD"
 * @param {number}  granularity - seconds per candle (300, 900, 14400)
 * @param {number}  count       - number of candles to fetch
 * @returns {Array} array of { time, open, high, low, close }
 */
export async function getCandles(ws, symbol, granularity = 60, count = 200) {
  let resp;

  try {
    resp = await sendMessage(
      ws,
      {
        ticks_history: symbol,
        style:         "candles",
        granularity,
        count,
        end:           "latest",
      },
      "candles"
    );
  } catch (e) {
    console.error(`API error getting candles for ${symbol} (g=${granularity}):`, e.message);
    return EMPTY;
  }

  const rawCandles = resp?.candles ?? [];

  if (!rawCandles.length) {
    console.warn(`Warning: No candles received for ${symbol} (g=${granularity})`);
    return EMPTY;
  }

  // Validate required fields — same check as Python's required_cols
  const required = ["epoch", "open", "high", "low", "close"];
  const firstCandle = rawCandles[0];
  const missing = required.filter(k => !(k in firstCandle));

  if (missing.length) {
    console.error(`Invalid candle format for ${symbol}: missing fields ${missing.join(", ")}`);
    return EMPTY;
  }

  // Build array, cast strings to floats, add time field
  // Equivalent to: df["time"] = pd.to_datetime(df["epoch"], unit="s")
  const seen = new Set();
  const candles = rawCandles
    .map(c => ({
      time:  new Date(c.epoch * 1000),   // epoch seconds → JS Date
      open:  parseFloat(c.open),
      high:  parseFloat(c.high),
      low:   parseFloat(c.low),
      close: parseFloat(c.close),
      epoch: c.epoch,
    }))
    // sort_values("time") — already in order from API but sort to be safe
    .sort((a, b) => a.epoch - b.epoch)
    // drop_duplicates(subset=["time"])
    .filter(c => {
      if (seen.has(c.epoch)) return false;
      seen.add(c.epoch);
      return true;
    });

  return candles;
}


/**
 * Fetch all three timeframes in parallel.
 * Equivalent to Python's get_multi_tf()
 *
 * asyncio.gather() → Promise.all() (same parallel behaviour)
 *
 * @param {WebSocket} ws
 * @param {string} symbol
 * @returns {{ m5, m15, h4 }} — each is an array of candle objects
 */
export async function getMultiTf(ws, symbol) {
  const [m5, m15, h4] = await Promise.all([
    getCandles(ws, symbol, 300,   200),   // 5m  candles
    getCandles(ws, symbol, 900,   200),   // 15m candles
    getCandles(ws, symbol, 14400, 100),   // 4H  candles
  ]);

  return { m5, m15, h4 };
}