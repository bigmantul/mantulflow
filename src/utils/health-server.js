// ═══════════════════════════════════════════════════════
//  src/utils/health-server.js
//
//  Converted from HealthHandler + start_health_server()
//  in main.py
//
//  Runs a lightweight HTTP server that responds "OK" to
//  any GET request — keeps Render free-tier instances
//  alive by responding to health checks.
//
//  Python threading.Thread(daemon=True) →
//  Node http server runs alongside the async bot loop
//  naturally since Node is single-threaded event loop.
// ═══════════════════════════════════════════════════════

import http from "http";

/**
 * Start the health check HTTP server.
 * Equivalent to start_health_server() in main.py
 *
 * Reads PORT from environment (Render sets this automatically).
 * Falls back to 8080 if not set.
 */
export function startHealthServer() {
  const port = parseInt(process.env.PORT ?? "8080", 10);

  const server = http.createServer((req, res) => {
    // Equivalent to HealthHandler.do_GET — always return 200 OK
    res.writeHead(200);
    res.end("OK");
    // No logging — equivalent to log_message() being overridden to pass
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`🌐 Health server running on port ${port}`);
  });

  // Suppress unhandled errors on the server (e.g. client disconnects)
  server.on("error", (err) => {
    console.error("Health server error:", err.message);
  });
}