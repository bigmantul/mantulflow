// ═══════════════════════════════════════════════════════
//  dashboard/server.js
// ═══════════════════════════════════════════════════════

import "dotenv/config";
import express    from "express";
import cors       from "cors";
import path       from "path";
import { fileURLToPath } from "url";

import { connectDB }        from "./db.js";
import { resumeActiveBots } from "./bot-manager.js";
import authRoutes           from "./routes/auth.js";
import userRoutes           from "./routes/user.js";
import tradeRoutes          from "./routes/trades.js";
import adminRoutes          from "./routes/admin.js";
import logRoutes            from "./routes/logs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app       = express();
const PORT      = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── API ROUTES ────────────────────────────────────────
app.use("/api/auth",   authRoutes);
app.use("/api/user",   userRoutes);
app.use("/api/trades", tradeRoutes);
app.use("/api/admin",  adminRoutes);
app.use("/api/logs",   logRoutes);

// ── HEALTH CHECK ──────────────────────────────────────
app.get("/health", (req, res) => res.send("OK"));

// ── SERVE FRONTEND ────────────────────────────────────
app.use(express.static(path.join(__dirname, "../public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// ── START ─────────────────────────────────────────────
async function start() {
  await connectDB();
  await resumeActiveBots();
  app.listen(PORT, () => {
    console.log(`\n🌐 Dashboard: http://localhost:${PORT}`);
    console.log(`🔐 Admin:     http://localhost:${PORT}/admin.html`);
  });
}

start();