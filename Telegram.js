// ═══════════════════════════════════════════════════════
//  src/utils/telegram.js
//
//  Sends Telegram notifications for:
//    - Bot startup
//    - Trade opened (BUY/SELL)
//    - Trade signal fired (with SMC reason)
//    - Risk blocks (max trades, daily loss, streak)
//    - Errors / reconnections
//    - Daily summary
// ═══════════════════════════════════════════════════════

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

/**
 * Core send function — all other functions call this.
 * Silently ignores failures so a Telegram error never
 * crashes the bot.
 */
async function sendMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

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

    if (!res.ok) {
      const err = await res.text();
      console.error("Telegram send failed:", err);
    }
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}


// ═══════════════════════════════════════════════════════
//  NOTIFICATION FUNCTIONS
// ═══════════════════════════════════════════════════════

/** Bot started up successfully */
export function notifyStartup(balance, mode) {
  return sendMessage(
    `🤖 <b>Deriv Bot Started</b>\n` +
    `Mode     : ${mode.toUpperCase()}\n` +
    `Balance  : $${balance.toFixed(2)}\n` +
    `Strategy : SMC (5m/15m/4H)\n` +
    `Status   : Scanning markets...`
  );
}

/** Trade successfully opened */
export function notifyTradeOpened({ symbol, direction, stake, multiplier, limitOrder, strength, contractId }) {
  const label = direction === "MULTUP" ? "🟢 BUY" : "🔴 SELL";
  return sendMessage(
    `${label} <b>${symbol}</b>\n` +
    `Contract : ${contractId}\n` +
    `Stake    : $${stake.toFixed(2)} x${multiplier}\n` +
    `Strength : ${strength.toFixed(0)}%\n` +
    `SL       : $${limitOrder.stop_loss}\n` +
    `TP       : $${limitOrder.take_profit}`
  );
}

/** Risk block triggered */
export function notifyRiskBlock(reason) {
  return sendMessage(`⚠️ <b>Risk Block</b>\n${reason}`);
}

/** Bot lost connection and is reconnecting */
export function notifyReconnecting(error) {
  return sendMessage(
    `🔌 <b>Reconnecting...</b>\n` +
    `Reason: ${error}`
  );
}

/** Market closed for a symbol */
export function notifyMarketClosed(symbol) {
  return sendMessage(`🕐 <b>${symbol}</b> market is closed — skipping`);
}

/** Daily summary — call this once per day */
export function notifyDailySummary({ balance, dailyPnl, openTrades, consecutiveLosses }) {
  const pnlIcon = dailyPnl >= 0 ? "📈" : "📉";
  return sendMessage(
    `${pnlIcon} <b>Daily Summary</b>\n` +
    `Balance  : $${balance.toFixed(2)}\n` +
    `Daily PnL: ${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)}\n` +
    `Open     : ${openTrades}\n` +
    `Loss streak: ${consecutiveLosses}`
  );
}

/** Max open trades reached */
export function notifyMaxTrades(current, max) {
  return sendMessage(
    `🔒 <b>Max trades reached</b>\n` +
    `Open: ${current}/${max} — waiting for a trade to close`
  );
}