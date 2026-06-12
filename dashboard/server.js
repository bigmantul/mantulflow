// ═══════════════════════════════════════════════════════
//  dashboard/server.js
// ═══════════════════════════════════════════════════════

import "dotenv/config";
import express      from "express";
import cors         from "cors";
import path         from "path";
import http         from "http";
import { WebSocketServer } from "ws";
import jwt          from "jsonwebtoken";
import { fileURLToPath }   from "url";

import { connectDB }        from "./db.js";
import { resumeActiveBots } from "./bot-manager.js";
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

// ── HTTP + WS SERVER ──────────────────────────────────
const server = http.createServer(app);

// WebSocket server for real-time timeline streaming
const wss = new WebSocketServer({ server, path: "/ws/timeline" });

// Map of userId → Set of connected WebSocket clients
const userSockets = new Map();

wss.on("connection", (ws, req) => {
  const url    = new URL(req.url, "http://localhost");
  const token  = url.searchParams.get("token");
  let userId   = null;

  // Decode JWT to get userId — no await needed, jwt.verify is sync
  if (token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      userId = String(payload.id);
    } catch {
      // Invalid token — still allow connection but won't receive events
    }
  }

  if (userId) {
    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId).add(ws);
    ws.send(JSON.stringify({ type: "connected", message: "Timeline connected ✅" }));
  }

  ws.on("close", () => {
    if (userId && userSockets.has(userId)) {
      userSockets.get(userId).delete(ws);
      if (userSockets.get(userId).size === 0) userSockets.delete(userId);
    }
  });

  ws.on("error", () => {});

  // Keepalive ping every 30s
  const ping = setInterval(() => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "ping" }));
    else clearInterval(ping);
  }, 30000);
});

// Export broadcaster so bot-manager can push events
export function broadcastToUser(userId, event) {
  const clients = userSockets.get(String(userId));
  if (!clients) return;
  const msg = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      try { ws.send(msg); } catch {}
    }
  }
}

// ── START ─────────────────────────────────────────────
async function start() {
  await connectDB();
  await resumeActiveBots();
  server.listen(PORT, () => {
    console.log(`\n🌐 Dashboard: http://localhost:${PORT}`);
    console.log(`🔐 Admin:     http://localhost:${PORT}/admin.html`);
    console.log(`📡 WebSocket: ws://localhost:${PORT}/ws/timeline`);
  });
}

start();