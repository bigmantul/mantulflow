// ═══════════════════════════════════════════════════════
//  dashboard/routes/admin.js
//  All routes protected by admin middleware
//
//  GET  /api/admin/users         — all users list
//  GET  /api/admin/users/:id     — single user detail
//  GET  /api/admin/users/:id/trades — user's trades
//  PUT  /api/admin/users/:id/bot — start/stop user bot
//  DELETE /api/admin/users/:id   — remove user
//  GET  /api/admin/stats         — platform overview
// ═══════════════════════════════════════════════════════

import express      from "express";
import jwt          from "jsonwebtoken";
import { User, Trade } from "../db.js";
import { botManager }  from "../bot-manager.js";

const router = express.Router();

// ── ADMIN AUTH MIDDLEWARE ─────────────────────────────
// Separate from user auth — checks ADMIN_PASSWORD from env
function adminAuth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer "))
      return res.status(401).json({ error: "Not authorized" });

    const token   = header.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded.isAdmin)
      return res.status(403).json({ error: "Admin access required" });

    next();
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
  }
}

// ── ADMIN LOGIN ───────────────────────────────────────
router.post("/login", (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Wrong password" });
  }
  const token = jwt.sign({ isAdmin: true }, process.env.JWT_SECRET, { expiresIn: "1d" });
  res.json({ token });
});

// ── ALL USERS ─────────────────────────────────────────
router.get("/users", adminAuth, async (req, res) => {
  try {
    const users = await User.find().select("-password -derivPAT").sort({ createdAt: -1 });

    // Attach trade stats and running status to each user
    const enriched = await Promise.all(users.map(async (u) => {
      const trades  = await Trade.find({ userId: u._id });
      const closed  = trades.filter(t => t.status !== "open");
      const won     = closed.filter(t => t.pnl > 0);
      const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);

      return {
        ...u.toObject(),
        isRunning:   botManager.isRunning(u._id.toString()),
        tradeCount:  trades.length,
        openTrades:  trades.filter(t => t.status === "open").length,
        winRate:     closed.length ? parseFloat(((won.length / closed.length) * 100).toFixed(1)) : 0,
        totalPnl:    parseFloat(totalPnl.toFixed(2)),
      };
    }));

    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SINGLE USER DETAIL ────────────────────────────────
router.get("/users/:id", adminAuth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("-password -derivPAT");
    if (!user) return res.status(404).json({ error: "User not found" });

    const trades   = await Trade.find({ userId: user._id }).sort({ openedAt: -1 }).limit(100);
    const closed   = trades.filter(t => t.status !== "open");
    const won      = closed.filter(t => t.pnl > 0);
    const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);

    res.json({
      user: { ...user.toObject(), isRunning: botManager.isRunning(user._id.toString()) },
      stats: {
        total:    trades.length,
        open:     trades.filter(t => t.status === "open").length,
        won:      won.length,
        lost:     closed.length - won.length,
        winRate:  closed.length ? parseFloat(((won.length / closed.length) * 100).toFixed(1)) : 0,
        totalPnl: parseFloat(totalPnl.toFixed(2)),
      },
      trades,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── USER TRADES ───────────────────────────────────────
router.get("/users/:id/trades", adminAuth, async (req, res) => {
  try {
    const trades = await Trade.find({ userId: req.params.id }).sort({ openedAt: -1 });
    res.json(trades);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── START / STOP USER BOT ─────────────────────────────
router.put("/users/:id/bot", adminAuth, async (req, res) => {
  try {
    const { active } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (active) {
      await botManager.startUser(user);
      user.botActive = true;
    } else {
      await botManager.stopUser(user._id.toString());
      user.botActive = false;
    }

    await user.save();
    res.json({ message: active ? "Bot started" : "Bot stopped", botActive: user.botActive });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE USER ───────────────────────────────────────
router.delete("/users/:id", adminAuth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Stop their bot first
    await botManager.stopUser(user._id.toString());

    // Delete their trades and account
    await Trade.deleteMany({ userId: user._id });
    await User.findByIdAndDelete(user._id);

    res.json({ message: "User deleted" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PLATFORM STATS ────────────────────────────────────
router.get("/stats", adminAuth, async (req, res) => {
  try {
    const totalUsers   = await User.countDocuments();
    const activeUsers  = await User.countDocuments({ botActive: true });
    const totalTrades  = await Trade.countDocuments();
    const openTrades   = await Trade.countDocuments({ status: "open" });
    const closedTrades = await Trade.find({ status: { $ne: "open" } });
    const wonTrades    = closedTrades.filter(t => t.pnl > 0);
    const totalPnl     = closedTrades.reduce((s, t) => s + t.pnl, 0);
    const winRate      = closedTrades.length
      ? parseFloat(((wonTrades.length / closedTrades.length) * 100).toFixed(1))
      : 0;

    res.json({
      totalUsers,
      activeUsers,
      runningBots:  botManager.runningCount(),
      totalTrades,
      openTrades,
      wonTrades:    wonTrades.length,
      lostTrades:   closedTrades.length - wonTrades.length,
      winRate,
      totalPnl:     parseFloat(totalPnl.toFixed(2)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;