// ═══════════════════════════════════════════════════════
//  dashboard/server.js
// ═══════════════════════════════════════════════════════

import "dotenv/config";
import express      from "express";
import cors         from "cors";
import path         from "path";
import http         from "http";
import { fileURLToPath }   from "url";

import { connectDB }        from "./db.js";
import { resumeActiveBots } from "./bot-manager.js";
import { initRealtime }     from "./realtime.js";
import authRoutes           from "./routes/auth.js";
import userRoutes           from "./routes/user.js";
import tradeRoutes          from "./routes/trades.js";
import adminRoutes          from "./routes/admin.js";
import logRoutes            from "./routes/logs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app        = express();
const PORT       = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── API ROUTES ────────────────────────────────────────
app.use("/api/auth",   authRoutes);
app.use("/api/user",   userRoutes);
app.use("/api/trades", tradeRoutes);
app.use("/api/admin",  adminRoutes);
app.use("/api/logs",   logRoutes);

// ── HEALTH ────────────────────────────────────────────
app.get("/health", (_, res) => res.send("OK"));

// ── STATIC ────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "../public")));
app.get("*", (_, res) => res.sendFile(path.join(__dirname, "../public/index.html")));

// ── HTTP + SOCKET.IO SERVER ───────────────────────────
const server = http.createServer(app);

// Real-time push layer (open trades, live PnL, trade status,
// balance/equity, trade history, activity log) — see realtime.js.
// The Socket.IO client library itself is auto-served at
// /socket.io/socket.io.js by this same server, so pages just
// need <script src="/socket.io/socket.io.js"></script>.
initRealtime(server);

// ── START ─────────────────────────────────────────────
async function start() {
  await connectDB();
  await resumeActiveBots();
  server.listen(PORT, () => {
    console.log(`\n🌐 Dashboard: http://localhost:${PORT}`);
    console.log(`🔐 Admin:     http://localhost:${PORT}/admin.html`);
    console.log(`📡 Realtime:  Socket.IO ready on same origin`);
  });
}

start();