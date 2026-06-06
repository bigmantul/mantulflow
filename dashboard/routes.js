// ═══════════════════════════════════════════════════════
//  dashboard/routes.js — API Routes for Dashboard
// ═══════════════════════════════════════════════════════

import express from "express";
import { User, Trade, BotLog } from "./db.js";
import { botManager } from "./bot-manager.js";
import { connectForMode } from "../src/auth/deriv-auth.js";
import { connectWebSocket, sendMessage } from "../src/utils/ws-client.js";

const router = express.Router();

// ══════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ══════════════════════════════════════════════════════
const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token" });
  
  try {
    const jwt = await import("jsonwebtoken");
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
  }
};

// ══════════════════════════════════════════════════════
// USER ENDPOINTS
// ══════════════════════════════════════════════════════

// Get current user info
router.get("/user/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get REAL balance from Deriv
router.get("/user/balance", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user.derivPAT) {
      return res.json({ balance: 0, currency: "USD", error: "No PAT token" });
    }

    const wsUrl = await connectForMode(user.derivMode, user.derivPAT, user.derivAppId);
    const ws = await connectWebSocket(wsUrl);
    
    const balanceResp = await sendMessage(ws, { balance: 1 }, "balance");
    const balance = parseFloat(balanceResp.balance.balance);
    const currency = balanceResp.balance.currency;
    
    ws.close();
    
    res.json({ balance, currency });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update bot status (start/stop)
router.put("/user/bot", authMiddleware, async (req, res) => {
  try {
    const { active } = req.body;
    const user = await User.findByIdAndUpdate(
      req.userId,
      { botActive: active },
      { new: true }
    );

    if (active) {
      await botManager.startUser(user);
    } else {
      await botManager.stopUser(req.userId);
    }

    res.json({ botActive: user.botActive });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update risk settings
router.put("/user/risk", authMiddleware, async (req, res) => {
  try {
    const { riskPct, maxOpenTrades, stopLossPct, takeProfitPct } = req.body;
    
    const user = await User.findByIdAndUpdate(
      req.userId,
      {
        "risk.riskPct": riskPct,
        "risk.maxOpenTrades": maxOpenTrades,
        "risk.stopLossPct": stopLossPct,
        "risk.takeProfitPct": takeProfitPct,
      },
      { new: true }
    );

    // Restart bot if running to apply new settings
    if (user.botActive) {
      await botManager.restartUser(req.userId);
    }

    res.json({ message: "Risk settings updated", risk: user.risk });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update account settings
router.put("/user/settings", authMiddleware, async (req, res) => {
  try {
    const { derivPAT, derivAppId, derivMode, telegramChatId } = req.body;
    
    const user = await User.findByIdAndUpdate(
      req.userId,
      { derivPAT, derivAppId, derivMode, telegramChatId },
      { new: true }
    );

    res.json({ message: "Settings updated" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sync trades with Deriv portfolio
router.post("/user/sync-trades", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user.derivPAT) {
      return res.status(400).json({ error: "No PAT token configured" });
    }

    const wsUrl = await connectForMode(user.derivMode, user.derivPAT, user.derivAppId);
    const ws = await connectWebSocket(wsUrl);
    
    const portfolioResp = await sendMessage(ws, { portfolio: 1 }, "portfolio");
    const contracts = portfolioResp?.portfolio?.contracts || [];
    
    let synced = 0;
    
    for (const contract of contracts) {
      const contractId = String(contract.contract_id);
      const status = String(contract.status || "").toLowerCase();
      
      // Skip already closed
      if (["sold", "closed", "expired"].includes(status)) continue;
      
      // Check if we already have this trade
      const existing = await Trade.findOne({ userId: req.userId, contractId });
      if (existing) {
        // Update PnL for open trades
        await Trade.findByIdAndUpdate(existing._id, {
          pnl: parseFloat(contract.profit || 0)
        });
        synced++;
      }
    }
    
    ws.close();
    res.json({ message: `Synced ${synced} trades`, synced });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Import ALL trades from Deriv (creates new records)
router.post("/user/import-trades", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user.derivPAT) {
      return res.status(400).json({ error: "No PAT token configured" });
    }

    const wsUrl = await connectForMode(user.derivMode, user.derivPAT, user.derivAppId);
    const ws = await connectWebSocket(wsUrl);
    
    const portfolioResp = await sendMessage(ws, { portfolio: 1 }, "portfolio");
    const contracts = portfolioResp?.portfolio?.contracts || [];
    
    let imported = 0;
    
    for (const contract of contracts) {
      const contractId = String(contract.contract_id);
      
      // Check if already exists
      const existing = await Trade.findOne({ userId: req.userId, contractId });
      if (existing) continue;
      
      // Extract symbol from shortcode
      const shortcode = contract.shortcode || "";
      let symbol = contract.underlying || "UNKNOWN";
      
      // Parse direction
      let direction = "MULTUP";
      if (shortcode.includes("MULTDOWN")) direction = "MULTDOWN";
      
      const status = String(contract.status || "").toLowerCase();
      let tradeStatus = "open";
      if (["sold", "closed", "expired"].includes(status)) {
        const pnl = parseFloat(contract.profit || 0);
        tradeStatus = pnl >= 0 ? "won" : "lost";
      }
      
      await Trade.create({
        userId: req.userId,
        symbol,
        direction,
        stake: parseFloat(contract.buy_price || 0),
        multiplier: parseFloat(contract.multiplier || 100),
        contractId,
        buyPrice: parseFloat(contract.buy_price || 0),
        pnl: parseFloat(contract.profit || 0),
        status: tradeStatus,
        openedAt: new Date(contract.date_start * 1000),
        closedAt: contract.date_expiry ? new Date(contract.date_expiry * 1000) : null,
      });
      
      imported++;
    }
    
    ws.close();
    res.json({ message: `Imported ${imported} new trades`, imported });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════
// TRADES ENDPOINTS
// ══════════════════════════════════════════════════════

// Get trades with filters
router.get("/trades", authMiddleware, async (req, res) => {
  try {
    const { status, limit = 30, timeframe } = req.query;
    
    const query = { userId: req.userId };
    
    if (status && status !== "all") {
      query.status = status;
    }
    
    // Timeframe filter
    if (timeframe) {
      const now = new Date();
      let startDate;
      
      switch(timeframe) {
        case "today":
          startDate = new Date(now.setHours(0, 0, 0, 0));
          break;
        case "yesterday":
          const yesterday = new Date(now);
          yesterday.setDate(yesterday.getDate() - 1);
          startDate = new Date(yesterday.setHours(0, 0, 0, 0));
          const endDate = new Date(yesterday.setHours(23, 59, 59, 999));
          query.openedAt = { $gte: startDate, $lte: endDate };
          break;
        case "7days":
          startDate = new Date(now.setDate(now.getDate() - 7));
          query.openedAt = { $gte: startDate };
          break;
        case "30days":
          startDate = new Date(now.setDate(now.getDate() - 30));
          query.openedAt = { $gte: startDate };
          break;
        case "90days":
          startDate = new Date(now.setDate(now.getDate() - 90));
          query.openedAt = { $gte: startDate };
          break;
        default:
          break;
      }
      
      if (timeframe === "today" || timeframe === "7days" || timeframe === "30days" || timeframe === "90days") {
        query.openedAt = { $gte: startDate };
      }
    }
    
    const trades = await Trade.find(query)
      .sort({ openedAt: -1 })
      .limit(parseInt(limit));
    
    res.json({ trades });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get trade statistics
router.get("/trades/stats", authMiddleware, async (req, res) => {
  try {
    const { timeframe } = req.query;
    
    const query = { userId: req.userId };
    
    // Apply timeframe filter
    if (timeframe && timeframe !== "all") {
      const now = new Date();
      let startDate;
      
      switch(timeframe) {
        case "today":
          startDate = new Date(now.setHours(0, 0, 0, 0));
          break;
        case "yesterday":
          const yesterday = new Date(now);
          yesterday.setDate(yesterday.getDate() - 1);
          startDate = new Date(yesterday.setHours(0, 0, 0, 0));
          const endDate = new Date(yesterday.setHours(23, 59, 59, 999));
          query.openedAt = { $gte: startDate, $lte: endDate };
          break;
        case "7days":
          startDate = new Date(now.setDate(now.getDate() - 7));
          query.openedAt = { $gte: startDate };
          break;
        case "30days":
          startDate = new Date(now.setDate(now.getDate() - 30));
          query.openedAt = { $gte: startDate };
          break;
        case "90days":
          startDate = new Date(now.setDate(now.getDate() - 90));
          query.openedAt = { $gte: startDate };
          break;
      }
      
      if (timeframe === "today" || timeframe === "7days" || timeframe === "30days" || timeframe === "90days") {
        query.openedAt = { $gte: startDate };
      }
    }
    
    const allTrades = await Trade.find(query);
    
    const total = allTrades.length;
    const won = allTrades.filter(t => t.status === "won").length;
    const lost = allTrades.filter(t => t.status === "lost").length;
    const open = allTrades.filter(t => t.status === "open").length;
    
    const winRate = total > 0 ? ((won / (won + lost)) * 100).toFixed(1) : "0.0";
    
    const totalPnl = allTrades
      .filter(t => t.status !== "open")
      .reduce((sum, t) => sum + (t.pnl || 0), 0)
      .toFixed(2);
    
    // Today's PnL
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTrades = allTrades.filter(t => new Date(t.openedAt) >= todayStart);
    const todayPnl = todayTrades
      .filter(t => t.status !== "open")
      .reduce((sum, t) => sum + (t.pnl || 0), 0)
      .toFixed(2);
    
    res.json({
      total,
      won,
      lost,
      open,
      winRate,
      totalPnl,
      todayPnl,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════
// LOGS ENDPOINTS
// ══════════════════════════════════════════════════════

router.get("/logs", authMiddleware, async (req, res) => {
  try {
    const { level, limit = 300 } = req.query;
    
    const query = { userId: req.userId };
    if (level) query.level = level;
    
    const logs = await BotLog.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));
    
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════
// LIVE MARKET DATA (uses Deriv WebSocket)
// ══════════════════════════════════════════════════════

router.get("/market/prices", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    
    // Use user's credentials or fallback to default
    const wsUrl = await connectForMode(
      user.derivMode || "demo",
      user.derivPAT || process.env.DERIV_PAT_TOKEN,
      user.derivAppId || process.env.DERIV_APP_ID
    );
    const ws = await connectWebSocket(wsUrl);
    
    const symbols = [
      "frxEURUSD", "frxGBPUSD", "frxUSDJPY", "frxUSDCHF",
      "frxAUDUSD", "frxUSDCAD", "frxNZDUSD",
      "frxXAUUSD", "frxXAGUSD",
      "cryBTCUSD", "cryETHUSD"
    ];
    
    const prices = {};
    
    for (const symbol of symbols) {
      try {
        const tickResp = await sendMessage(ws, { ticks: symbol }, "tick");
        if (tickResp.tick) {
          prices[symbol] = {
            price: parseFloat(tickResp.tick.quote),
            timestamp: tickResp.tick.epoch,
          };
        }
      } catch (e) {
        console.error(`Error fetching ${symbol}:`, e.message);
      }
    }
    
    ws.close();
    res.json(prices);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;