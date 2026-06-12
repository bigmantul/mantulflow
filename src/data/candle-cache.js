// ═══════════════════════════════════════════════════════
//  src/data/candle-cache.js
//
//  GLOBAL SHARED CANDLE CACHE
//
//  Architecture:
//    One background scanner fetches ALL symbols once
//    every 90 seconds using ITS OWN WebSocket connection.
//    All user bots read from this cache instantly —
//    they NEVER call the Deriv candle API directly.
//
//  Before: 6 users × 22 symbols × 3 TFs = 396 API calls
//  After:  1 scanner × 22 symbols × 3 TFs = 66 API calls
// ═══════════════════════════════════════════════════════

import { sendMessage, connectWebSocket } from "../utils/ws-client.js";
import { connectForMode }                from "../auth/deriv-auth.js";

const CACHE_TTL    = 90 * 1000;  // 90 seconds
const SCAN_INTERVAL = 85 * 1000; // scan every 85s (slightly before TTL)

const cache   = new Map(); // symbol+gran → { candles, fetchedAt }
const pending = new Map(); // symbol+gran → Promise (dedup concurrent requests)

let scannerRunning = false;
let scannerWs      = null;

// ── PUBLIC API ────────────────────────────────────────

/**
 * Get all 3 timeframes for a symbol.
 * Returns from cache if fresh — never waits for API.
 * Falls back to direct fetch only if cache is empty.
 */
export async function getCachedMultiTf(ws, symbol) {
  const h4  = await getCachedCandles(ws, symbol, 14400, 200);
  const m30 = await getCachedCandles(ws, symbol, 1800,  200);
  const m15 = await getCachedCandles(ws, symbol, 900,   200);
  return { h4, m30, m15 };
}

/**
 * Get cached candles for one symbol+granularity.
 * Uses shared cache — only fetches if cache is stale/empty.
 */
export async function getCachedCandles(ws, symbol, granularity, count = 200) {
  const key    = `${symbol}_${granularity}`;
  const now    = Date.now();
  const cached = cache.get(key);

  // Return fresh cache immediately
  if (cached && cached.candles.length > 10 && (now - cached.fetchedAt) < CACHE_TTL) {
    return cached.candles;
  }

  // If already fetching this key, wait for it
  if (pending.has(key)) return pending.get(key);

  // Fetch fresh data
  const promise = fetchCandles(ws, symbol, granularity, count)
    .then(candles => {
      if (candles.length > 10) cache.set(key, { candles, fetchedAt: Date.now() });
      pending.delete(key);
      return candles;
    })
    .catch(err => {
      pending.delete(key);
      if (cached) {
        console.warn(`[cache] Stale data for ${symbol} g=${granularity}: ${err.message}`);
        return cached.candles;
      }
      return [];
    });

  pending.set(key, promise);
  return promise;
}

async function fetchCandles(ws, symbol, granularity, count) {
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
    .filter(c => { if (seen.has(c.epoch)) return false; seen.add(c.epoch); return true; });
}

// ── BACKGROUND SCANNER ────────────────────────────────

/**
 * Start the global background scanner.
 * Called ONCE on server startup.
 * Uses its own WebSocket — user bots never fetch candles directly.
 *
 * @param {string[]} symbols  - full symbol list
 * @param {string}   token    - any valid PAT token (for candle access)
 * @param {string}   appId    - Deriv App ID
 * @param {string}   mode     - "demo" or "real"
 */
export async function startGlobalScanner(symbols, token, appId, mode = "demo") {
  if (scannerRunning) return;
  scannerRunning = true;
  console.log(`🔭 Global candle scanner starting — ${symbols.length} symbols`);

  async function runScan() {
    try {
      // Open fresh WS for scanner
      if (scannerWs) try { scannerWs.close(); } catch {}
      const wsUrl   = await connectForMode(mode, token, appId);
      scannerWs     = await connectWebSocket(wsUrl);

      const granularities = [14400, 1800, 900];
      let fetched = 0;

      for (const symbol of symbols) {
        for (const gran of granularities) {
          const key = `${symbol}_${gran}`;
          try {
            const candles = await fetchCandles(scannerWs, symbol, gran, 200);
            if (candles.length > 10) {
              cache.set(key, { candles, fetchedAt: Date.now() });
              fetched++;
            }
            // Small delay to avoid rate limit
            await new Promise(r => setTimeout(r, 150));
          } catch (e) {
            console.warn(`[scanner] ${symbol} g=${gran}: ${e.message}`);
            await new Promise(r => setTimeout(r, 500));
          }
        }
      }

      console.log(`✅ [scanner] Refreshed ${fetched}/${symbols.length * 3} candle sets`);
      scannerWs.close();
    } catch (e) {
      console.error(`[scanner] Error:`, e.message);
    }
  }

  // Initial scan immediately
  await runScan();

  // Then scan on interval
  setInterval(runScan, SCAN_INTERVAL);
}

export function getCacheStats() {
  const now = Date.now();
  let fresh = 0, stale = 0;
  for (const v of cache.values()) {
    if (now - v.fetchedAt < CACHE_TTL) fresh++;
    else stale++;
  }
  return { total: cache.size, fresh, stale, pending: pending.size };
}

export function clearCache(symbol) {
  for (const key of cache.keys()) {
    if (key.startsWith(symbol)) cache.delete(key);
  }
}