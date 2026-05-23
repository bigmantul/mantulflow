// ═══════════════════════════════════════════════════════
//  src/risk/risk-manager.js
//
//  Converted from risk.py — logic is 1:1 identical
//
//  RiskManager:
//    - Position sizing (10% of balance, capped at $1)
//    - Max open trades guard
//    - Consecutive loss streak halt
//    - Daily loss limit halt
//    - Daily state auto-reset at midnight
//
//  StopLossTakeProfit:
//    - SL = 80% of stake  → $0.80 on $1 stake
//    - TP = 200% of stake → $2.00 on $1 stake
//    - Risk:Reward = 1:2.5
// ═══════════════════════════════════════════════════════

export class RiskManager {

  // ── DERIV HARD LIMITS ─────────────────────────────────
  static MIN_STAKE     = 10;     // Deriv minimum is $0.35 but we floor at $1.00
  static MAX_STAKE_CAP = 10;     // Hard cap — never risk more than $1 per trade

  /**
   * @param {number} riskPct              - 10% of balance per trade
   *                                        $10 → $1.00 (hits MAX_STAKE_CAP)
   *                                        $20 → $2.00 (still capped at $1.00)
   *                                        scales naturally as account grows
   * @param {number} maxDailyLossPct      - halt after 30% daily loss ($3.00 on $10)
   * @param {number} maxOpenTrades        - max 3 simultaneous trades
   * @param {number} maxConsecutiveLosses - halt after 3 losses in a row
   */
  constructor({
    riskPct              = 1000,
    maxDailyLossPct      = 30,
    maxOpenTrades        = 3,
    maxConsecutiveLosses = 3,
  } = {}) {
    this.riskPct              = riskPct;
    this.maxDailyLossPct      = maxDailyLossPct;
    this.maxOpen              = maxOpenTrades;
    this.maxConsecutiveLosses = maxConsecutiveLosses;

    // Exposed so index.js can use rm.minStake (matches rm.min_stake in Python)
    this.minStake = RiskManager.MIN_STAKE;

    this.openTrades        = 0;
    this.dailyPnl          = 0.0;
    this.consecutiveLosses = 0;
    this.startingBalance   = null;
    this._lastResetDate    = this._todayStr();
  }

  // ── DATE HELPER ───────────────────────────────────────
  // Equivalent to date.today() — returns "YYYY-MM-DD" string
  _todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  // ── INITIALIZATION ────────────────────────────────────
  // Equivalent to set_starting_balance()
  setStartingBalance(balance) {
    this.startingBalance = balance;
    this._resetDailyState();
  }

  // ── DAILY RESET ───────────────────────────────────────
  _resetDailyState() {
    this.dailyPnl          = 0.0;
    this.consecutiveLosses = 0;
    this._lastResetDate    = this._todayStr();
  }

  _checkDailyReset() {
    if (this._todayStr() > this._lastResetDate) {
      console.log("📅 New day — resetting daily PnL and loss streak.");
      this._resetDailyState();
    }
  }

  // ── POSITION SIZING ───────────────────────────────────
  /**
   * Risk 10% of balance, capped at MAX_STAKE_CAP.
   * Equivalent to calculate_stake()
   *
   * Examples:
   *   $10.00 → 10% = $1.00  (capped at $1.00) → $1.00
   *   $15.00 → 10% = $1.50  (capped at $1.00) → $1.00
   *   $50.00 → 10% = $5.00  (capped at $1.00) → $1.00
   *   $0.50  → too small    → MIN_STAKE $1.00
   *
   * Raise MAX_STAKE_CAP manually once confident in live performance.
   */
  calculateStake(currentBalance) {
    this._checkDailyReset();

    const rawStake = currentBalance * this.riskPct;

    // Clamp between floor and cap — same as Python's min(max(...))
    const stake = Math.min(
      Math.max(rawStake, RiskManager.MIN_STAKE),
      RiskManager.MAX_STAKE_CAP
    );

    return parseFloat(stake.toFixed(2));
  }

  // ── RISK CHECK ────────────────────────────────────────
  /**
   * Return true only if all risk conditions are satisfied.
   * Equivalent to can_trade()
   */
  canTrade(currentBalance) {
    this._checkDailyReset();

    // Too many open trades
    if (this.openTrades >= this.maxOpen) {
      console.log(`Risk block: max open trades (${this.maxOpen}) reached`);
      return false;
    }

    // Consecutive loss streak
    if (this.consecutiveLosses >= this.maxConsecutiveLosses) {
      console.log(`Risk block: ${this.consecutiveLosses} consecutive losses — cooling down`);
      return false;
    }

    // Daily loss limit
    if (this.startingBalance) {
      const dailyLossRatio = -this.dailyPnl / this.startingBalance;
      if (dailyLossRatio >= this.maxDailyLossPct) {
        console.log(
          `Risk block: daily loss ${(dailyLossRatio * 100).toFixed(1)}% ` +
          `>= limit ${(this.maxDailyLossPct * 100).toFixed(0)}%`
        );
        return false;
      }
    }

    return true;
  }

  // ── TRADE TRACKING ────────────────────────────────────
  // Equivalent to trade_opened()
  tradeOpened() {
    this.openTrades += 1;
  }

  // Equivalent to trade_closed()
  tradeClosed(pnl) {
    this.openTrades = Math.max(0, this.openTrades - 1);
    this.dailyPnl  += pnl;

    if (pnl < 0) {
      this.consecutiveLosses += 1;
    } else {
      this.consecutiveLosses = 0;
    }
  }

  // ── STATUS ────────────────────────────────────────────
  // Equivalent to status()
  status() {
    return {
      openTrades:        this.openTrades,
      maxOpenTrades:     this.maxOpen,
      dailyPnl:          parseFloat(this.dailyPnl.toFixed(2)),
      consecutiveLosses: this.consecutiveLosses,
      startingBalance:   this.startingBalance,
      riskPct:           this.riskPct,
      minStake:          this.minStake,
      maxStakeCap:       RiskManager.MAX_STAKE_CAP,
    };
  }
}


// ═══════════════════════════════════════════════════════
//  STOP LOSS / TAKE PROFIT
//  Equivalent to StopLossTakeProfit class in risk.py
// ═══════════════════════════════════════════════════════
export class StopLossTakeProfit {

  static SL_PCT = 0.80;   // Stop loss   = 80%  of stake → $0.80 on $1 stake
  static TP_PCT = 2.00;   // Take profit = 200% of stake → $2.00 on $1 stake
                           // Risk:Reward = 1:2.5  (win 1 covers 2.5 losses)

  /**
   * Returns a Deriv-compatible limit_order object.
   * Equivalent to get_multiplier_limit_order()
   *
   * @param {number} stake
   * @returns {{ stop_loss: number, take_profit: number }}
   */
  getMultiplierLimitOrder(stake) {
    return {
      stop_loss:   parseFloat((stake * StopLossTakeProfit.SL_PCT).toFixed(2)),
      take_profit: parseFloat((stake * StopLossTakeProfit.TP_PCT).toFixed(2)),
    };
  }
}