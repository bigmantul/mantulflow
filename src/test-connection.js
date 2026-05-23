
import "dotenv/config";
import { connectForMode } from "./auth/deriv-auth.js";
import { connectWebSocket, sendMessage } from "./utils/ws-client.js";

async function test() {
  console.log("=== CONNECTION TEST ===");
  console.log("PAT Token:", process.env.DERIV_PAT_TOKEN?.slice(0, 15) + "...");
  console.log("App ID:", process.env.DERIV_APP_ID);
  try {
    const wsUrl = await connectForMode("demo");
    const ws = await connectWebSocket(wsUrl);

    const ping = await sendMessage(ws, { ping: 1 }, "ping");
    console.log("Ping:", ping.ping);

    const bal = await sendMessage(ws, { balance: 1 }, "balance");
    console.log("Balance:", bal.balance.balance, bal.balance.currency);
    console.log("Login ID:", bal.balance.loginid);

    console.log("=== ALL TESTS PASSED - Run: npm start ===");
    ws.close();
    process.exit(0);
  } catch (err) {
    console.error("FAILED:", err.message);
    process.exit(1);
  }
}
test();