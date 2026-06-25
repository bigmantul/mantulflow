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
//  Timeframes cached (Daily Bias Strategy):
//    D1 (86400) — daily bias detection
//    H1 (3600)  — 1H confluence check
//    M15 (900)  — entry confirmation
//
//  NOTE ON TTL: Daily candles only change once per day, so
//  re-fetching them every 90s like 15M candles would be
//  wasteful and pointless. Each granularity now has its
//  own TTL — D1 refreshes every 30 minutes (plenty fast
//  to catch a new daily candle forming), H1/M15 keep the
//  original fast refresh for timely entries.
// ═══════════════════════════════════════════════════════

import { sendMessage, connectWebSocket } from "../utils/ws-client.js";
import { connectForMode }                from "../auth/deriv-auth.js";

// Per-granularity cache TTLs (ms)
const TTL_BY_GRANULARITY = {
  86400: 30 * 60 * 1000,  // D1  — refresh every 30 min, plenty for daily bias
  3600:  90 * 1000,        // H1  — refresh every 90s
  900:   90 * 1000,        // M15 — refresh every 90s
};
const DEFAULT_TTL = 90 * 1000;

const SCAN_INTERVAL = 85 * 1000;  // scanner loop runs every 85s

const cache   = new Map(); // symbol+gran → { candles, fetchedAt }
const pending = new Map(); // symbol+gran → Promise (dedup concurrent requests)

let scannerRunning = false;
let scannerWs      = null;

// All timeframes needed by the Daily Bias strategy
const GRANULARITIES = [86400, 3600, 900];

function ttlFor(granularity) {
  return TTL_BY_GRANULARITY[granularity] ?? DEFAULT_TTL;
}

// ── PUBLIC API ────────────────────────────────────────

/**
 * Get all 3 timeframes for a symbol (Daily Bias strategy).
 * Returns from cache if fresh — never waits for API.
 * Falls back to direct fetch only if cache is empty.
 */
export async function getCachedMultiTf(ws, symbol) {
  const d1  = await getCachedCandles(ws, symbol, 86400, 60);
  const h1  = await getCachedCandles(ws, symbol, 3600,  200);
  const m15 = await getCachedCandles(ws, symbol, 900,   200);
  return { d1, h1, m15 };
}

/**
 * Get cached candles for one symbol+granularity.
 * Uses shared cache — only fetches if cache is stale/empty.
 * Each granularity has its own TTL (see TTL_BY_GRANULARITY).
 */
export async function getCachedCandles(ws, symbol, granularity, count = 200) {
  const key    = `${symbol}_${granularity}`;
  const now    = Date.now();
  const cached = cache.get(key);
  const ttl    = ttlFor(granularity);

  // Return fresh cache immediately
  if (cached && cached.candles.length > 10 && (now - cached.fetchedAt) < ttl) {
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
 * D1 candles are skipped on scan cycles where they're still
 * fresh (per TTL_BY_GRANULARITY), saving API calls — there's
 * no point re-fetching the daily candle every 85 seconds.
 *
 * @param {string[]} symbols  - full symbol list
 * @param {string}   token    - any valid PAT token (for candle access)
 * @param {string}   appId    - Deriv App ID
 * @param {string}   mode     - "demo" or "real"
 */
export async function startGlobalScanner(symbols, token, appId, mode = "demo") {
  if (scannerRunning) return;
  scannerRunning = true;
  console.log(`🔭 Global candle scanner starting — ${symbols.length} symbols × ${GRANULARITIES.length} TFs (D1/H1/M15)`);

  async function runScan() {
    try {
      // Open fresh WS for scanner
      if (scannerWs) try { scannerWs.close(); } catch {}
      const wsUrl   = await connectForMode(mode, token, appId);
      scannerWs     = await connectWebSocket(wsUrl);

      let fetched = 0;
      let skipped = 0;

      for (const symbol of symbols) {
        for (const gran of GRANULARITIES) {
          const key    = `${symbol}_${gran}`;
          const cached = cache.get(key);
          const ttl    = ttlFor(gran);

          // Skip if still fresh per this granularity's TTL (mainly D1)
          if (cached && (Date.now() - cached.fetchedAt) < ttl) {
            skipped++;
            continue;
          }

          try {
            const count = gran === 86400 ? 60 : 200;
            const candles = await fetchCandles(scannerWs, symbol, gran, count);
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

      console.log(`✅ [scanner] Refreshed ${fetched} candle sets (${skipped} skipped — still fresh, mostly D1)`);
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
  for (const [key, v] of cache.entries()) {
    const gran = parseInt(key.split("_").pop());
    const ttl  = ttlFor(gran);
    if (now - v.fetchedAt < ttl) fresh++;
    else stale++;
  }
  return { total: cache.size, fresh, stale, pending: pending.size };
}

export function clearCache(symbol) {
  for (const key of cache.keys()) {
    if (key.startsWith(symbol)) cache.delete(key);
  }
}