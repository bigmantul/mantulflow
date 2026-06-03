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
    `Mode     : ${(mode || "demo").toUpperCase()}\n` +
    `Balance  : $${balance.toFixed(2)}\n` +
    `Strategy : Trend Following — 4H bias | 1H confirm | 15M entry\n` +
    `Exit     : SL/TP or 2hr forced close`,
    botToken, chatId
  );
}

// ── TRADE OPENED ──────────────────────────────────────
export function notifyTradeOpened({ symbol, direction, stake, multiplier, limitOrder, strength, contractId, label, botToken, chatId }) {
  const icon   = direction === "MULTUP" ? "🟢 BUY" : "🔴 SELL";
  const slText = limitOrder ? `\nSL       : $${limitOrder.stop_loss}` : "";
  const tpText = limitOrder ? `\nTP       : $${limitOrder.take_profit}` : "";
  return sendMessage(
    `${icon} <b>${label || "Bot"} — ${symbol}</b>\n` +
    `Contract : ${contractId}\n` +
    `Stake    : $${stake.toFixed(2)} x${multiplier}\n` +
    `Phases   : P1 ✅ P2 ✅ P3 ✅ — All aligned` +
    slText + tpText +
    `\nFailsafe : ⏱️ Force closes in 2hrs`,
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
    `🔒 <b>${label || "Bot"} — Max trades reached</b>\nOpen: ${current}/${max} — waiting for a trade to close`,
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
      const h4    = (r.h4bias || r.trend || "neutral").toUpperCase();
      const h4icon = h4 !== "NEUTRAL" ? "✅" : "❌";
      const pct   = parseFloat(r.strength ?? 0);

      // Phase info based on strength percentage
      let phaseInfo;
      if (pct === 0)        phaseInfo = "P1 ❌";
      else if (pct <= 33)   phaseInfo = "P1 ✅ | P2 ❌";
      else if (pct <= 67)   phaseInfo = "P1 ✅ | P2 ✅ | P3 ❌";
      else                  phaseInfo = "P1 ✅ | P2 ✅ | P3 ✅";

      // Reject reason (truncated to keep message short)
      const reason = r.rejectReason
        ? r.rejectReason.length > 50
          ? r.rejectReason.slice(0, 50) + "..."
          : r.rejectReason
        : "";

      lines.push(`⏸ ${sym} | 4H: ${h4} ${h4icon} | ${phaseInfo}${reason ? ` — ${reason}` : ""}`);

    } else if (r.status === "BUY" || r.status === "SELL") {
      const icon = r.status === "BUY" ? "🟢" : "🔴";
      const h4   = (r.h4bias  || (r.status === "BUY" ? "bullish" : "bearish")).toUpperCase();
      lines.push(`${icon} ${sym} | 4H: ${h4} ✅ | P1✅ P2✅ P3✅ — ${r.status}!`);
    }
  }

  return sendMessage(lines.join("\n"), botToken, chatId);
}