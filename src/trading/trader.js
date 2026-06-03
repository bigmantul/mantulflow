// ═══════════════════════════════════════════════════════
//  src/utils/telegram.js
// ═══════════════════════════════════════════════════════

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

async function sendMessage(text, botToken, chatId) {
  const token = botToken || TELEGRAM_BOT_TOKEN;
  const chat  = chatId   || TELEGRAM_CHAT_ID;

  if (!token || !chat) return;
  if (token === "your_telegram_bot_token_here") return;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chat, text, parse_mode: "HTML" }),
    });
    if (!res.ok) console.error("Telegram failed:", await res.text());
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}

// ── STARTUP ───────────────────────────────────────────
export function notifyStartup(balance, mode, label, botToken, chatId) {
  return sendMessage(
    `🤖 <b>${label || "Bot"} — Started</b>\n` +
    `Mode    : ${(mode || "demo").toUpperCase()}\n` +
    `Balance : $${balance.toFixed(2)}\n` +
    `Strategy: SMC — 4H/1H/15m | Min 5/7 votes`,
    botToken, chatId
  );
}

// ── TRADE OPENED ──────────────────────────────────────
export function notifyTradeOpened({ symbol, direction, stake, multiplier, limitOrder, strength, contractId, label, botToken, chatId }) {
  const icon   = direction === "MULTUP" ? "🟢 BUY" : "🔴 SELL";
  const votes  = strength != null ? Math.round(strength * 7 / 100) : "?";
  const slText = limitOrder ? `\nSL        : $${limitOrder.stop_loss}` : "";
  const tpText = limitOrder ? `\nTP        : $${limitOrder.take_profit}` : "";
  return sendMessage(
    `${icon} <b>${label || "Bot"} — ${symbol}</b>\n` +
    `Contract  : ${contractId}\n` +
    `Stake     : $${stake.toFixed(2)} x${multiplier}\n` +
    `Strength  : ${strength != null ? strength.toFixed(0) : "?"}% (${votes}/7 votes)` +
    slText + tpText +
    `\nFailsafe  : ⏱️ Force closes in 2hrs`,
    botToken, chatId
  );
}

// ── RISK BLOCK ────────────────────────────────────────
export function notifyRiskBlock(reason, label, botToken, chatId) {
  return sendMessage(
    `⚠️ <b>${label || "Bot"} — Risk Block</b>\n${reason}`,
    botToken, chatId
  );
}

// ── RECONNECTING ──────────────────────────────────────
export function notifyReconnecting(error, label, botToken, chatId) {
  return sendMessage(
    `🔌 <b>${label || "Bot"} — Reconnecting...</b>\nReason: ${error}`,
    botToken, chatId
  );
}

// ── MAX TRADES ────────────────────────────────────────
export function notifyMaxTrades(current, max, label, botToken, chatId) {
  return sendMessage(
    `🔒 <b>${label || "Bot"} — Max trades reached</b>\nOpen: ${current}/${max} — waiting`,
    botToken, chatId
  );
}

// ── DAILY SUMMARY ─────────────────────────────────────
export function notifyDailySummary({ balance, dailyPnl, openTrades, consecutiveLosses, label, botToken, chatId }) {
  const icon = dailyPnl >= 0 ? "📈" : "📉";
  return sendMessage(
    `${icon} <b>${label || "Bot"} — Daily Summary</b>\n` +
    `Balance    : $${balance.toFixed(2)}\n` +
    `Daily PnL  : ${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)}\n` +
    `Open trades: ${openTrades}\n` +
    `Loss streak: ${consecutiveLosses}`,
    botToken, chatId
  );
}

// ── CYCLE SCAN ────────────────────────────────────────
export function notifyCycleScan({ balance, openTrades, maxTrades, session, results, label, botToken, chatId }) {
  const lines = [
    `📊 <b>${label || "Bot"} — Scan Cycle</b>`,
    `Session : ${session}`,
    `Balance : $${balance.toFixed(2)}`,
    `Open    : ${openTrades}/${maxTrades}`,
    ``,
  ];

  for (const r of results) {
    const sym = r.symbol;

    if (r.status === "LOCKED") {
      const cd = r.countdown ? r.countdown : "";
      lines.push(`🔒 ${sym} | LOCKED${cd}`);

    } else if (r.status === "CLOSED") {
      lines.push(`🕐 ${sym} | MARKET CLOSED`);

    } else if (r.status === "FILTERED") {
      lines.push(`⛔ ${sym} | FILTERED — poor volatility`);

    } else if (r.status === "HOLD") {
      const h4     = ((r.h4bias || r.trend || "neutral")).toUpperCase();
      const h4icon = h4 !== "NEUTRAL" ? "✅" : "❌";
      const pct    = r.strength != null ? parseFloat(r.strength).toFixed(0) : "0";

      // Show which phase failed
      let phaseInfo = "";
      if (pct === "0")  phaseInfo = "P1 ❌";
      else if (pct === "33") phaseInfo = "P1 ✅ P2 ❌";
      else if (pct === "67") phaseInfo = "P1 ✅ P2 ✅ P3 ❌";

      // Show reject reason if available
      const rejectReason = r.rejectReason ? ` — ${r.rejectReason}` : "";

      lines.push(`⏸ ${sym} | 4H: ${h4} ${h4icon} | ${phaseInfo}${rejectReason}`);

    } else if (r.status === "BUY" || r.status === "SELL") {
      const icon   = r.status === "BUY" ? "🟢" : "🔴";
      const votes  = r.strength != null ? Math.round(r.strength * 7 / 100) : 0;
      const h4     = (r.h4bias  || (r.status === "BUY" ? "bullish" : "bearish")).toUpperCase();
      const h1     = (r.h1trend || (r.status === "BUY" ? "bullish" : "bearish")).toUpperCase();
      lines.push(`${icon} ${sym} | 4H: ${h4} ✅ | 1H: ${h1} ✅ | ${votes}/7 — ${r.status}!`);
    }
  }

  return sendMessage(lines.join("\n"), botToken, chatId);
}