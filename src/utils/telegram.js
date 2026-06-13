// ═══════════════════════════════════════════════════════
//  src/utils/telegram.js
//
//  Notifications fully integrated with Multi-Strategy
//  Signal Engine (5 strategies + conflict engine)
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

function strategyIcon(signal) {
  if (signal === "BUY")  return "🟢";
  if (signal === "SELL") return "🔴";
  return "⬜";
}

/**
 * Format a strategy breakdown array into readable lines.
 * breakdown = [{ name, signal }]
 */
function formatBreakdown(breakdown) {
  if (!breakdown || !breakdown.length) return "";
  return breakdown
    .map(s => `  ${strategyIcon(s.signal)} ${s.name.padEnd(16)}: ${s.signal}`)
    .join("\n");
}

function voteBar(votes, total = 5) {
  const filled = Math.round((votes / total) * 5);
  return "█".repeat(filled) + "░".repeat(5 - filled);
}

// ── STARTUP ───────────────────────────────────────────
export function notifyStartup(balance, mode, label, botToken, chatId) {
  return sendMessage(
    `🤖 <b>${label || "Bot"} — Started</b>\n` +
    `Mode       : ${(mode || "demo").toUpperCase()}\n` +
    `Balance    : $${balance.toFixed(2)}\n` +
    `Engine     : Multi-Strategy (5 strategies)\n` +
    `Strategies : Trend | S&amp;D | SMC | Breakout | MeanRev\n` +
    `Timeframes : 4H / 1H / 30M / 15M\n` +
    `Exit       : SL/TP or 2hr forced close`,
    botToken, chatId
  );
}

// ── TRADE OPENED ──────────────────────────────────────
export function notifyTradeOpened({
  symbol, direction, stake, multiplier, limitOrder,
  strength, contractId, label, botToken, chatId,
  breakdown, buyCount, sellCount,
}) {
  const isBuy  = direction === "MULTUP";
  const icon   = isBuy ? "🟢 BUY" : "🔴 SELL";
  const votes  = isBuy ? (buyCount ?? 0) : (sellCount ?? 0);
  const slText = limitOrder ? `\nSL         : $${limitOrder.stop_loss}` : "";
  const tpText = limitOrder ? `\nTP         : $${limitOrder.take_profit}` : "";

  // Strategy breakdown block
  const breakdownBlock = breakdown && breakdown.length
    ? `\n\n<b>Strategy Votes:</b>\n${formatBreakdown(breakdown)}\n` +
      `  ${"─".repeat(28)}\n` +
      `  ${isBuy ? "BUY" : "SELL"} votes : ${votes}/5  ${voteBar(votes)}\n` +
      `  Strength  : ${strength ?? 0}%`
    : `\nStrength   : ${strength ?? 0}% (${votes}/5 strategies)`;

  return sendMessage(
    `${icon} <b>${label || "Bot"} — ${symbol}</b>\n` +
    `Contract   : ${contractId}\n` +
    `Stake      : $${stake.toFixed(2)} x${multiplier}` +
    slText + tpText +
    `\nFailsafe   : ⏱️ Force closes in 2hrs` +
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
      // countdown comes from portfolio.getCountdown() — do NOT modify it here
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
      // Show strategy vote breakdown for HOLD
      const buyVotes  = r.breakdown ? r.breakdown.filter(s => s.signal === "BUY").length  : 0;
      const sellVotes = r.breakdown ? r.breakdown.filter(s => s.signal === "SELL").length : 0;

      let holdReason;
      if (buyVotes > 0 && sellVotes > 0) {
        holdReason = `⚡ CONFLICT — B:${buyVotes} S:${sellVotes} (signals cancel)`;
      } else if (buyVotes === 0 && sellVotes === 0) {
        holdReason = `B:0 S:0 — no setup found`;
      } else {
        holdReason = `B:${buyVotes} S:${sellVotes}`;
      }

      // Which strategies fired (if any)
      const fired = r.breakdown
        ? r.breakdown.filter(s => s.signal !== "HOLD").map(s => s.name).join(", ")
        : "";

      lines.push(
        `⏸ ${sym} | HOLD | ${holdReason}` +
        (fired ? ` | [${fired}]` : "")
      );

    // ── BUY / SELL ─────────────────────────────────────
    } else if (r.status === "BUY" || r.status === "SELL") {
      const icon      = r.status === "BUY" ? "🟢" : "🔴";
      const votes     = r.breakdown
        ? r.breakdown.filter(s => s.signal === r.status).length
        : 0;
      const strength  = r.strength ?? Math.round((votes / 5) * 100);

      // Which strategies voted for this direction
      const voters = r.breakdown
        ? r.breakdown.filter(s => s.signal === r.status).map(s => s.name).join(", ")
        : "—";

      lines.push(
        `${icon} ${sym} | ${r.status} | Votes: ${votes}/5 (${strength}%)\n` +
        `   Strategies: ${voters}`
      );
    }
  }

  return sendMessage(lines.join("\n"), botToken, chatId);
}