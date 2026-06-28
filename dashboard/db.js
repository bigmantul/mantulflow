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
    stopLossPct:          { type: Number, default: 0.80 },
    takeProfitPct:        { type: Number, default: 2.00 },
    // PnL Lock (field name kept as trailingStopPct for backward DB
    // compatibility — dashboard label/logs now say "PnL Lock"): % of
    // TAKE PROFIT that must be reached before the lock activates (e.g.
    // 0.5 = 50% of TP). Once activated, locks in that same % of PEAK
    // profit reached so far, ratcheting up only. Trade auto-closes
    // (client-side sell, not contract_update) if profit falls to/below
    // the locked floor. Default 50%. Set to 0 to disable entirely.
    trailingStopPct:      { type: Number, default: 0.5 },
    // Forced contract close duration in minutes. null = OFF (no forced close,
    // only SL/TP/trailing stop closes the trade). No min/max enforced.
    contractDurationMins: { type: Number, default: 120 },
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