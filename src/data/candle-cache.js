// ═══════════════════════════════════════════════════════
//  src/data/candle-cache.js
//
//  Shared candle cache — fetches once per symbol
//  per refresh interval, shared across ALL user bots.
//
//  This solves the rate limit problem:
//  Before: 3 users × 11 symbols × 3 timeframes = 99 requests per cycle
//  After:  11 symbols × 3 timeframes = 33 requests per cycle (shared)
// ═══════════════════════════════════════════════════════

const cache     = new Map(); // symbol+granularity → { candles, fetchedAt }
const CACHE_TTL = 90 * 1000; // 90 seconds — refresh candles every 1.5 minutes

// Request queue to prevent parallel fetches for same symbol
const pending   = new Map();

/**
 * Get candles from cache or fetch fresh ones.
 * If multiple bots request same symbol at same time,
 * only ONE fetch happens — others wait for it.
 */
export async function getCachedCandles(ws, symbol, granularity, count = 200) {
  const key     = `${symbol}_${granularity}`;
  const now     = Date.now();
  const cached  = cache.get(key);

  // Return cached data if still fresh and has data
  if (cached && cached.candles.length > 10 && (now - cached.fetchedAt) < CACHE_TTL) {
    return cached.candles;
  }

  // If a fetch is already in progress for this key, wait for it
  if (pending.has(key)) {
    return pending.get(key);
  }

  // Start a new fetch
  const fetchPromise = fetchCandles(ws, symbol, granularity, count)
    .then(candles => {
      // Only cache if we got actual data — don't store empty results
      if (candles && candles.length > 10) {
        cache.set(key, { candles, fetchedAt: Date.now() });
      }
      pending.delete(key);
      return candles;
    })
    .catch(err => {
      pending.delete(key);
      // Return stale cache if available rather than crashing
      if (cached) {
        console.warn(`[cache] Using stale data for ${symbol} g=${granularity}: ${err.message}`);
        return cached.candles;
      }
      return [];
    });

  pending.set(key, fetchPromise);
  return fetchPromise;
}

async function fetchCandles(ws, symbol, granularity, count) {
  const { sendMessage } = await import("../utils/ws-client.js");

  const resp = await sendMessage(ws, {
    ticks_history: symbol,
    style:         "candles",
    granularity,
    count,
    end:           "latest",
  }, "candles");

  const raw = resp?.candles ?? [];
  if (!raw.length) return [];

  const seen = new Set();
  return raw
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
 * Get all 3 timeframes using the shared cache.
 * Drop-in replacement for getMultiTf().
 */
export async function getCachedMultiTf(ws, symbol) {
  // Sequential fetch to avoid rate limit — each TF waits for previous
  const h4  = await getCachedCandles(ws, symbol, 14400, 200);
  await new Promise(r => setTimeout(r, 100));
  const m30 = await getCachedCandles(ws, symbol, 1800,  200);
  await new Promise(r => setTimeout(r, 100));
  const m15 = await getCachedCandles(ws, symbol, 900,   200);
  return { h4, m30, m15 };
}

/** Clear cache for a symbol (call if you need fresh data) */
export function clearCache(symbol) {
  for (const key of cache.keys()) {
    if (key.startsWith(symbol)) cache.delete(key);
  }
}

/** Get cache stats for debugging */
export function getCacheStats() {
  const now = Date.now();
  let fresh = 0, stale = 0;
  for (const v of cache.values()) {
    if (now - v.fetchedAt < CACHE_TTL) fresh++;
    else stale++;
  }
  return { total: cache.size, fresh, stale, pending: pending.size };
}