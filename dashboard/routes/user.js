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
      stakeAmount, maxOpenTrades, maxDailyLossPct,
      maxConsecutiveLosses, stopLossPct, takeProfitPct,
      trailingStopPct, contractDurationMins,
    } = req.body;

    const user = await User.findById(req.user._id);

    // stakeAmount: fixed dollar amount, minimum $1
    if (stakeAmount          !== undefined) user.risk.stakeAmount          = Math.max(parseFloat(stakeAmount), 1.00);
    if (maxOpenTrades        !== undefined) user.risk.maxOpenTrades        = Math.min(Math.max(maxOpenTrades, 1), 10);
    if (maxDailyLossPct      !== undefined) user.risk.maxDailyLossPct      = Math.min(Math.max(maxDailyLossPct, 0.05), 1.0);
    if (maxConsecutiveLosses !== undefined) user.risk.maxConsecutiveLosses = Math.min(Math.max(maxConsecutiveLosses, 1), 10);
    if (stopLossPct          !== undefined) user.risk.stopLossPct          = Math.min(Math.max(stopLossPct, 0.10), 2.0);
    if (takeProfitPct        !== undefined) user.risk.takeProfitPct        = Math.min(Math.max(takeProfitPct, 0.10), 10.0);

    // trailingStopPct: % of stake profit that activates trailing stop.
    // 0 = disabled. Bounded 0–1.0 (0%–100% of stake) — sane safety range.
    if (trailingStopPct      !== undefined) user.risk.trailingStopPct      = Math.min(Math.max(parseFloat(trailingStopPct), 0), 1.0);

    // contractDurationMins: forced close duration in minutes.
    // 0 or null = OFF (no forced close — only SL/TP/trailing closes the trade).
    // NO minimum or maximum enforced — user's explicit choice.
    if (contractDurationMins !== undefined) {
      user.risk.contractDurationMins = contractDurationMins === null || contractDurationMins === ""
        ? 0
        : parseFloat(contractDurationMins);
    }

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

// ── GET LIVE BALANCE ─────────────────────────────────
// Fetches real balance from Deriv using stored PAT token
// PAT never sent to browser — fetched server-side
router.get("/balance", protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user.derivPAT) {
      return res.json({ balance: null, error: "No PAT token set" });
    }

    const { connectForMode }                 = await import("../../src/auth/deriv-auth.js");
    const { connectWebSocket, sendMessage }  = await import("../../src/utils/ws-client.js");

    const wsUrl = await connectForMode(user.derivMode, user.derivPAT, user.derivAppId);
    const ws    = await connectWebSocket(wsUrl);

    const resp    = await sendMessage(ws, { balance: 1 }, "balance");
    const balance = parseFloat(resp.balance.balance);
    const currency = resp.balance.currency || "USD";
    ws.close();

    res.json({ balance, currency, mode: user.derivMode });
  } catch (e) {
    res.status(500).json({ balance: null, error: e.message });
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
    const userId = req.user._id;

    // Find ALL trades that could be open — status "open" or pnl=0 with no closedAt
    const openTrades = await Trade.find({
      userId,
      $or: [
        { status: "open" },
        { status: "closed", closedAt: null },
      ]
    });

    if (!openTrades.length) {
      // Double check — count all trades for this user
      const allTrades = await Trade.countDocuments({ userId });
      return res.json({
        message: allTrades > 0
          ? `No open trades found (${allTrades} total trades in DB — all already synced)`
          : "No trades in database yet",
        synced: 0,
        totalInDB: allTrades,
      });
    }

    // Get the user's bot instance WebSocket
    // If bot is running, use its connection — otherwise connect fresh
    const user = await User.findById(userId);
    const { connectForMode }    = await import("../../src/auth/deriv-auth.js");
    const { connectWebSocket, sendMessage } = await import("../../src/utils/ws-client.js");

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

// ── IMPORT ALL TRADES FROM DERIV ─────────────────────
// Pulls ALL open contracts from Deriv portfolio and saves
// them to MongoDB — works for trades opened before dashboard
// was deployed or opened manually on the Deriv app
router.post("/import-trades", protect, async (req, res) => {
  try {
    const userId = req.user._id;
    const user   = await User.findById(userId);

    const { connectForMode }                 = await import("../../src/auth/deriv-auth.js");
    const { connectWebSocket, sendMessage }  = await import("../../src/utils/ws-client.js");

    // Connect to Deriv
    const wsUrl = await connectForMode(user.derivMode, user.derivPAT, user.derivAppId);
    const ws    = await connectWebSocket(wsUrl);

    // Get full portfolio from Deriv
    const resp      = await sendMessage(ws, { portfolio: 1 }, "portfolio");
    const contracts = resp?.portfolio?.contracts ?? [];

    let imported  = 0;
    let skipped   = 0;
    let updated   = 0;
    const results = [];

    for (const c of contracts) {
      const status = String(c.status ?? "").toLowerCase();

      // Skip already closed contracts
      if (["sold", "closed", "expired"].includes(status)) continue;

      const contractId = String(c.contract_id);

      // Detect symbol from shortcode/underlying
      let symbol = c.underlying || c.symbol || "";
      if (!symbol && c.shortcode) {
        // Parse from shortcode e.g. "MULTUP_R_100_1.82_..."
        const symbols = ["R_75","R_100","frxXAUUSD","frxXAGUSD","cryBTCUSD","cryETHUSD"];
        for (const s of symbols) {
          if (c.shortcode.includes(s)) { symbol = s; break; }
        }
      }

      // Detect direction
      let direction = "MULTUP";
      if (c.shortcode && c.shortcode.includes("MULTDOWN")) direction = "MULTDOWN";
      else if (c.contract_type) direction = c.contract_type;

      const stake      = parseFloat(c.buy_price ?? c.ask_price ?? 0);
      const buyPrice   = parseFloat(c.buy_price ?? 0);
      const multiplier = parseInt(c.multiplier ?? 100);
      const pnl        = parseFloat(c.profit ?? 0);

      // Check if already in DB
      const existing = await Trade.findOne({ userId, contractId });

      if (existing) {
        // Update PnL if already imported
        await Trade.findByIdAndUpdate(existing._id, { pnl, status: "open" });
        updated++;
        results.push({ contractId, symbol, action: "updated", pnl });
        continue;
      }

      // Save new trade to DB
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

    // Also get closed contract history (last 100)
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
      // History fetch failed — not critical, continue
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