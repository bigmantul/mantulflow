// ═══════════════════════════════════════════════════════
//  src/trading/multipliers.js
//
//  Extracted out of trader.js so this plain data table can
//  be imported by non-runtime consumers (e.g. backtest/)
//  without pulling in ws-client.js / deriv-auth.js and
//  their dependencies.
//
//  MULTIPLIER_LADDERS: each symbol's ascending list of
//  typical Deriv multiplier options, smallest first. A
//  LOWER multiplier means LESS leverage, which means a
//  HIGHER stake ceiling for the same account/exposure —
//  the two move in opposite directions. That's exactly
//  why BOOM1000 kept rejecting a plain $10 stake: it was
//  starting from a guessed HIGH multiplier (100), which
//  gave it the LOWEST possible stake ceiling of any rung
//  on its ladder.
//
//  FALLBACK_MULTIPLIERS is derived automatically as the
//  SMALLEST rung of each ladder — so a fresh/uncached
//  symbol always starts at the least aggressive leverage
//  option, maximizing the chance a normal stake just goes
//  through on the very first attempt.
//
//  If Deriv still rejects that starting value as an invalid
//  multiplier for the symbol (not a stake-cap error — an
//  actual "this multiplier isn't offered" error), trader.js's
//  existing auto-learn logic reads Deriv's own reported list
//  of accepted values and picks the SMALLEST one from THAT
//  list too — so the "start smallest, climb only if forced to"
//  behavior holds at every step, not just the first guess.
//
//  These ladders are still best-effort, not verified live
//  against Deriv — but even a wrong guess just costs one
//  extra learning round-trip, same as before.
// ═══════════════════════════════════════════════════════

export const MULTIPLIER_LADDERS = {
  // ── Forex majors ──
  frxEURUSD: [10, 20, 30, 50, 100], frxGBPUSD: [10, 20, 30, 50, 100],
  frxUSDJPY: [10, 20, 30, 50, 100], frxUSDCHF: [10, 20, 30, 50, 100],
  frxAUDUSD: [10, 20, 30, 50, 100], frxUSDCAD: [10, 20, 30, 50, 100],
  frxNZDUSD: [10, 20, 30, 50, 100],

  // ── Forex crosses ──
  frxGBPJPY: [10, 20, 30, 50, 80], frxEURGBP: [10, 20, 30, 50, 80],
  frxEURCHF: [10, 20, 30, 50, 80], frxEURCAD: [10, 20, 30, 50, 80],
  frxEURAUD: [10, 20, 30, 50, 80],

  // ── Metals ──
  frxXAUUSD: [10, 20, 30, 60], frxXAGUSD: [10, 20, 30, 60],

  // ── Crypto ──
  cryBTCUSD: [5, 10, 20, 40], cryETHUSD: [5, 10, 20, 40],

  // ── Boom Indices ──
  BOOM50:   [5, 10, 20],
  BOOM500:  [5, 10, 20, 30], BOOM600: [5, 10, 20, 30],
  BOOM900:  [5, 10, 20, 30], BOOM1000: [5, 10, 20, 30],

  // ── Crash Indices ──
  CRASH50:  [5, 10, 20],
  CRASH500: [5, 10, 20, 30], CRASH600: [5, 10, 20, 30],
  CRASH900: [5, 10, 20, 30], CRASH1000: [5, 10, 20, 30],

  // ── Jump Indices ──
  JD10: [10, 20, 30, 50], JD25: [10, 20, 30, 40],
  JD50: [10, 20, 30],     JD75: [5, 10, 20, 25],
  JD100: [5, 10, 20, 25],

  // ── Step Indices ──
  STPRNG:  [10, 20, 30, 50], STPRNG2: [10, 20, 30, 50],
  STPRNG3: [10, 20, 30, 50], STPRNG4: [10, 20, 30, 50],
  STPRNG5: [10, 20, 30, 50],

  // ── Volatility Indices ──
  R_10: [10, 20, 50, 100], R_25: [10, 20, 50],
  R_50: [10, 20, 30],      R_75: [5, 10, 20, 25],
  R_100: [5, 10, 20],

  // ── 1Hz Volatility Indices ──
  "1HZ10V": [10, 20, 50, 100], "1HZ15V": [10, 20, 50, 90],
  "1HZ25V": [10, 20, 50],      "1HZ50V": [10, 20, 30],
  "1HZ75V": [5, 10, 20, 25],   "1HZ90V": [5, 10, 20],
  "1HZ100V": [5, 10, 20],
};

export const FALLBACK_MULTIPLIERS = Object.fromEntries(
  Object.entries(MULTIPLIER_LADDERS).map(([symbol, ladder]) => [symbol, ladder[0]])
);
