// Generic SL/TP-only engine — same exit convention as engine-scalp.js,
// but takes any signal function so different entry primitives can be
// tested fairly against each other under identical exit rules.
import { FALLBACK_MULTIPLIERS } from "../src/trading/multipliers.js";

function pnlAtPrice({ entryPrice, stake, multiplier, direction }, price) {
  const dirSign = direction === "buy" ? 1 : -1;
  return stake * multiplier * ((price - entryPrice) / entryPrice) * dirSign;
}

export function runGenericSlTp({ symbol, m15, signalFn, signalParams = {}, startEquity = 1000, stakeAmount = 1, minStartIndex = 100 }) {
  if (!m15 || m15.length < minStartIndex + 5) throw new Error("not enough data");
  let equity = startEquity;
  const trades = [];
  let openPosition = null;
  const growingM15 = [];
  const multiplier = FALLBACK_MULTIPLIERS[symbol] ?? 10;

  for (let i = minStartIndex; i < m15.length; i++) {
    const bar = m15[i];
    growingM15.push(bar);

    if (openPosition) {
      const { direction, stopLossPrice, takeProfitPrice } = openPosition;
      let exit = null;
      if (direction === "buy") {
        if (bar.low <= stopLossPrice) exit = { price: stopLossPrice, outcome: "SL" };
        else if (bar.high >= takeProfitPrice) exit = { price: takeProfitPrice, outcome: "TP" };
      } else {
        if (bar.high >= stopLossPrice) exit = { price: stopLossPrice, outcome: "SL" };
        else if (bar.low <= takeProfitPrice) exit = { price: takeProfitPrice, outcome: "TP" };
      }
      if (exit) {
        const pnl = pnlAtPrice(openPosition, exit.price);
        equity += pnl;
        trades.push({ symbol, direction, pnl, outcome: exit.outcome });
        openPosition = null;
      }
      continue;
    }

    const placeholder = { ...bar };
    growingM15.push(placeholder);
    const sig = signalFn({ m15: growingM15 }, signalParams);
    growingM15.pop();

    if (sig.signal === "NONE") continue;
    openPosition = {
      direction: sig.signal === "BUY" ? "buy" : "sell",
      entryPrice: sig.entryPrice, stake: stakeAmount, multiplier,
      stopLossPrice: sig.stopLossPrice, takeProfitPrice: sig.takeProfitPrice,
    };
  }

  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s,t)=>s+t.pnl,0), gl = Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  return {
    symbol, trades, totalTrades: trades.length, wins: wins.length,
    winRatePct: trades.length ? +(wins.length/trades.length*100).toFixed(1) : 0,
    profitFactor: gl>0 ? +(gp/gl).toFixed(2) : (gp>0?Infinity:0),
    totalReturnPct: +(((equity-startEquity)/startEquity)*100).toFixed(2),
  };
}
