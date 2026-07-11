// ═══════════════════════════════════════════════════════
//  dashboard/db.js — MongoDB connection + all models
// ═══════════════════════════════════════════════════════

import mongoose from "mongoose";
import bcrypt   from "bcryptjs";

export async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set in .env");
  await mongoose.connect(uri);
  console.log("✅ MongoDB connected");
}

// ── USER MODEL ────────────────────────────────────────
const userSchema = new mongoose.Schema({
  name:     { type: String, required: true },
  email:    { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  derivPAT:       { type: String, required: true },
  derivAppId:     { type: String, required: true },
  derivMode:      { type: String, default: "demo" },
  telegramChatId: { type: String, default: "" },
  botActive:      { type: Boolean, default: false },
  risk: {
    stakeAmount:          { type: Number, default: 1.00 },  // fixed dollar stake (min $1)
    maxOpenTrades:        { type: Number, default: 3 },
    maxDailyLossPct:      { type: Number, default: 0.30 },
    maxConsecutiveLosses: { type: Number, default: 3 },
    // stopLossPct/takeProfitPct are RETIRED from the live trading path as
    // of the ATR-calibrated SL/TP change — bot-manager.js no longer reads
    // them when opening a trade. Left in place (not deleted) only because
    // the dashboard settings form and admin route still reference them;
    // updating those is a separate frontend task. Do not rely on these
    // two fields to mean anything live anymore.
    stopLossPct:          { type: Number, default: 0.80 },
    takeProfitPct:        { type: Number, default: 2.00 },
    // ATR-calibrated SL/TP — the live fields as of this change. Distance
    // is `atrPct * multiplier` (in ATR units, not % of stake), so it
    // scales with each symbol's own current volatility instead of a flat
    // percentage. 0.75/1.5 (1:2 risk:reward) is what backtesting found
    // independently in every instrument category (forex, metals, crypto,
    // and each synthetic family separately) — not a single aggregate
    // number applied everywhere without checking.
    slAtrMult:            { type: Number, default: 0.75 },
    tpAtrMult:            { type: Number, default: 1.5 },
    // PnL Lock (field name kept as trailingStopPct for backward DB
    // compatibility — dashboard label/logs now say "PnL Lock"): % of
    // TAKE PROFIT used as the step size. Profit locks in discrete steps:
    // step 1 (peak >= 1 step) -> breakeven; step 2 -> locks step 1's
    // amount; step 3 -> locks step 2's amount; etc. Always one full step
    // behind peak (uses peak, not current PnL, so it only ratchets up).
    // Trade auto-closes (client-side sell, not contract_update) if profit
    // falls to/below the locked floor. Set to 0 to disable.
    // Default changed from 0.5 -> 0.20: backtested across every regime
    // and rolling 90-day window, 20% consistently beat 25% and no-trailing
    // (PF 6.14-7.16 across every window vs 2.98 with trailing off).
    trailingStopPct:      { type: Number, default: 0.20 },
    // No-profit cutoff: close a trade if it hasn't reached profit within
    // this many minutes of opening. Default OFF (0) — backtesting found
    // this cut off trades that would often have recovered by the time
    // ATR-based TP or the PnL-lock trailing floor was reached. Set > 0
    // to re-enable if you want it back.
    noProfitCutoffMins:   { type: Number, default: 0 },
    // Cooldown applied to a symbol after the no-profit cutoff fires —
    // blocks new entries on that symbol for this many hours. Irrelevant
    // while noProfitCutoffMins is 0 (cutoff never fires, so this never
    // triggers either). Left non-zero so it's ready if you re-enable the
    // cutoff above.
    cutoffCooldownHours:  { type: Number, default: 2 },
    // Forced contract close duration in minutes. Default OFF (0) — the
    // ATR-calibrated SL/TP + PnL-lock trailing are the only exits now,
    // matching exactly what was backtested (no time-based exit at all).
    // Residual risk worth knowing: with this off, a trade that sits
    // between SL and TP indefinitely has no time-based safety net. Set
    // > 0 if you want a hard ceiling back as a backstop.
    contractDurationMins: { type: Number, default: 0 },
  },
  createdAt: { type: Date, default: Date.now },
});

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

export const User = mongoose.model("User", userSchema);


// ── TRADE MODEL ───────────────────────────────────────
const tradeSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  symbol:     { type: String, required: true },
  direction:  { type: String, required: true },
  stake:      { type: Number, required: true },
  multiplier: { type: Number, required: true },
  contractId: { type: String, required: true, unique: true }, // prevent duplicate saves
  buyPrice:   { type: Number, required: true },
  stopLoss:   { type: Number },
  takeProfit: { type: Number },
  strength:   { type: Number },
  // PnL Lock tracking (field names kept for backward DB compatibility)
  trailingActive:  { type: Boolean, default: false },
  trailingPeakPnl: { type: Number, default: 0 }, // highest profit seen since lock activated
  pnlLockFloor:    { type: Number, default: 0 }, // current locked-profit floor — close if PnL falls to/below this
  forcedCloseDurationMins: { type: Number, default: 120 }, // snapshot of the duration timer setting AT trade-open, for accurate countdown display
  status:     { type: String, default: "open" },
  pnl:        { type: Number, default: null },  // null = not yet closed
  openedAt:   { type: Date, default: Date.now },
  closedAt:   { type: Date },
});

export const Trade = mongoose.model("Trade", tradeSchema);


// ── BOT LOG MODEL ─────────────────────────────────────
// Stores last 72 hours of bot logs per user
const botLogSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  message:   { type: String, required: true },
  level:     { type: String, default: "info" }, // info | trade | error | warn
  createdAt: { type: Date, default: Date.now },
});

botLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 266400 });

export const BotLog = mongoose.model("BotLog", botLogSchema);