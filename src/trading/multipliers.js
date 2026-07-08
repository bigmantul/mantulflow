// ═══════════════════════════════════════════════════════
//  src/trading/multipliers.js
//
//  Extracted out of trader.js so this plain data table can
//  be imported by non-runtime consumers (e.g. backtest/)
//  without pulling in ws-client.js / deriv-auth.js and
//  their dependencies.
//
//  Every symbol in src/config/symbols.js now has an explicit
//  entry here — nothing falls through to the old blanket
//  `?? 50` default anymore. That default was the root cause
//  of the BOOM1000 stake-cap issue: 50 was never actually
//  verified against Deriv, so on symbols where 50 was too
//  aggressive, EVERY user hit the same rejection until the
//  bot's auto-learn-from-error logic (still intact, see
//  trader.js) happened to correct it.
//
//  These are still best-effort starting points grouped by
//  volatility/leverage class, NOT guaranteed-exact Deriv
//  limits — the existing auto-learn retry logic in
//  trader.js will still correct any of these on the fly if
//  Deriv rejects a specific value, same as before. The goal
//  here is just to start every symbol from a sane,
//  conservative guess instead of a single guessed number
//  applied uniformly to everything.
// ═══════════════════════════════════════════════════════

export const FALLBACK_MULTIPLIERS = {
  // ── Forex majors ── highest liquidity, highest leverage allowed
  frxEURUSD: 100, frxGBPUSD: 100, frxUSDJPY: 100,
  frxUSDCHF: 100, frxAUDUSD: 100, frxUSDCAD: 100,
  frxNZDUSD: 100,

  // ── Forex crosses ── slightly less liquid than majors
  frxGBPJPY: 80, frxEURGBP: 80, frxEURCHF: 80,
  frxEURCAD: 80, frxEURAUD: 80,

  // ── Metals ──
  frxXAUUSD: 60, frxXAGUSD: 60,

  // ── Crypto ──
  cryBTCUSD: 40, cryETHUSD: 40,

  // ── Boom Indices ── lower spike-size number = more frequent
  // spikes = more volatile = lower multiplier
  BOOM50:  20, BOOM500: 30, BOOM600: 30, BOOM900: 30, BOOM1000: 30,

  // ── Crash Indices ── same reasoning as Boom
  CRASH50: 20, CRASH500: 30, CRASH600: 30, CRASH900: 30, CRASH1000: 30,

  // ── Jump Indices ── higher number = higher volatility = lower multiplier
  JD10: 50, JD25: 40, JD50: 30, JD75: 25, JD100: 25,

  // ── Step Indices ── fixed small steps, low volatility, higher
  // multiplier tolerated
  STPRNG: 50, STPRNG2: 50, STPRNG3: 50, STPRNG4: 50, STPRNG5: 50,

  // ── Volatility Indices ── higher number = higher volatility = lower multiplier
  R_10: 100, R_25: 50, R_50: 30, R_75: 25, R_100: 20,

  // ── 1Hz Volatility Indices ── same family/pattern as above
  "1HZ10V": 100, "1HZ15V": 90, "1HZ25V": 50,
  "1HZ50V": 30,  "1HZ75V": 25, "1HZ90V": 20, "1HZ100V": 20,
};
