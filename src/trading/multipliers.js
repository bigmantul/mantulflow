// ═══════════════════════════════════════════════════════
//  src/trading/multipliers.js
//
//  Extracted out of trader.js so this plain data table can
//  be imported by non-runtime consumers (e.g. backtest/) 
//  without pulling in ws-client.js / deriv-auth.js and
//  their dependencies.
// ═══════════════════════════════════════════════════════

export const FALLBACK_MULTIPLIERS = {
  frxEURUSD: 100, frxGBPUSD: 100, frxUSDJPY: 100,
  frxUSDCHF: 100, frxAUDUSD: 100, frxUSDCAD: 100,
  frxNZDUSD: 100, frxGBPJPY: 80,
  frxEURGBP: 80, frxEURCHF: 80, frxEURCAD: 80, frxEURAUD: 80,
  frxXAUUSD: 60, frxXAGUSD: 60,
  cryBTCUSD: 40, cryETHUSD: 40,
  BOOM500: 30,   CRASH500: 30,
  JD75: 25,      JD100: 25,
  R_75: 25,      R_100: 20,
};
