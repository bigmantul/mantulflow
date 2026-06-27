// ═══════════════════════════════════════════════════════
//  backtest/fetch-history.js
//
//  Run this on YOUR machine / Render — NOT inside Claude's
//  sandbox, since derivws.com / api.deriv.com are blocked
//  by the sandbox's network allowlist (confirmed: 403
//  host_not_allowed when tested).
//
//  Usage:
//    DERIV_PAT_TOKEN=xxx DERIV_APP_ID=yyy \
//      node backtest/fetch-history.js frxEURUSD --days=365 --mode=demo
//
//  Pulls D1/H1/M15 candles and pages backward past Deriv's
//  per-request candle cap (5000) to assemble deep history,
//  then writes backtest/data/<symbol>.json in the exact
//  shape backtest/run.js expects.
// ═══════════════════════════════════════════════════════

import "dotenv/config";
import fs from "fs";
import { connectWebSocket, sendMessage } from "../src/utils/ws-client.js";
import { connectForMode } from "../src/auth/deriv-auth.js";

const DERIV_MAX_COUNT = 5000;

function parseArgs(argv) {
  const symbol = argv[2];
  const opts = { days: 365, mode: "demo" };
  for (const arg of argv.slice(3)) {
    const m = arg.match(/^--([\w]+)=(.+)$/);
    if (m) opts[m[1]] = isNaN(Number(m[2])) ? m[2] : Number(m[2]);
  }
  return { symbol, opts };
}

function normalize(rawCandles) {
  return rawCandles
    .map(c => ({
      epoch: c.epoch,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
    }))
    .sort((a, b) => a.epoch - b.epoch);
}

/**
 * Pages backward in time until `targetCount` bars are collected
 * or Deriv stops returning new (older) data. IMPORTANT: a batch
 * smaller than DERIV_MAX_COUNT does NOT mean history is exhausted
 * — it just means that particular request was capped. We keep
 * paging until a request comes back genuinely empty or yields zero
 * NEW (non-duplicate) bars, which are the only reliable signals
 * that we've hit the actual floor of available history.
 */
async function fetchDeepHistory(ws, symbol, granularity, targetCount) {
  let allBars = [];
  let end = "latest";
  let requestNum = 0;
  const MAX_REQUESTS = 200; // safety valve against runaway loops

  while (allBars.length < targetCount && requestNum < MAX_REQUESTS) {
    requestNum++;
    const resp = await sendMessage(ws, {
      ticks_history: symbol,
      style: "candles",
      granularity,
      count: DERIV_MAX_COUNT,
      end,
    }, "candles");

    const batch = normalize(resp?.candles ?? []);
    if (!batch.length) {
      console.log(`  ${symbol} g=${granularity}: no more data returned — stopping at ${allBars.length} bars`);
      break;
    }

    // Dedup against what we already have, then prepend (batch is older data)
    const seen = new Set(allBars.map(b => b.epoch));
    const fresh = batch.filter(b => !seen.has(b.epoch));
    if (!fresh.length) {
      console.log(`  ${symbol} g=${granularity}: no new bars in latest page — reached actual history floor at ${allBars.length} bars`);
      break;
    }

    allBars = [...fresh, ...allBars].sort((a, b) => a.epoch - b.epoch);

    const oldestEpoch = batch[0].epoch;
    end = oldestEpoch - granularity; // page further back next request

    console.log(`  ${symbol} g=${granularity}: ${allBars.length}/${targetCount} bars (oldest: ${new Date(allBars[0].epoch * 1000).toISOString().slice(0, 10)})`);
  }

  // Trim to the most recent `targetCount` if we overshot
  return allBars.length > targetCount ? allBars.slice(allBars.length - targetCount) : allBars;
}

async function main() {
  const { symbol, opts } = parseArgs(process.argv);
  if (!symbol) {
    console.error("Usage: node backtest/fetch-history.js <SYMBOL> [--days=365] [--mode=demo]");
    process.exit(1);
  }

  console.log(`Connecting to Deriv (${opts.mode})...`);
  const wsUrl = await connectForMode(opts.mode, process.env.DERIV_PAT_TOKEN, process.env.DERIV_APP_ID);
  const ws = await connectWebSocket(wsUrl);

  const days = opts.days;
  console.log(`\nFetching ${days} days of history for ${symbol}...`);

  const d1 = await fetchDeepHistory(ws, symbol, 86400, days);
  const h1 = await fetchDeepHistory(ws, symbol, 3600, days * 24);
  const m15 = await fetchDeepHistory(ws, symbol, 900, days * 96);

  fs.mkdirSync("backtest/data", { recursive: true });
  const outPath = `backtest/data/${symbol}.json`;
  fs.writeFileSync(outPath, JSON.stringify({ symbol, d1, h1, m15 }));

  console.log(`\nWrote ${outPath} — d1:${d1.length} h1:${h1.length} m15:${m15.length} bars`);
  console.log(`Run: node backtest/run.js ${symbol}`);

  ws.close();
  process.exit(0);
}

main().catch(err => {
  console.error("Fetch failed:", err.message);
  process.exit(1);
});
