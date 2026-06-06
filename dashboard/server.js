// ═══════════════════════════════════════════════════════
//  dashboard/server.js — Express Server
// ═══════════════════════════════════════════════════════

import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { User } from "./db.js";
import apiRoutes from "./routes.js";
import { resumeActiveBots } from "./bot-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(__dirname));

// ══════════════════════════════════════════════════════
// CONNECT TO MONGODB
// ══════════════════════════════════════════════════════
await mongoose.connect(process.env.MONGODB_URI);
console.log("✅ Connected to MongoDB");

// ══════════════════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════════════════

// Login
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });
    
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    
    res.json({ token, name: user.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Register (optional - you can disable this in production)
app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    
    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ error: "Email already exists" });
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const user = await User.create({
      name,
      email,
      password: hashedPassword,
    });
    
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    
    res.json({ token, name: user.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════════════════════
app.use("/api", apiRoutes);

// ══════════════════════════════════════════════════════
// SERVE FRONTEND
// ══════════════════════════════════════════════════════
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "login.html"));
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/charts", (req, res) => {
  res.sendFile(path.join(__dirname, "charts.html"));
});

// ══════════════════════════════════════════════════════
// START SERVER
// ══════════════════════════════════════════════════════
app.listen(PORT, async () => {
  console.log(`🚀 Dashboard server running on http://localhost:${PORT}`);
  
  // Resume all active bots
  await resumeActiveBots();
});