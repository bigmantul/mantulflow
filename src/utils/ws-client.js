// ============================================
//  src/utils/ws-client.js
//  Manages the WebSocket connection to Deriv
// ============================================

import WebSocket from "ws";

export function connectWebSocket(wsUrl) {
  return new Promise((resolve, reject) => {
    console.log("🔌 Connecting to Deriv WebSocket...");
    const ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      console.log("✅ WebSocket connected successfully!\n");
      resolve(ws);
    });
    ws.on("error", (err) => {
      console.error("❌ WebSocket error:", err.message);
      reject(err);
    });
    ws.on("close", (code, reason) => {
      console.log(`⚠️  WebSocket closed. Code: ${code}`);
    });
  });
}

/**
 * Sends a message and waits for a matching response.
 * Matches on msg_type OR a top-level key with that name.
 * Used for: ping, balance, proposal, buy, candles, portfolio, etc.
 */
export function sendMessage(ws, payload, responseKey) {
  return new Promise((resolve, reject) => {
    const handler = (data) => {
      let response;
      try {
        response = JSON.parse(data);
      } catch {
        return;
      }

      if (response.error) {
        ws.off("message", handler);
        reject(new Error(`Deriv API Error: ${response.error.message}`));
        return;
      }

      // Match on msg_type (e.g. "candles", "balance", "proposal")
      // OR on a top-level key (e.g. response.buy, response.ping)
      if (response.msg_type === responseKey || response[responseKey] !== undefined) {
        ws.off("message", handler);
        resolve(response);
      }
    };

    ws.on("message", handler);
    ws.send(JSON.stringify(payload));
  });
}