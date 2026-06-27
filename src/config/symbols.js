// ═══════════════════════════════════════════════════════
//  src/config/symbols.js
//
//  Single source of truth for the symbol list. Extracted
//  out of index.js so non-runtime consumers (backtest/)
//  can import it without pulling in ws-client/deriv-auth.
//  index.js imports SYMBOLS from here instead of declaring
//  its own copy — so this list can never drift out of sync
//  with what the live bot actually scans.
// ═══════════════════════════════════════════════════════

export const SYMBOLS = [
  // Forex
  "frxEURUSD",
  "frxGBPUSD",
  "frxUSDJPY",
  "frxUSDCHF",
  "frxAUDUSD",
  "frxUSDCAD",
  "frxNZDUSD",
  "frxGBPJPY",
  "frxEURGBP",
  "frxEURCHF",
  "frxEURCAD",
  "frxEURAUD",

  // Metals
  "frxXAUUSD",
  "frxXAGUSD",

  // Crypto
  "cryBTCUSD",
  "cryETHUSD",

  // Boom Indices
  "BOOM50",
  "BOOM500",
  "BOOM600",
  "BOOM900",
  "BOOM1000",

  // Crash Indices
  "CRASH50",
  "CRASH500",
  "CRASH600",
  "CRASH900",
  "CRASH1000",

  // Jump Indices
  "JD10",
  "JD25",
  "JD50",
  "JD75",
  "JD100",

  // Step Indices
  "STPRNG",
  "STPRNG2",
  "STPRNG3",
  "STPRNG4",
  "STPRNG5",

  // Volatility Indices
  "R_10",
  "R_25",
  "R_50",
  "R_75",
  "R_100",

  // 1Hz Volatility Indices
  "1HZ10V",
  "1HZ15V",
  "1HZ25V",
  "1HZ50V",
  "1HZ75V",
  "1HZ90V",
  "1HZ100V",
];
