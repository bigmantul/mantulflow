// ═══════════════════════════════════════════════════════
//  dashboard/db.js — MongoDB connection + all models
// ═══════════════════════════════════════════════════════

import mongoose from "mongoose";
import bcrypt   from "bcryptjs";

// ── CONNECT ───────────────────────────────────────────
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

  // Deriv credentials
  derivPAT:   { type: String, required: true },
  derivAppId: { type: String, required: true },
  derivMode:  { type: String, default: "demo" }, // "demo" or "real"

  // Telegram
  telegramChatId: { type: String, default: "" },

  // Bot state
  botActive: { type: Boolean, default: false },

  // Risk settings
  risk: {
    riskPct:              { type: Number, default: 0.10 },  // 10%
    maxOpenTrades:        { type: Number, default: 3 },
    maxDailyLossPct:      { type: Number, default: 0.30 },  // 30%
    maxConsecutiveLosses: { type: Number, default: 3 },
    stopLossPct:          { type: Number, default: 0.80 },  // 80%
    takeProfitPct:        { type: Number, default: 2.00 },  // 200%
  },

  createdAt: { type: Date, default: Date.now },
});

// Hash password before saving
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

// Compare password method
userSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

export const User = mongoose.model("User", userSchema);


// ── TRADE MODEL ───────────────────────────────────────
const tradeSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  symbol:     { type: String, required: true },
  direction:  { type: String, required: true }, // MULTUP / MULTDOWN
  stake:      { type: Number, required: true },
  multiplier: { type: Number, required: true },
  contractId: { type: String, required: true },
  buyPrice:   { type: Number, required: true },
  stopLoss:   { type: Number },
  takeProfit: { type: Number },
  strength:   { type: Number },
  status:     { type: String, default: "open" }, // open / won / lost / closed
  pnl:        { type: Number, default: 0 },
  openedAt:   { type: Date,   default: Date.now },
  closedAt:   { type: Date },
});

export const Trade = mongoose.model("Trade", tradeSchema);