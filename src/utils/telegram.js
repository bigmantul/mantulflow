
// ═══════════════════════════════════════════════════════
//  ADD THESE 3 FUNCTIONS TO YOUR EXISTING telegram.js
//  (paste at the bottom of the file)
// ═══════════════════════════════════════════════════════

/**
 * Sends detailed signal analysis for a single symbol to Telegram
 * This matches the console logs you see on Render
 */
export async function notifySignalDetail({ 
  symbol, 
  h4bias, 
  h1trend, 
  strength, 
  votes,
  status,
  reason 
}) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  
  const h4Emoji = h4bias === "BULLISH" ? "🟢" : (h4bias === "BEARISH" ? "🔴" : "⚪");
  const h1Emoji = h1trend === h4bias ? "✅" : "❌";
  
  let message = "";
  
  if (status === "HOLD") {
    message = `⏸ <b>${symbol}</b>\n` +
              `4H: ${h4Emoji} ${h4bias} | 1H: ${h1Emoji} ${h1trend}\n` +
              `Strength: ${strength.toFixed(0)}% (${votes}/7 votes)\n` +
              `Reason: ${reason}`;
  } else if (status === "BUY" || status === "SELL") {
    const tradeIcon = status === "BUY" ? "🟢" : "🔴";
    message = `${tradeIcon} <b>${status} SIGNAL - ${symbol}</b>\n` +
              `4H: ${h4Emoji} ${h4bias} | 1H: ✅ ${h1trend}\n` +
              `Strength: ${strength.toFixed(0)}% (${votes}/7 votes)`;
  }
  
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: "HTML",
  });
  
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) console.error("Telegram send failed:", await res.text());
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}

/**
 * Sends complete detailed analysis for all symbols
 * Perfect mirror of console logs - sends every cycle
 */
export async function notifyDetailedScan({ label, session, balance, openTrades, maxTrades, symbolDetails }) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  if (!symbolDetails || symbolDetails.length === 0) return;
  
  const lines = [
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📊 <b>${label} - ${session}</b>`,
    `💰 Balance: $${balance.toFixed(2)} | Open: ${openTrades}/${maxTrades}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
  ];
  
  for (const detail of symbolDetails) {
    let line = "";
    
    if (detail.status === "HOLD") {
      const h4Icon = detail.h4bias !== "NEUTRAL" ? "✅" : "❌";
      line = `${detail.symbol} | 4H: ${detail.h4bias} ${h4Icon} | ${detail.reason || detail.holdReason}`;
    } else if (detail.status === "BUY" || detail.status === "SELL") {
      const icon = detail.status === "BUY" ? "🟢" : "🔴";
      line = `${icon} ${detail.symbol} | 4H: ✅ | 1H: ✅ | ${detail.strength?.toFixed(0) || 0}% (${detail.votes || 0}/7 votes) — ${detail.status}!`;
      if (detail.stake) line += ` | Stake: $${detail.stake}`;
    } else if (detail.status === "LOCKED") {
      line = `🔒 ${detail.symbol} | LOCKED — trade already open`;
    } else if (detail.status === "CLOSED") {
      line = `🕐 ${detail.symbol} | MARKET CLOSED`;
    } else if (detail.status === "FILTERED") {
      line = `⛔ ${detail.symbol} | FILTERED — poor volatility`;
    }
    
    if (line) lines.push(line);
  }
  
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  
  // Split into multiple messages if too long
  let currentMsg = "";
  for (const line of lines) {
    if ((currentMsg + line + "\n").length > 3900) {
      await sendTelegramMessageWithText(currentMsg);
      currentMsg = line + "\n";
    } else {
      currentMsg += line + "\n";
    }
  }
  if (currentMsg) await sendTelegramMessageWithText(currentMsg);
}

// Helper function for sending (reuse your existing send logic)
async function sendTelegramMessageWithText(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text: text,
    parse_mode: "HTML",
  });
  
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) console.error("Telegram send failed:", await res.text());
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}