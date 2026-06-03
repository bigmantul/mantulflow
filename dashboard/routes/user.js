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
// IMPORTANT: Include derivPAT and derivAppId for WebSocket connection
router.get("/me", protect, async (req, res) => {
  try {
    // Only hide password — keep derivPAT for dashboard WebSocket
    const user = await User.findById(req.user._id).select("-password");
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

    if (derivPAT !== undefined)      user.derivPAT       = derivPAT;
    if (derivAppId !== undefined)    user.derivAppId     = derivAppId;
    if (derivMode !== undefined)     user.derivMode      = derivMode;
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
router.post("/sync-trades", protect, async (req, res) => {
  try {
    const userId = req.user._id;

    const openTrades = await Trade.find({
      userId,
      $or: [
        { status: "open" },
        { status: "closed", closedAt: null },
      ]
    });

    if (!openTrades.length) {
      const allTrades = await Trade.countDocuments({ userId });
      return res.json({
        message: allTrades > 0
          ? `No open trades found (${allTrades} total trades in DB — all already synced)`
          : "No trades in database yet",
        synced: 0,
        totalInDB: allTrades,
      });
    }

    const user = await User.findById(userId);
    const { connectForMode }    = await import("../../src/auth/deriv-auth.js");
    const { connectWebSocket, sendMessage } = await import("../../src/utils/ws-client.js");

    const wsUrl = await connectForMode(user.derivMode, user.derivPAT, user.derivAppId);
    const ws    = await connectWebSocket(wsUrl);

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

// ── IMPORT ALL TRADES FROM DERIV ─────────────────────
router.post("/import-trades", protect, async (req, res) => {
  try {
    const userId = req.user._id;
    const user   = await User.findById(userId);

    const { connectForMode }                 = await import("../../src/auth/deriv-auth.js");
    const { connectWebSocket, sendMessage }  = await import("../../src/utils/ws-client.js");

    const wsUrl = await connectForMode(user.derivMode, user.derivPAT, user.derivAppId);
    const ws    = await connectWebSocket(wsUrl);

    const resp      = await sendMessage(ws, { portfolio: 1 }, "portfolio");
    const contracts = resp?.portfolio?.contracts ?? [];

    let imported  = 0;
    let skipped   = 0;
    let updated   = 0;
    const results = [];

    for (const c of contracts) {
      const status = String(c.status ?? "").toLowerCase();

      if (["sold", "closed", "expired"].includes(status)) continue;

      const contractId = String(c.contract_id);

      let symbol = c.underlying || c.symbol || "";
      if (!symbol && c.shortcode) {
        const symbols = ["R_75","R_100","frxXAUUSD","frxXAGUSD","cryBTCUSD","cryETHUSD"];
        for (const s of symbols) {
          if (c.shortcode.includes(s)) { symbol = s; break; }
        }
      }

      let direction = "MULTUP";
      if (c.shortcode && c.shortcode.includes("MULTDOWN")) direction = "MULTDOWN";
      else if (c.contract_type) direction = c.contract_type;

      const stake      = parseFloat(c.buy_price ?? c.ask_price ?? 0);
      const buyPrice   = parseFloat(c.buy_price ?? 0);
      const multiplier = parseInt(c.multiplier ?? 100);
      const pnl        = parseFloat(c.profit ?? 0);

      const existing = await Trade.findOne({ userId, contractId });

      if (existing) {
        await Trade.findByIdAndUpdate(existing._id, { pnl, status: "open" });
        updated++;
        results.push({ contractId, symbol, action: "updated", pnl });
        continue;
      }

      try {
        await Trade.create({
          userId,
          symbol:     symbol || "unknown",
          direction,
          stake:      stake || 1,
          multiplier: multiplier || 100,
          contractId,
          buyPrice,
          stopLoss:   null,
          takeProfit: null,
          strength:   null,
          status:     "open",
          pnl,
          openedAt:   c.date_start ? new Date(c.date_start * 1000) : new Date(),
        });
        imported++;
        results.push({ contractId, symbol, direction, stake, action: "imported" });
      } catch (dbErr) {
        if (dbErr.message.includes("duplicate key")) {
          skipped++;
        } else {
          results.push({ contractId, action: "error", error: dbErr.message });
        }
      }
    }

    try {
      const histResp = await sendMessage(ws, {
        profit_table: 1,
        description:  1,
        limit:        100,
        offset:       0,
        sort:         "DESC",
      }, "profit_table");

      const history = histResp?.profit_table?.transactions ?? [];

      for (const c of history) {
        const contractId = String(c.contract_id);
        const existing   = await Trade.findOne({ userId, contractId });
        if (existing) continue;

        let symbol = c.underlying_symbol || c.symbol || "";
        if (!symbol && c.shortcode) {
          const symbols = ["R_75","R_100","frxXAUUSD","frxXAGUSD","cryBTCUSD","cryETHUSD"];
          for (const s of symbols) {
            if (c.shortcode.includes(s)) { symbol = s; break; }
          }
        }

        let direction = "MULTUP";
        if (c.shortcode && c.shortcode.includes("MULTDOWN")) direction = "MULTDOWN";
        else if (c.transaction_type) direction = c.transaction_type;

        const pnl        = parseFloat(c.profit_loss ?? c.sell_price - c.buy_price ?? 0);
        const finalStatus = pnl > 0 ? "won" : "lost";

        try {
          await Trade.create({
            userId,
            symbol:     symbol || "unknown",
            direction,
            stake:      parseFloat(c.buy_price ?? 1),
            multiplier: parseInt(c.multiplier ?? 100),
            contractId,
            buyPrice:   parseFloat(c.buy_price ?? 0),
            stopLoss:   null,
            takeProfit: null,
            strength:   null,
            status:     finalStatus,
            pnl,
            openedAt:   c.purchase_time ? new Date(c.purchase_time * 1000) : new Date(),
            closedAt:   c.sell_time     ? new Date(c.sell_time * 1000)     : new Date(),
          });
          imported++;
          results.push({ contractId, symbol, action: `imported (${finalStatus})` });
        } catch {
          skipped++;
        }
      }
    } catch (histErr) {
      console.log("History fetch failed:", histErr.message);
    }

    ws.close();

    res.json({
      message:  `Import complete — ${imported} imported, ${updated} updated, ${skipped} skipped`,
      imported,
      updated,
      skipped,
      results,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;