// ═══════════════════════════════════════════════════════
//  dashboard/routes/user.js
//  GET  /api/user/me         — get profile
//  PUT  /api/user/risk       — update risk settings
//  PUT  /api/user/bot        — start / stop bot
//  PUT  /api/user/settings   — update deriv credentials
// ═══════════════════════════════════════════════════════

import express     from "express";
import { protect } from "../middleware/protect.js";
import { User }    from "../db.js";
import { botManager } from "../bot-manager.js";

const router = express.Router();

// ── GET PROFILE ───────────────────────────────────────
router.get("/me", protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("-password -derivPAT");
    res.json(user);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── UPDATE RISK SETTINGS ──────────────────────────────
router.put("/risk", protect, async (req, res) => {
  try {
    const {
      riskPct, maxOpenTrades, maxDailyLossPct,
      maxConsecutiveLosses, stopLossPct, takeProfitPct,
    } = req.body;

    const user = await User.findById(req.user._id);

    // Validate ranges
    if (riskPct              !== undefined) user.risk.riskPct              = Math.min(Math.max(riskPct, 0.01), 0.50);
    if (maxOpenTrades        !== undefined) user.risk.maxOpenTrades        = Math.min(Math.max(maxOpenTrades, 1), 10);
    if (maxDailyLossPct      !== undefined) user.risk.maxDailyLossPct      = Math.min(Math.max(maxDailyLossPct, 0.05), 1.0);
    if (maxConsecutiveLosses !== undefined) user.risk.maxConsecutiveLosses = Math.min(Math.max(maxConsecutiveLosses, 1), 10);
    if (stopLossPct          !== undefined) user.risk.stopLossPct          = Math.min(Math.max(stopLossPct, 0.10), 2.0);
    if (takeProfitPct        !== undefined) user.risk.takeProfitPct        = Math.min(Math.max(takeProfitPct, 0.10), 10.0);

    await user.save();

    // Restart bot with new settings if running
    if (user.botActive) {
      await botManager.restartUser(user._id.toString());
    }

    res.json({ message: "Risk settings updated", risk: user.risk });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── START / STOP BOT ──────────────────────────────────
router.put("/bot", protect, async (req, res) => {
  try {
    const { active } = req.body;
    const user = await User.findById(req.user._id);

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

// ── UPDATE DERIV SETTINGS ─────────────────────────────
router.put("/settings", protect, async (req, res) => {
  try {
    const { derivPAT, derivAppId, derivMode, telegramChatId } = req.body;
    const user = await User.findById(req.user._id);

    if (derivPAT)       user.derivPAT       = derivPAT;
    if (derivAppId)     user.derivAppId     = derivAppId;
    if (derivMode)      user.derivMode      = derivMode;
    if (telegramChatId !== undefined) user.telegramChatId = telegramChatId;

    await user.save();

    // Restart bot with new credentials if running
    if (user.botActive) {
      await botManager.restartUser(user._id.toString());
    }

    res.json({ message: "Settings updated" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;