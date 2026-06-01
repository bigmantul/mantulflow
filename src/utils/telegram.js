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
//  CYCLE LOG — sent every poll cycle so you see live
//  activity in Telegram just like the console
// ═══════════════════════════════════════════════════════

/**
 * Sends a full scan cycle summary to Telegram.
 * Called once per 15s cycle after all symbols are scanned.
 *
 * @param {object} opts
 * @param {number}   opts.balance
 * @param {number}   opts.openTrades
 * @param {number}   opts.maxTrades
 * @param {string}   opts.session
 * @param {Array}    opts.results   - array of { symbol, status, strength, trend }
 */
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
      lines.push(`⏸ ${r.symbol} | HOLD | HTF: ${r.trend} | ${r.strength.toFixed(0)}%`);
    } else if (r.status === "BUY" || r.status === "SELL") {
      const icon = r.status === "BUY" ? "🟢" : "🔴";
      lines.push(`${icon} ${r.symbol} | ${r.status} | ${r.strength.toFixed(0)}% — placing trade...`);
    }
  }

  return sendMessage(lines.join("\n"));
}


// ═══════════════════════════════════════════════════════
//  ALL OTHER NOTIFICATIONS
// ═══════════════════════════════════════════════════════

export function notifyStartup(balance, mode) {
  return sendMessage(
    `🤖 <b>Deriv Bot Started</b>\n` +
    `Mode     : ${mode.toUpperCase()}\n` +
    `Balance  : $${balance.toFixed(2)}\n` +
    `Strategy : Confluences required\n` +
    `Symbols  :Forex, Crypto, Metals\n` +
    `Status   : Scanning every 15s...`
  );
}

export function notifyTradeOpened({ symbol, direction, stake, multiplier, limitOrder, strength, contractId }) {
  const label = direction === "MULTUP" ? "🟢 BUY" : "🔴 SELL";
  return sendMessage(
    `${label} <b>TRADE OPENED — ${symbol}</b>\n` +
    `Contract : ${contractId}\n` +
    `Stake    : $${stake.toFixed(2)} x${multiplier}\n` +
    `Strength : ${strength.toFixed(0)}%\n` +
    `SL       : $${limitOrder.stop_loss}\n` +
    `TP       : $${limitOrder.take_profit}`
  );
}

export function notifyRiskBlock(reason) {
  return sendMessage(`⚠️ <b>Risk Block</b>\n${reason}`);
}

export function notifyReconnecting(error) {
  return sendMessage(
    `🔌 <b>Reconnecting...</b>\n` +
    `Reason: ${error}`
  );
}

export function notifyMaxTrades(current, max) {
  return sendMessage(
    `🔒 <b>Max trades reached</b>\n` +
    `Open: ${current}/${max} — waiting for a trade to close`
  );
}

export function notifyDailySummary({ balance, dailyPnl, openTrades, consecutiveLosses }) {
  const pnlIcon = dailyPnl >= 0 ? "📈" : "📉";
  return sendMessage(
    `${pnlIcon} <b>Daily Summary</b>\n` +
    `Balance    : $${balance.toFixed(2)}\n` +
    `Daily PnL  : ${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)}\n` +
    `Open trades: ${openTrades}\n` +
    `Loss streak: ${consecutiveLosses}`
  );
}