export function notifyCycleScan({
  balance,
  openTrades,
  maxTrades,
  session,
  results,
}) {
  const lines = [
    `📊 <b>Mantul — Scan Cycle</b>`,
    `Session : ${session}`,
    `Balance : $${balance.toFixed(2)}`,
    `Open    : ${openTrades}/${maxTrades}`,
    ``,
  ];

  for (const r of results) {

    // 🔒 LOCKED
    if (r.status === "LOCKED") {
      let remaining = "";

      if (r.remainingMinutes != null) {
        remaining = ` | Expires in ${r.remainingMinutes}m`;
      }

      lines.push(
        `🔒 ${r.symbol} | LOCKED — trade open${remaining}`
      );
      continue;
    }

    // 🕐 CLOSED MARKET
    if (r.status === "CLOSED") {
      lines.push(
        `🕐 ${r.symbol} | MARKET CLOSED`
      );
      continue;
    }

    // ⛔ FILTERED
    if (r.status === "FILTERED") {
      lines.push(
        `⛔ ${r.symbol} | FILTERED`
      );
      continue;
    }

    const h4 = (r.h4Bias || r.h4 || "neutral").toUpperCase();
    const h1 = (r.h1Bias || r.h1 || "neutral").toUpperCase();

    // HOLDS
    if (r.status === "HOLD") {

      // 4H Neutral
      if (h4 === "NEUTRAL") {
        lines.push(
          `⏸ ${r.symbol} | 4H: NEUTRAL ❌ | 4H neutral`
        );
        continue;
      }

      // 4H / 1H disagree
      if (
        h1 !== "NEUTRAL" &&
        h4 !== h1
      ) {
        lines.push(
          `⏸ ${r.symbol} | 4H: ${h4} ✅ | 1H: ${h1} ❌ disagrees`
        );
        continue;
      }

      // votes
      const votes =
        r.votes ??
        Math.round(((r.strength || 0) / 100) * 7);

      lines.push(
        `⏸ ${r.symbol} | 4H: ${h4} ✅ | 1H: ${h1} ✅ | ${votes}/7 votes`
      );

      continue;
    }

    // BUY / SELL
    if (r.status === "BUY" || r.status === "SELL") {

      const icon = r.status === "BUY"
        ? "🟢"
        : "🔴";

      const votes =
        r.votes ??
        Math.round(((r.strength || 0) / 100) * 7);

      lines.push(
        `${icon} ${r.symbol} | 4H: ${h4} ✅ | 1H: ${h1} ✅ | ${votes}/7 votes — ${r.status}!`
      );

      continue;
    }
  }

  return sendMessage(lines.join("\n"));
}