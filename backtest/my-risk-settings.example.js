// backtest/my-risk-settings.example.js
//
// Copy this to backtest/my-risk-settings.js (gitignored) and edit
// with your real dashboard values. run.js / run-all.js load it
// automatically if present.
//
// NOTE: as of the ATR-calibrated SL/TP change, production
// (dashboard/bot-manager.js) no longer uses stopLossPct/takeProfitPct
// at all — it computes SL/TP as a multiple of each symbol's own
// current ATR instead. The values below match what's actually live.
// backtest/engine.js (the original %-of-stake backtest engine) still
// accepts --sl/--tp as stake percentages for historical comparisons;
// backtest/engine-dailybias-sltp.js is the one that matches current
// production behavior (slAtrMult/tpAtrMult + trailing, no cutoff/duration).

export default {
  stakeAmount:          1.00,   // fixed dollar stake, matches dashboard "Stake Amount"

  // Live SL/TP basis — multiples of ATR, not % of stake. 0.75/1.5 (1:2
  // risk:reward) is what backtesting found independently in every
  // instrument category, not just in aggregate.
  slAtrMult:            0.75,
  tpAtrMult:            1.5,

  // PnL Lock — % of take-profit used as the trailing step size.
  // Validated across every rolling 90-day window and regime bucket;
  // 20% consistently beat 25% and no-trailing.
  trailingStopPct:      0.20,

  // Both OFF — ATR SL/TP + trailing are the only exits now, matching
  // exactly what was backtested. Residual risk: no time-based safety
  // net if a trade sits between SL and TP indefinitely.
  noProfitCutoffMins:   0,
  contractDurationMins: 0,
  cutoffCooldownHours:  2,      // irrelevant while noProfitCutoffMins is 0
};
