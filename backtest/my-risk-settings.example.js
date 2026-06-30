// ═══════════════════════════════════════════════════════
//  backtest/my-risk-settings.example.js
//
//  Copy this file to backtest/my-risk-settings.js (that
//  exact filename is gitignored, so your personal numbers
//  never get committed) and edit the values to match
//  whatever you've set on your live dashboard.
//
//  run-all.js and run.js will both automatically load
//  backtest/my-risk-settings.js if it exists, and use these
//  values as the defaults — so you don't have to retype
//  --equity= --risk= --trailing= --duration= every time.
//
//  CLI flags still override these if you pass them
//  explicitly, e.g.:
//    node backtest/run-all.js --trailing=0.3
//  uses YOUR file for everything except trailing, which
//  becomes 0.3 just for that one run.
//
//  These map 1:1 to the fields in dashboard/db.js's User
//  schema risk{} object — copy your real dashboard values
//  here to backtest with YOUR actual settings, not the
//  schema's generic defaults.
// ═══════════════════════════════════════════════════════

export default {
  // Starting equity per symbol for the backtest. This is NOT
  // your real account balance — each symbol is modeled
  // independently with this much starting capital, so results
  // are comparable across symbols regardless of order scanned.
  equity: 1000,

  // riskPct: NOTE this is backtest-only and does NOT map to
  // any single dashboard field — your live bot uses a FIXED
  // dollar stakeAmount (see below), not a % of equity. This
  // riskPct is kept for backward-compat default sizing if you
  // ever want to test % based position sizing instead of fixed
  // stake. For a true 1:1 match to your dashboard, prefer
  // setting stakeAmount below and ignoring riskPct.
  risk: 0.02,

  // ── These map directly to dashboard/db.js's risk{} schema ──
  // Copy your actual values from the dashboard's Risk Settings
  // panel here:

  stakeAmount:          1.00,   // matches db.js: risk.stakeAmount
  stopLossPct:          0.80,   // matches db.js: risk.stopLossPct
  takeProfitPct:        2.00,   // matches db.js: risk.takeProfitPct
  trailingStopPct:      0.50,   // matches db.js: risk.trailingStopPct (50% of TP)
  contractDurationMins: 120,    // matches db.js: risk.contractDurationMins (0 = OFF)
  maxOpenTrades:        3,      // matches db.js: risk.maxOpenTrades (engine.js currently
                                 // backtests ONE symbol at a time independently, so this
                                 // isn't applied per-run yet — kept here for reference /
                                 // future use if the engine adds shared-portfolio mode)
  maxConsecutiveLosses: 3,      // matches db.js: risk.maxConsecutiveLosses
  maxDailyLossPct:      0.30,   // matches db.js: risk.maxDailyLossPct
};
