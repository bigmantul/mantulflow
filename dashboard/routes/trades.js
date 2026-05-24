// ═══════════════════════════════════════════════════════
//  dashboard/routes/trades.js
//  GET /api/trades           — get user's trade history
//  GET /api/trades/stats     — get summary stats
// ═══════════════════════════════════════════════════════

import express     from "express";
import { protect } from "../middleware/protect.js";
import { Trade }   from "../db.js";

const router = express.Router();

// ── TRADE HISTORY ─────────────────────────────────────
router.get("/", protect, async (req, res) => {
  try {
    const { limit = 50, page = 1, status } = req.query;
    const query = { userId: req.user._id };
    if (status) query.status = status;

    const trades = await Trade.find(query)
      .sort({ openedAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await Trade.countDocuments(query);

    res.json({ trades, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── STATS ─────────────────────────────────────────────
router.get("/stats", protect, async (req, res) => {
  try {
    const userId = req.user._id;

    const all    = await Trade.find({ userId });
    const closed = all.filter(t => t.status !== "open");
    const open   = all.filter(t => t.status === "open");
    const won    = closed.filter(t => t.pnl > 0);
    const lost   = closed.filter(t => t.pnl <= 0);

    const totalPnl    = closed.reduce((sum, t) => sum + t.pnl, 0);
    const winRate     = closed.length ? (won.length / closed.length) * 100 : 0;
    const avgWin      = won.length  ? won.reduce((s, t)  => s + t.pnl, 0) / won.length  : 0;
    const avgLoss     = lost.length ? lost.reduce((s, t) => s + t.pnl, 0) / lost.length : 0;

    // Today's PnL
    const todayStart = new Date(); todayStart.setUTCHours(0,0,0,0);
    const todayTrades = closed.filter(t => new Date(t.closedAt) >= todayStart);
    const todayPnl    = todayTrades.reduce((sum, t) => sum + t.pnl, 0);

    res.json({
      total:      all.length,
      open:       open.length,
      closed:     closed.length,
      won:        won.length,
      lost:       lost.length,
      winRate:    parseFloat(winRate.toFixed(1)),
      totalPnl:   parseFloat(totalPnl.toFixed(2)),
      todayPnl:   parseFloat(todayPnl.toFixed(2)),
      avgWin:     parseFloat(avgWin.toFixed(2)),
      avgLoss:    parseFloat(avgLoss.toFixed(2)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;