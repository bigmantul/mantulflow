// ═══════════════════════════════════════════════════════
//  src/risk/risk-manager.js
// ═══════════════════════════════════════════════════════

export class RiskManager {

  static MIN_STAKE     = 1.00;
  static MAX_STAKE_CAP = 1000;

  constructor({
    riskPct              = 10,
    maxDailyLossPct      = 30,
    maxOpenTrades        = 3,
    maxConsecutiveLosses = 3,
  } = {}) {
    this.riskPct              = riskPct;
    this.maxDailyLossPct      = maxDailyLossPct;
    this.maxOpen              = maxOpenTrades;
    this.maxConsecutiveLosses = maxConsecutiveLosses;
    this.minStake             = RiskManager.MIN_STAKE;
    this.openTrades           = 0;
    this.dailyPnl             = 0.0;
    this.consecutiveLosses    = 0;
    this.startingBalance      = null;
    this._lastResetDate       = this._todayStr();
  }

  _todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  setStartingBalance(balance) {
    this.startingBalance = balance;
    this._resetDailyState();
  }

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

  calculateStake(currentBalance) {
    this._checkDailyReset();
    const rawStake = currentBalance * this.riskPct;
    const stake    = Math.min(
      Math.max(rawStake, RiskManager.MIN_STAKE),
      RiskManager.MAX_STAKE_CAP
    );
    return parseFloat(stake.toFixed(2));
  }

  canTrade(currentBalance) {
    this._checkDailyReset();
    if (this.openTrades >= this.maxOpen) {
      console.log(`Risk block: max open trades (${this.maxOpen}) reached`);
      return false;
    }
    if (this.consecutiveLosses >= this.maxConsecutiveLosses) {
      console.log(`Risk block: ${this.consecutiveLosses} consecutive losses — cooling down`);
      return false;
    }
    if (this.startingBalance) {
      const dailyLossRatio = -this.dailyPnl / this.startingBalance;
      if (dailyLossRatio >= this.maxDailyLossPct) {
        console.log(`Risk block: daily loss ${(dailyLossRatio * 100).toFixed(1)}%`);
        return false;
      }
    }
    return true;
  }

  tradeOpened() { this.openTrades += 1; }

  tradeClosed(pnl) {
    this.openTrades = Math.max(0, this.openTrades - 1);
    this.dailyPnl  += pnl;
    if (pnl < 0) this.consecutiveLosses += 1;
    else         this.consecutiveLosses  = 0;
  }

  status() {
    return {
      openTrades:        this.openTrades,
      maxOpenTrades:     this.maxOpen,
      dailyPnl:          parseFloat(this.dailyPnl.toFixed(2)),
      consecutiveLosses: this.consecutiveLosses,
      startingBalance:   this.startingBalance,
      riskPct:           this.riskPct,
      minStake:          this.minStake,
    };
  }
}


// ── STOP LOSS / TAKE PROFIT ───────────────────────────
// Now accepts custom SL/TP percentages per user
export class StopLossTakeProfit {

  constructor({ slPct = 0.80, tpPct = 2.00 } = {}) {
    this.slPct = slPct;
    this.tpPct = tpPct;
  }

  getMultiplierLimitOrder(stake) {
    return {
      stop_loss:   parseFloat((stake * this.slPct).toFixed(2)),
      take_profit: parseFloat((stake * this.tpPct).toFixed(2)),
    };
  }
}