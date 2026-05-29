// ═══════════════════════════════════════════════════════
//  src/utils/ws-client.js
//  WebSocket connection manager
//  Includes keepalive ping every 20s to prevent
//  Render/Deriv from dropping idle connections (code 1006)
// ═══════════════════════════════════════════════════════

import WebSocket from "ws";

/**
 * Opens a WebSocket connection and starts a keepalive
 * ping every 20 seconds to prevent idle disconnection.
 * Code 1006 = abnormal closure (no ping = dropped)
 */
export function connectWebSocket(wsUrl) {
  return new Promise((resolve, reject) => {
    console.log("🔌 Connecting to Deriv WebSocket...");
    const ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      console.log("✅ WebSocket connected successfully!\n");

      // ── KEEPALIVE PING ─────────────────────────────
      // Sends a ping every 20 seconds to keep the
      // connection alive on Render and prevent code 1006
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ ping: 1 }));
        } else {
          clearInterval(pingInterval);
        }
      }, 20000);

      // Clear ping interval when connection closes
      ws.on("close", () => clearInterval(pingInterval));

      resolve(ws);
    });

    ws.on("error", (err) => {
      console.error("❌ WebSocket error:", err.message);
      reject(err);
    });

    ws.on("close", (code, reason) => {
      const msg = reason?.toString() || "no reason";
      if (code === 1006) {
        console.log(`⚠️  WebSocket dropped (code 1006 — connection lost). Reconnecting...`);
      } else {
        console.log(`⚠️  WebSocket closed. Code: ${code} | ${msg}`);
      }
    });
  });
}

/**
 * Sends a message and waits for a matching response.
 * Matches on msg_type OR a top-level key.
 * Times out after 30 seconds to prevent hanging.
 */
export function sendMessage(ws, payload, responseKey) {
  return new Promise((resolve, reject) => {

    // Timeout — don't hang forever if Deriv doesn't respond
    const timeout = setTimeout(() => {
      ws.off("message", handler);
      reject(new Error(`Timeout waiting for "${responseKey}" response`));
    }, 30000);

    const handler = (data) => {
      let response;
      try {
        response = JSON.parse(data);
      } catch {
        return;
      }

      // Ignore keepalive pong responses
      if (response.ping === "pong" && responseKey !== "ping") return;

      if (response.error) {
        clearTimeout(timeout);
        ws.off("message", handler);
        reject(new Error(`Deriv API Error: ${response.error.message}`));
        return;
      }

      if (response.msg_type === responseKey || response[responseKey] !== undefined) {
        clearTimeout(timeout);
        ws.off("message", handler);
        resolve(response);
      }
    };

    ws.on("message", handler);

    // Check connection is still open before sending
    if (ws.readyState !== WebSocket.OPEN) {
      clearTimeout(timeout);
      ws.off("message", handler);
      reject(new Error("WebSocket is not open"));
      return;
    }

    ws.send(JSON.stringify(payload));
  });
}