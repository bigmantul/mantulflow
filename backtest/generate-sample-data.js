// ═══════════════════════════════════════════════════════
//  backtest/generate-sample-data.js
//
//  NOT real market data. This generates a synthetic but
//  internally-consistent price path (M15 resolution, then
//  aggregated up to H1 and D1) with regime-switching drift
//  so trending days/sessions occur often enough to actually
//  exercise the strategy's daily-bias and 1H-confirmation
//  logic. Use this ONLY to sanity-check that engine.js runs
//  end-to-end without errors and produces sane output —
//  NOT to draw any conclusion about real strategy edge.
// ═══════════════════════════════════════════════════════

import fs from "fs";

function generateM15(symbol, days = 365, startPrice = 1.1000, seed = 42) {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };

  const barsPerDay = 96; // 24h * 4 (15m bars)
  const totalBars = days * barsPerDay;
  const bars = [];

  let price = startPrice;
  let regimeBarsLeft = 0;
  let drift = 0;
  const baseEpoch = Math.floor(Date.now() / 1000) - totalBars * 900;

  for (let i = 0; i < totalBars; i++) {
    if (regimeBarsLeft <= 0) {
      // Switch regime every 1-4 days worth of bars
      regimeBarsLeft = Math.floor((1 + rand() * 3) * barsPerDay);
      const regimeRoll = rand();
      if (regimeRoll < 0.35) drift = (rand() - 0.5) * 0.00015;      // ranging
      else if (regimeRoll < 0.65) drift = 0.00012 + rand() * 0.00010; // uptrend
      else drift = -(0.00012 + rand() * 0.00010);                    // downtrend
    }
    regimeBarsLeft--;

    const noise = (rand() - 0.5) * 0.0010;
    const open = price;
    const close = open * (1 + drift + noise);
    const wick = Math.abs(close - open) * (0.3 + rand() * 0.7);
    const high = Math.max(open, close) + wick * rand();
    const low = Math.min(open, close) - wick * rand();
    const epoch = baseEpoch + i * 900;

    bars.push({ epoch, open: +open.toFixed(5), high: +high.toFixed(5), low: +low.toFixed(5), close: +close.toFixed(5) });
    price = close;
  }

  return { symbol, m15: bars };
}

function aggregate(m15, barsPer) {
  const out = [];
  for (let i = 0; i + barsPer <= m15.length; i += barsPer) {
    const chunk = m15.slice(i, i + barsPer);
    out.push({
      epoch: chunk[0].epoch,
      open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      close: chunk[chunk.length - 1].close,
    });
  }
  return out;
}

function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h || 1;
}

function guessStartPrice(symbol) {
  if (symbol.startsWith("frxXAUUSD")) return 2350;
  if (symbol.startsWith("frxXAGUSD")) return 28;
  if (symbol.includes("JPY")) return 148;
  if (symbol.startsWith("frx")) return 1.08;
  if (symbol === "cryBTCUSD") return 64000;
  if (symbol === "cryETHUSD") return 3200;
  if (/^(BOOM|CRASH)/.test(symbol)) return 9500;
  if (/^JD/.test(symbol)) return 1500;
  if (/^STPRNG/.test(symbol)) return 5500;
  if (/^R_|^1HZ/.test(symbol)) return 850;
  return 100;
}

export function generateSample({ symbol = "frxEURUSD", days = 365, startPrice, seed } = {}) {
  const resolvedPrice = startPrice ?? guessStartPrice(symbol);
  const resolvedSeed = seed ?? hashSeed(symbol);
  const { m15 } = generateM15(symbol, days, resolvedPrice, resolvedSeed);
  const h1 = aggregate(m15, 4);   // 4 * 15m = 1h
  const d1 = aggregate(m15, 96);  // 96 * 15m = 1 day
  return { symbol, d1, h1, m15 };
}

// CLI usage: node backtest/generate-sample-data.js [symbol] [days]
if (import.meta.url === `file://${process.argv[1]}`) {
  const symbol = process.argv[2] || "frxEURUSD";
  const days = parseInt(process.argv[3] || "365", 10);
  const data = generateSample({ symbol, days });
  fs.mkdirSync("backtest/data", { recursive: true });
  fs.writeFileSync(`backtest/data/${symbol}.json`, JSON.stringify(data));
  console.log(`Wrote backtest/data/${symbol}.json — d1:${data.d1.length} h1:${data.h1.length} m15:${data.m15.length} bars`);
}
