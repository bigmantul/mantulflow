// ═══════════════════════════════════════════════════════
//  src/utils/telegram.js
// ═══════════════════════════════════════════════════════

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

async function sendMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  if (TELEGRAM_BOT_TOKEN === "your_telegram_bot_token_here") return;

  try {
    const url  = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body = JSON.stringify({
      chat_id:    TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
    });
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) console.error("Telegram send failed:", await res.text());
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}

// ═══════════════════════════════════════════════════════
//  CYCLE LOG — sent every poll cycle
// ═══════════════════════════════════════════════════════

export function notifyCycleScan({ balance, openTrades, maxTrades, session, results }) {
  const lines = [
    `📊 <b>Scan Cycle</b>`,
    `Session  : ${session}`,
    `Balance  : $${balance.toFixed(2)}`,
    `Open     : ${openTrades}/${maxTrades}`,
    ``,
  ];

  for (const r of results) {
    if (r.status === "LOCKED") {
      lines.push(`🔒 ${r.symbol} | LOCKED`);
    } else if (r.status === "CLOSED") {
      lines.push(`🕐 ${r.symbol} | MARKET CLOSED`);
    } else if (r.status === "FILTERED") {
      lines.push(`⛔ ${r.symbol} | FILTERED`);
    } else if (r.status === "HOLD") {
      lines.push(`⏸ ${r.symbol} | HOLD | HTF: ${r.trend} | ${r.strength?.toFixed(0) || 0}%`);
    } else if (r.status === "BUY" || r.status === "SELL") {
      const icon = r.status === "BUY" ? "🟢" : "🔴";
      lines.push(`${icon} ${r.symbol} | ${r.status} | ${r.strength?.toFixed(0) || 0}% — placing trade...`);
    }
  }

  return sendMessage(lines.join("\n"));
}

// ═══════════════════════════════════════════════════════
//  ALL OTHER NOTIFICATIONS
// ═══════════════════════════════════════════════════════

export function notifyStartup(balance, mode, label, botToken, chatId) {
  return sendMessage(
    `🤖 <b>Deriv Bot Started - ${label}</b>\n` +
    `Mode     : ${mode.toUpperCase()}\n` +
    `Balance  : $${balance.toFixed(2)}\n` +
    `Strategy : SMC — ALL 7 confluences required\n` +
    `Status   : Scanning every 15s...`
  );
}

export function notifyTradeOpened({ symbol, direction, stake, multiplier, limitOrder, strength, contractId, label, botToken, chatId }) {
  const tradeLabel = direction === "MULTUP" ? "🟢 BUY" : "🔴 SELL";
  return sendMessage(
    `${tradeLabel} <b>TRADE OPENED — ${symbol}</b>\n` +
    `Contract : ${contractId}\n` +
    `Stake    : $${stake.toFixed(2)} x${multiplier}\n` +
    `Strength : ${strength.toFixed(0)}%\n` +
    `SL       : $${limitOrder.stop_loss}\n` +
    `TP       : $${limitOrder.take_profit}`
  );
}

export function notifyRiskBlock(reason, label, botToken, chatId) {
  return sendMessage(`⚠️ <b>Risk Block - ${label}</b>\n${reason}`);
}

export function notifyReconnecting(error, label, botToken, chatId) {
  return sendMessage(
    `🔌 <b>Reconnecting - ${label}</b>\n` +
    `Reason: ${error}`
  );
}

export function notifyMaxTrades(current, max, label, botToken, chatId) {
  return sendMessage(
    `🔒 <b>Max trades reached - ${label}</b>\n` +
    `Open: ${current}/${max} — waiting for a trade to close`
  );
}

export function notifyDailySummary({ balance, dailyPnl, openTrades, consecutiveLosses, label, botToken, chatId }) {
  const pnlIcon = dailyPnl >= 0 ? "📈" : "📉";
  return sendMessage(
    `${pnlIcon} <b>Daily Summary - ${label}</b>\n` +
    `Balance    : $${balance.toFixed(2)}\n` +
    `Daily PnL  : ${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)}\n` +
    `Open trades: ${openTrades}\n` +
    `Loss streak: ${consecutiveLosses}`
  );
}

// ═══════════════════════════════════════════════════════
//  DETAILED SCAN LOG - Matches Render console exactly
// ═══════════════════════════════════════════════════════

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
      const reasonText = detail.reason || detail.holdReason || "waiting for confluence";
      line = `${detail.symbol} | 4H: ${detail.h4bias || detail.trend?.toUpperCase() || "NEUTRAL"} ${h4Icon} | ${reasonText}`;
      
    } else if (detail.status === "BUY" || detail.status === "SELL") {
      const icon = detail.status === "BUY" ? "🟢" : "🔴";
      const votes = detail.votes || Math.round((detail.strength || 0) * 7 / 100);
      line = `${icon} ${detail.symbol} | 4H: ✅ | 1H: ✅ | ${detail.strength?.toFixed(0) || 0}% (${votes}/7 votes) — ${detail.status}!`;
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
      await sendMessage(currentMsg);
      currentMsg = line + "\n";
    } else {
      currentMsg += line + "\n";
    }
  }
  if (currentMsg) await sendMessage(currentMsg);
}