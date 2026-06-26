// ═══════════════════════════════════════════════════════
//  src/utils/telegram.js
//
//  Notifications fully integrated with the Daily Bias
//  Strategy (4-stage state machine: D1 -> Trend -> 1H -> 15M)
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

// ── HELPERS ───────────────────────────────────────────

// breakdown items now look like: { step, result, reason }
// e.g. { step: "Stage1 DailyBias", result: "BULLISH", reason: "..." }
function stageIcon(result) {
  if (!result) return "⬜";
  const r = result.toUpperCase();
  if (r.includes("BUY") || r.includes("BULLISH") || r.includes("AGREES") || r.includes("ENTRY MODE")) return "🟢";
  if (r.includes("SELL") || r.includes("BEARISH") || r.includes("MISMATCH")) return "🔴";
  if (r.includes("OUTSIDE SESSION")) return "🌙";
  return "⬜";
}

/**
 * Format the 4-stage breakdown into readable Telegram lines.
 * breakdown = [{ step, result, reason }]
 */
function formatBreakdown(breakdown) {
  if (!breakdown || !breakdown.length) return "";
  return breakdown
    .map(s => `  ${stageIcon(s.result)} <b>${s.step}</b>: ${s.result}\n     <i>${s.reason}</i>`)
    .join("\n");
}

// ── STARTUP ───────────────────────────────────────────
export function notifyStartup(balance, mode, label, botToken, chatId) {
  return sendMessage(
    `🤖 <b>${label || "Bot"} — Started</b>\n` +
    `Mode       : ${(mode || "demo").toUpperCase()}\n` +
    `Balance    : $${balance.toFixed(2)}\n` +
    `Engine     : Daily Bias Strategy (4-stage)\n` +
    `Stages     : Daily Bias → Trend Check → 1H Confirm → 15M Entry\n` +
    `Timeframes : D1 / H1 / M15\n` +
    `FX Session : London + New York + overlap only\n` +
    `Synthetics : 24/7, no session restriction`,
    botToken, chatId
  );
}

// ── TRADE OPENED ──────────────────────────────────────
export function notifyTradeOpened({
  symbol, direction, stake, multiplier, limitOrder,
  contractId, label, botToken, chatId,
  breakdown, dailyBias,
}) {
  const isBuy  = direction === "MULTUP";
  const icon   = isBuy ? "🟢 BUY" : "🔴 SELL";
  const slText = limitOrder ? `\nSL         : $${limitOrder.stop_loss}` : "";
  const tpText = limitOrder ? `\nTP         : $${limitOrder.take_profit}` : "";

  const breakdownBlock = breakdown && breakdown.length
    ? `\n\n<b>4-Stage Breakdown:</b>\n${formatBreakdown(breakdown)}`
    : "";

  return sendMessage(
    `${icon} <b>${label || "Bot"} — ${symbol}</b>\n` +
    `Daily Bias : ${(dailyBias || "—").toUpperCase()}\n` +
    `Contract   : ${contractId}\n` +
    `Stake      : $${stake.toFixed(2)} x${multiplier}` +
    slText + tpText +
    breakdownBlock,
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
//
// r.status: "LOCKED" | "CLOSED" | "FILTERED" | "HOLD" | "BUY" | "SELL"
// r.dailyBias: "bullish" | "bearish" | "none" (present on HOLD/BUY/SELL)
// r.breakdown: [{ step, result, reason }] (present on HOLD/BUY/SELL)
// r.rejectReason: short reason string (present on HOLD)
//
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

    // ── LOCKED ─────────────────────────────────────────
    if (r.status === "LOCKED") {
      const cd = r.countdown ? r.countdown : "";
      lines.push(`🔒 ${sym} | LOCKED${cd}`);

    // ── MARKET CLOSED ──────────────────────────────────
    } else if (r.status === "CLOSED") {
      lines.push(`🕐 ${sym} | MARKET CLOSED`);

    // ── FILTERED ───────────────────────────────────────
    } else if (r.status === "FILTERED") {
      lines.push(`⛔ ${sym} | FILTERED — poor volatility`);

    // ── HOLD ───────────────────────────────────────────
    } else if (r.status === "HOLD") {
      const bias = (r.dailyBias || "none").toUpperCase();
      const biasIcon = bias === "BULLISH" ? "🟢" : bias === "BEARISH" ? "🔴" : "⬜";

      // Find which stage is currently blocking, for a quick one-line summary
      const lastStage = r.breakdown && r.breakdown.length
        ? r.breakdown[r.breakdown.length - 1]
        : null;
      const stageLabel = lastStage ? lastStage.step.replace(/^Stage\d /, "") : "—";
      const shortReason = r.rejectReason || (lastStage ? lastStage.reason : "no data");

      lines.push(`⏸ ${sym} | HOLD | Bias: ${biasIcon} ${bias} | ${stageLabel}: ${shortReason}`);

    // ── BUY / SELL ─────────────────────────────────────
    } else if (r.status === "BUY" || r.status === "SELL") {
      const icon = r.status === "BUY" ? "🟢" : "🔴";
      const bias = (r.dailyBias || "—").toUpperCase();

      lines.push(`${icon} ${sym} | ${r.status} | Daily Bias: ${bias}`);
    }
  }

  return sendMessage(lines.join("\n"), botToken, chatId);
}