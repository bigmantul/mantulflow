// ═══════════════════════════════════════════════════════
//  dashboard/realtime.js
//
//  Central Socket.IO layer for pushing live updates to the
//  dashboard (open trades, live PnL, trade status, balance/
//  equity, trade history, bot activity log) without the
//  frontend needing to poll or reload the page.
//
//  Rooms:
//    user:<userId>  — events scoped to one user's own data
//    admin          — aggregate events for the admin panel
//
//  A single JWT (the same one already used for REST auth)
//  is passed on the socket handshake and used to decide
//  which room(s) a connection joins.
// ═══════════════════════════════════════════════════════

import { Server } from "socket.io";
import jwt        from "jsonwebtoken";

let io = null;

export function initRealtime(httpServer) {
  io = new Server(httpServer, {
    // Same-origin dashboard, but keep this permissive since the
    // frontend is served from the same Express app on all deploys.
    cors: { origin: "*" },
  });

  io.use((socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.query?.token;

      if (!token) return next(new Error("No token"));

      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.data.userId  = payload.id ? String(payload.id) : null;
      socket.data.isAdmin = !!payload.isAdmin;
      next();
    } catch (e) {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    if (socket.data.isAdmin) {
      socket.join("admin");
    } else if (socket.data.userId) {
      socket.join(`user:${socket.data.userId}`);
    } else {
      socket.disconnect(true);
      return;
    }

    socket.emit("connected", { ok: true, at: Date.now() });
  });

  return io;
}

// ── Low-level emit, scoped to one user's room ─────────
export function emitToUser(userId, event, payload) {
  if (!io || !userId) return;
  io.to(`user:${String(userId)}`).emit(event, payload);
}

// ── Low-level emit, scoped to the admin room ──────────
export function emitToAdmin(event, payload) {
  if (!io) return;
  io.to("admin").emit(event, payload);
}

// Kept for backward compatibility with existing call sites
// (bot-manager.js's activity log broadcaster) — now routes
// through Socket.IO instead of the old raw `ws` server.
export function broadcastToUser(userId, event) {
  if (!event || typeof event !== "object") return;
  const { type, ...rest } = event;
  emitToUser(userId, type || "log", rest);
}

// ── Typed helpers — used by bot-manager.js / trader.js ─
// Each of these emits to the user's own room AND a lighter
// summary to the admin room, so the admin panel can refresh
// itself in real time too without a separate polling loop.

export function emitTradeOpened(userId, trade) {
  emitToUser(userId, "trade:opened", trade);
  emitToAdmin("admin:activity", { type: "trade:opened", userId: String(userId), symbol: trade.symbol });
}

export function emitTradeUpdate(userId, trade) {
  // trade: { id, pnl, status, ...whatever changed } — partial patch,
  // not the full trade document, so the client can merge it in place.
  emitToUser(userId, "trade:update", trade);
}

export function emitTradeClosed(userId, trade) {
  emitToUser(userId, "trade:closed", trade);
  emitToAdmin("admin:activity", { type: "trade:closed", userId: String(userId), symbol: trade.symbol, pnl: trade.pnl });
}

export function emitBalanceUpdate(userId, balance, mode) {
  emitToUser(userId, "balance:update", { balance, mode });
}

export function emitBotStatus(userId, active) {
  emitToUser(userId, "bot:status", { active });
  emitToAdmin("admin:activity", { type: "bot:status", userId: String(userId), active });
}

export function getIO() {
  return io;
}
