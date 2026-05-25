// ═══════════════════════════════════════════════════════
//  dashboard/routes/user.js
// ═══════════════════════════════════════════════════════

import express     from "express";
import { protect } from "../middleware/protect.js";
import { User }    from "../db.js";
import { botManager } from "../bot-manager.js";
import { Trade }   from "../db.js";

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

    if (riskPct              !== undefined) user.risk.riskPct              = Math.min(Math.max(riskPct, 0.01), 0.50);
    if (maxOpenTrades        !== undefined) user.risk.maxOpenTrades        = Math.min(Math.max(maxOpenTrades, 1), 10);
    if (maxDailyLossPct      !== undefined) user.risk.maxDailyLossPct      = Math.min(Math.max(maxDailyLossPct, 0.05), 1.0);
    if (maxConsecutiveLosses !== undefined) user.risk.maxConsecutiveLosses = Math.min(Math.max(maxConsecutiveLosses, 1), 10);
    if (stopLossPct          !== undefined) user.risk.stopLossPct          = Math.min(Math.max(stopLossPct, 0.10), 2.0);
    if (takeProfitPct        !== undefined) user.risk.takeProfitPct        = Math.min(Math.max(takeProfitPct, 0.10), 10.0);

    await user.save();

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

    if (derivPAT)                    user.derivPAT       = derivPAT;
    if (derivAppId)                  user.derivAppId     = derivAppId;
    if (derivMode)                   user.derivMode      = derivMode;
    if (telegramChatId !== undefined) user.telegramChatId = telegramChatId;

    await user.save();

    if (user.botActive) {
      await botManager.restartUser(user._id.toString());
    }

    res.json({ message: "Settings updated" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── MANUAL SYNC TRADES ────────────────────────────────
// Forces an immediate check of all open trades against
// Deriv and closes any that are no longer active
router.post("/sync-trades", protect, async (req, res) => {
  try {
    const userId     = req.user._id;
    const openTrades = await Trade.find({ userId, status: "open" });

    if (!openTrades.length) {
      return res.json({ message: "No open trades to sync", synced: 0 });
    }

    // Get the user's bot instance WebSocket
    // If bot is running, use its connection — otherwise connect fresh
    const user = await User.findById(userId);
    const { connectForMode }    = await import("../src/auth/deriv-auth.js");
    const { connectWebSocket, sendMessage } = await import("../src/utils/ws-client.js");

    const wsUrl = await connectForMode(user.derivMode, user.derivPAT, user.derivAppId);
    const ws    = await connectWebSocket(wsUrl);

    // Get live portfolio
    const resp      = await sendMessage(ws, { portfolio: 1 }, "portfolio");
    const contracts = resp?.portfolio?.contracts ?? [];

    const activeIds = new Set();
    for (const c of contracts) {
      const status = String(c.status ?? "").toLowerCase();
      if (!["sold","closed","expired"].includes(status)) {
        activeIds.add(String(c.contract_id));
      }
    }

    let synced = 0;
    const results = [];

    for (const trade of openTrades) {
      if (activeIds.has(String(trade.contractId))) {
        results.push({ contractId: trade.contractId, action: "still open" });
        continue;
      }

      // Trade closed on Deriv — get final PnL
      try {
        const detail   = await sendMessage(ws, {
          proposal_open_contract: 1,
          contract_id: parseInt(trade.contractId),
        }, "proposal_open_contract");

        const contract = detail?.proposal_open_contract;
        const pnl      = contract ? parseFloat(contract.profit ?? 0) : 0;
        const status   = pnl > 0 ? "won" : "lost";

        await Trade.findByIdAndUpdate(trade._id, {
          status, pnl, closedAt: new Date(),
        });

        results.push({ contractId: trade.contractId, action: status, pnl });
        synced++;
      } catch {
        await Trade.findByIdAndUpdate(trade._id, {
          status: "closed", closedAt: new Date(),
        });
        results.push({ contractId: trade.contractId, action: "closed" });
        synced++;
      }
    }

    ws.close();
    res.json({ message: `Synced ${synced} trade(s)`, synced, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;