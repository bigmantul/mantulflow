
// ═══════════════════════════════════════════════════════
// dashboard/src/utils/telegram.js
// ═══════════════════════════════════════════════════════

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: "HTML",
        }),
      }
    );

    if (!res.ok) {
      console.error(
        "Telegram send failed:",
        await res.text()
      );
    }
  } catch (err) {
    console.error(
      "Telegram error:",
      err.message
    );
  }
}

// ═══════════════════════════════════════════════════════
// SCAN CYCLE
// ═══════════════════════════════════════════════════════

export async function notifyCycleScan({
  balance,
  openTrades,
  maxTrades,
  session,
  results = [],
}) {
  const lines = [
    `📊 <b>Mantul — Scan Cycle</b>`,
    `Session : ${session}`,
    `Balance : $${Number(balance).toFixed(2)}`,
    `Open    : ${openTrades}/${maxTrades}`,
    ``,
  ];

  for (const r of results) {

    if (r.status === "LOCKED") {
      const expiry =
        r.remainingMinutes != null
          ? ` | Expires in ${r.remainingMinutes}m`
          : "";

      lines.push(
        `🔒 ${r.symbol} | LOCKED — trade open${expiry}`
      );
      continue;
    }

    if (r.status === "CLOSED") {
      lines.push(
        `🕐 ${r.symbol} | MARKET CLOSED`
      );
      continue;
    }

    if (r.status === "FILTERED") {
      lines.push(
        `⛔ ${r.symbol} | FILTERED`
      );
      continue;
    }

    const h4 =
      (r.h4Bias || "neutral").toUpperCase();

    const h1 =
      (r.h1Bias || "neutral").toUpperCase();

    const votes =
      r.votes ?? 0;

    if (r.status === "HOLD") {

      if (h4 === "NEUTRAL") {
        lines.push(
          `⏸ ${r.symbol} | 4H: NEUTRAL ❌ | 4H neutral`
        );
        continue;
      }

      if (
        h1 !== "NEUTRAL" &&
        h1 !== h4
      ) {
        lines.push(
          `⏸ ${r.symbol} | 4H: ${h4} ✅ | 1H: ${h1} ❌ disagrees`
        );
        continue;
      }

      lines.push(
        `⏸ ${r.symbol} | 4H: ${h4} ✅ | 1H: ${h1} ✅ | ${votes}/7 votes`
      );

      continue;
    }

    if (r.status === "BUY") {
      lines.push(
        `🟢 ${r.symbol} | 4H: ${h4} ✅ | 1H: ${h1} ✅ | ${votes}/7 votes — BUY!`
      );
      continue;
    }

    if (r.status === "SELL") {
      lines.push(
        `🔴 ${r.symbol} | 4H: ${h4} ✅ | 1H: ${h1} ✅ | ${votes}/7 votes — SELL!`
      );
      continue;
    }
  }

  return sendMessage(lines.join("\n"));
}

// ═══════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════

export function notifyStartup(balance, mode) {
  return sendMessage(
    `🤖 <b>Deriv Bot Started</b>\n` +
    `Mode     : ${String(mode).toUpperCase()}\n` +
    `Balance  : $${Number(balance).toFixed(2)}\n` +
    `Status   : Scanning every 15s...`
  );
}

// ═══════════════════════════════════════════════════════
// TRADE OPENED
// ═══════════════════════════════════════════════════════

export function notifyTradeOpened({
  symbol,
  direction,
  stake,
  multiplier,
  limitOrder,
  strength,
  contractId,
}) {
  const side =
    direction === "MULTUP"
      ? "🟢 BUY"
      : "🔴 SELL";

  return sendMessage(
    `${side} <b>TRADE OPENED</b>\n` +
    `Symbol   : ${symbol}\n` +
    `Contract : ${contractId}\n` +
    `Stake    : $${Number(stake).toFixed(2)}\n` +
    `Leverage : x${multiplier}\n` +
    `Strength : ${Number(strength).toFixed(0)}%\n` +
    `SL       : $${limitOrder.stop_loss}\n` +
    `TP       : $${limitOrder.take_profit}`
  );
}

// ═══════════════════════════════════════════════════════
// RISK BLOCK
// ═══════════════════════════════════════════════════════

export function notifyRiskBlock(reason) {
  return sendMessage(
    `⚠️ <b>Risk Block</b>\n${reason}`
  );
}

// ═══════════════════════════════════════════════════════
// RECONNECTING
// ═══════════════════════════════════════════════════════

export function notifyReconnecting(error) {
  return sendMessage(
    `🔌 <b>Reconnecting...</b>\n` +
    `Reason: ${error}`
  );
}

// ═══════════════════════════════════════════════════════
// MAX TRADES
// ═══════════════════════════════════════════════════════

export function notifyMaxTrades(
  current,
  max
) {
  return sendMessage(
    `🔒 <b>Max trades reached</b>\n` +
    `Open: ${current}/${max}`
  );
}

// ═══════════════════════════════════════════════════════
// DAILY SUMMARY
// ═══════════════════════════════════════════════════════

export function notifyDailySummary({
  balance,
  dailyPnl,
  openTrades,
  consecutiveLosses,
}) {
  const icon =
    dailyPnl >= 0 ? "📈" : "📉";

  return sendMessage(
    `${icon} <b>Daily Summary</b>\n` +
    `Balance    : $${Number(balance).toFixed(2)}\n` +
    `Daily PnL  : ${dailyPnl >= 0 ? "+" : ""}$${Number(dailyPnl).toFixed(2)}\n` +
    `Open Trades: ${openTrades}\n` +
    `Loss Streak: ${consecutiveLosses}`
  );
}