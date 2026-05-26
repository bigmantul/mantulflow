// ═══════════════════════════════════════════════════════
//  dashboard/routes/logs.js
//  GET /api/logs — get user's bot logs (last 72 hours)
// ═══════════════════════════════════════════════════════

import express     from "express";
import { protect } from "../middleware/protect.js";
import { BotLog }  from "../db.js";

const router = express.Router();

router.get("/", protect, async (req, res) => {
  try {
    const { level, limit = 200 } = req.query;
    const query = { userId: req.user._id };
    if (level) query.level = level;

    const logs = await BotLog.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    res.json(logs.reverse()); // oldest first for display
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;