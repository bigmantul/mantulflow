// ═══════════════════════════════════════════════════════
//  src/trading/portfolio.js
//
//  Tracks open trades from Deriv portfolio API.
//  Fixes:
//   - Counts ALL open contracts (not just known symbols)
//     so rm.openTrades reflects reality
//   - Extracts symbols from shortcode for multiplier contracts
//     e.g. "MULTUP_R_100_..." → "R_100"
//   - Exposes getOpenCount() so index.js can block trading
//     when max open trades is reached
// ═══════════════════════════════════════════════════════

import { sendMessage } from "../utils/ws-client.js";

let activeSymbols = new Set();  // symbols with open trades
let openCount     = 0;          // total open contract count
let SYMBOLS       = [];

export function initPortfolio(symbols) {
  SYMBOLS = symbols;
}

export function getActiveSymbols() {
  return activeSymbols;
}

export function getOpenCount() {
  return openCount;
}

export function lockSymbol(symbol) {
  activeSymbols.add(symbol);
  openCount = activeSymbols.size;
}

export function unlockSymbol(symbol) {
  activeSymbols.delete(symbol);
  openCount = activeSymbols.size;
}

/**
 * Extract which known symbol a contract belongs to.
 * Checks "underlying", "symbol", and "shortcode" fields.
 * Multiplier shortcodes look like: "MULTUP_R_100_1.82_..."
 * so we scan for any known symbol substring inside them.
 */
function extractSymbol(contract) {
  for (const field of ["underlying", "symbol", "shortcode", "underlying_symbol"]) {
    const val = String(contract[field] ?? "");
    for (const sym of SYMBOLS) {
      if (val.includes(sym)) return sym;
    }
  }
  return null;
}

/**
 * Fetch live portfolio from Deriv and rebuild activeSymbols.
 * Returns total number of open contracts.
 *
 * This is the source of truth — called every cycle so the bot
 * always knows how many trades are actually open on Deriv's side,
 * even if a trade was stopped out server-side without the bot knowing.
 */
export async function syncActiveSymbols(ws) {
  try {
    const resp      = await sendMessage(ws, { portfolio: 1 }, "portfolio");
    const contracts = resp?.portfolio?.contracts ?? [];

    const activeNow = new Set();
    let   totalOpen = 0;

    for (const c of contracts) {
      const status = String(c.status ?? "").toLowerCase();

      // Skip already closed contracts
      if (["sold", "closed", "expired"].includes(status)) continue;

      totalOpen++;

      const sym = extractSymbol(c);
      if (sym) activeNow.add(sym);
    }

    // Update module state
    activeSymbols = activeNow;
    openCount     = totalOpen;  // use raw contract count, not just symbol count
                                // (handles multiple contracts on same symbol)

    console.log(
      `Portfolio: ${contracts.length} contracts | ` +
      `${totalOpen} open | ` +
      `Locked symbols: ${activeNow.size ? [...activeNow].sort().join(", ") : "none"}`
    );

    return totalOpen;

  } catch (e) {
    console.error("Portfolio error:", e.message);
    return openCount; // return last known count on error, don't reset to 0
  }
}