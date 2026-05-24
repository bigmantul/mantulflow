// ═══════════════════════════════════════════════════════
//  dashboard/routes/auth.js
//  POST /api/auth/signup
//  POST /api/auth/login
// ═══════════════════════════════════════════════════════

import express from "express";
import jwt     from "jsonwebtoken";
import { User } from "../db.js";

const router = express.Router();

function makeToken(id) {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "30d" });
}

// ── SIGNUP ────────────────────────────────────────────
router.post("/signup", async (req, res) => {
  try {
    const { name, email, password, derivPAT, derivAppId, derivMode, telegramChatId } = req.body;

    if (!name || !email || !password || !derivPAT || !derivAppId) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ error: "Email already registered" });

    const user = await User.create({
      name, email, password,
      derivPAT, derivAppId,
      derivMode:      derivMode      || "demo",
      telegramChatId: telegramChatId || "",
      botActive: false,
    });

    res.status(201).json({
      token: makeToken(user._id),
      user:  { id: user._id, name: user.name, email: user.email, botActive: user.botActive, risk: user.risk },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── LOGIN ─────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: "Invalid email or password" });

    const match = await user.comparePassword(password);
    if (!match) return res.status(401).json({ error: "Invalid email or password" });

    res.json({
      token: makeToken(user._id),
      user:  { id: user._id, name: user.name, email: user.email, botActive: user.botActive, risk: user.risk },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;