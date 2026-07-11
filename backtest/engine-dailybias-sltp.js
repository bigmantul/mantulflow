// Daily Bias ENTRY (proven to beat random direction — see prior
// analysis) combined with SL/TP-ONLY exits, ATR-calibrated instead
// of the old unreachable fixed percentages. Isolates: is the new
// scalp signal the problem, or is "SL/TP only, no time exit" itself
// costing profit regardless of which entry drives it?
import { collectSignals, resetSymbolState, SIG_BUY, SIG_SELL } from "../src/strategy/signals.js";
import { calcAtrLocal } from "../src/strategy/scalp-signals.js";
import { FALLBACK_MULTIPLIERS } from "../src/trading/multipliers.js";

function pnlAtPrice({ entryPrice, stake, multiplier, direction }, price) {
  const dirSign = direction === "buy" ? 1 : -1;
  return stake * multiplier * ((price - entryPrice) / entryPrice) * dirSign;
}

function priceForPnl({ entryPrice, stake, multiplier, direction }, targetPnl) {
  const dirSign = direction === "buy" ? 1 : -1;
  return entryPrice * (1 + (targetPnl / (stake * multiplier)) * dirSign);
}

// Same stepped profit-lock mechanic as the original production
// engine (engine.js): step size = takeProfit-in-$ * trailingStopPct.
// Once price banks one step, the floor trails up behind it instead
// of giving everything back to breakeven or a loss.
function checkTrailingExit(position, bar, trailingStopPct) {
  if (!trailingStopPct || trailingStopPct <= 0) return null;
  const { direction, takeProfitPrice } = position;
  const takeProfitDollar = pnlAtPrice(position, takeProfitPrice);
  const bestPrice = direction === "buy" ? bar.high : bar.low;
  const worstPrice = direction === "buy" ? bar.low : bar.high;
  const bestPnl = pnlAtPrice(position, bestPrice);
  const worstPnl = pnlAtPrice(position, worstPrice);

  const stepSize = takeProfitDollar * trailingStopPct;
  const priorPeak = position.trailingPeakPnl || 0;
  const newPeak = Math.max(priorPeak, bestPnl);
  if (newPeak > priorPeak) position.trailingPeakPnl = newPeak;

  if (newPeak >= stepSize) {
    const stepsBanked = Math.floor(newPeak / stepSize);
    const lockedProfit = stepsBanked * stepSize;
    const floorPnl = Math.max(lockedProfit - stepSize, 0);
    if (worstPnl <= floorPnl) {
      return { price: priceForPnl(position, floorPnl), pnl: floorPnl, outcome: floorPnl > 0 ? "TRAIL" : "TRAIL_BE" };
    }
  }
  return null;
}

export function runDailyBiasSlTpOnly(opts) {
  const { symbol, d1, h1, m15, startEquity = 1000, stakeAmount, riskPct, slAtrMult = 1.5, tpAtrMult = 1.5, minStartIndex = 100 } = opts;
  if (!m15 || m15.length < minStartIndex + 5) throw new Error("not enough data");

  resetSymbolState(symbol);
  let equity = startEquity;
  const trades = [];
  let openPosition = null;

  const d1Counter = (() => { let i=0; return (t)=>{ while(i<d1.length && d1[i].epoch+86400<=t) i++; return i; }; })();
  const h1Counter  = (() => { let i=0; return (t)=>{ while(i<h1.length && h1[i].epoch+3600<=t) i++; return i; }; })();
  const growingD1 = [], growingH1 = [], growingM15 = [];
  let d1Pushed = 0, h1Pushed = 0;

  const _clockBox = { ms: Date.now() };
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length===0) return new RealDate(_clockBox.ms); return new RealDate(...a); }
    static now() { return _clockBox.ms; }
  }

  for (let i = minStartIndex; i < m15.length; i++) {
    const bar = m15[i];
    _clockBox.ms = bar.epoch * 1000;
    globalThis.Date = FakeDate;
    try {
      const td1 = d1Counter(bar.epoch); while (d1Pushed < td1) growingD1.push(d1[d1Pushed++]);
      const th1 = h1Counter(bar.epoch); while (h1Pushed < th1) growingH1.push(h1[h1Pushed++]);
      growingM15.push(bar);
      if (growingD1.length < 4 || growingH1.length < 20) continue;

      if (openPosition) {
        const { direction, stopLossPrice, takeProfitPrice } = openPosition;
        let exit = null;
        const trail = checkTrailingExit(openPosition, bar, opts.trailingStopPct);
        if (trail) {
          exit = { price: trail.price, outcome: trail.outcome };
        } else if (direction === "buy") {
          if (bar.low <= stopLossPrice) exit = { price: stopLossPrice, outcome: "SL" };
          else if (bar.high >= takeProfitPrice) exit = { price: takeProfitPrice, outcome: "TP" };
        } else {
          if (bar.high >= stopLossPrice) exit = { price: stopLossPrice, outcome: "SL" };
          else if (bar.low <= takeProfitPrice) exit = { price: takeProfitPrice, outcome: "TP" };
        }
        if (exit) {
          const pnl = pnlAtPrice(openPosition, exit.price);
          equity += pnl;
          trades.push({ symbol, direction, pnl, outcome: exit.outcome, entryEpoch: openPosition.entryEpoch, exitEpoch: bar.epoch });
          openPosition = null;
        }
        continue;
      }

      const d1p = growingD1[growingD1.length-1];
      growingD1.push({...d1p, epoch: d1p.epoch+1});
      const h1p = growingH1[growingH1.length-1];
      growingH1.push({...h1p, epoch: h1p.epoch+1});
      const m15p = growingM15[growingM15.length-1];
      growingM15.push({...m15p, epoch: m15p.epoch+1});
      let signalResult;
      try {
        signalResult = collectSignals({ d1: growingD1, h1: growingH1, m15: growingM15, symbol });
      } finally {
        growingD1.pop(); growingH1.pop(); growingM15.pop();
      }

      if (signalResult.signal !== SIG_BUY && signalResult.signal !== SIG_SELL) continue;

      const atr = calcAtrLocal(growingM15.slice(-30), 14) || (bar.close * 0.001);
      const direction = signalResult.signal === SIG_BUY ? "buy" : "sell";
      const slDist = atr * slAtrMult, tpDist = atr * tpAtrMult;
      const multiplier = FALLBACK_MULTIPLIERS[symbol] ?? 10;
      const stake = stakeAmount !== undefined ? Math.max(1, stakeAmount) : Math.max(1, parseFloat((equity * (riskPct ?? 0.02)).toFixed(2)));
      openPosition = {
        direction, entryPrice: bar.open, entryEpoch: bar.epoch, stake, multiplier,
        stopLossPrice: direction === "buy" ? bar.open - slDist : bar.open + slDist,
        takeProfitPrice: direction === "buy" ? bar.open + tpDist : bar.open - tpDist,
      };
    } finally {
      globalThis.Date = RealDate;
    }
  }

  const wins = trades.filter(t=>t.pnl>0), losses = trades.filter(t=>t.pnl<=0);
  const gp = wins.reduce((s,t)=>s+t.pnl,0), gl = Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  return {
    symbol, totalTrades: trades.length, wins: wins.length, losses: losses.length,
    winRatePct: trades.length ? +(wins.length/trades.length*100).toFixed(1) : 0,
    profitFactor: gl>0 ? +(gp/gl).toFixed(2) : (gp>0?Infinity:0),
    totalReturnPct: +(((equity-startEquity)/startEquity)*100).toFixed(2),
    trades,
  };
}
