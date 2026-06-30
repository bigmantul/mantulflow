// ═══════════════════════════════════════════════════════
//  backtest/fetch-all-history.js
//
//  Loops every symbol in src/config/symbols.js and calls
//  the same fetchDeepHistory logic as fetch-history.js for
//  each one, writing backtest/data/<symbol>.json per symbol.
//
//  Run this on YOUR machine — NOT inside Claude's sandbox
//  (derivws.com is blocked there). Same restriction as
//  fetch-history.js.
//
//  Usage:
//    DERIV_PAT_TOKEN=xxx DERIV_APP_ID=yyy \
//      node backtest/fetch-all-history.js --days=1095 --mode=demo
//
//  --days=1095 = 3 years (365 * 3). This is the setting you
//  want for a 3-year backtest across all symbols.
//
//  This will take a while — 48 symbols x 3 timeframes, each
//  needing multiple paginated requests for 3 years of M15
//  data in particular (3 years of M15 = ~105,120 bars, which
//  at Deriv's 5000-per-request cap is ~21 requests per symbol
//  just for M15). A 1-second delay between symbols is added
//  to stay well clear of rate limits — expect this to run for
//  a meaningful amount of time, not a quick few minutes.
//
//  Safe to re-run / resume: if backtest/data/<symbol>.json
//  already exists, that symbol is skipped by default. Use
//  --force to re-fetch everything regardless.
// ═══════════════════════════════════════════════════════

import "dotenv/config";
import fs from "fs";
import { connectWebSocket, sendMessage } from "../src/utils/ws-client.js";
import { connectForMode } from "../src/auth/deriv-auth.js";
import { SYMBOLS } from "../src/config/symbols.js";

const DERIV_MAX_COUNT = 5000;
const DELAY_BETWEEN_SYMBOLS_MS = 1000;

function parseArgs(argv) {
  const opts = { days: 365, mode: "demo", force: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--force") { opts.force = true; continue; }
    const m = arg.match(/^--([\w]+)=(.+)$/);
    if (m) opts[m[1]] = isNaN(Number(m[2])) ? m[2] : Number(m[2]);
  }
  return opts;
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

// Identical paging logic to fetch-history.js — kept in sync deliberately.
async function fetchDeepHistory(ws, symbol, granularity, targetCount) {
  let allBars = [];
  let end = "latest";
  let requestNum = 0;
  const MAX_REQUESTS = 200;

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
    if (!batch.length) break;

    const seen = new Set(allBars.map(b => b.epoch));
    const fresh = batch.filter(b => !seen.has(b.epoch));
    if (!fresh.length) break;

    allBars = [...fresh, ...allBars].sort((a, b) => a.epoch - b.epoch);

    const oldestEpoch = batch[0].epoch;
    end = oldestEpoch - granularity;
  }

  return allBars.length > targetCount ? allBars.slice(allBars.length - targetCount) : allBars;
}

async function fetchSymbol(ws, symbol, days) {
  console.log(`\n[${symbol}] fetching ${days} days...`);
  const d1  = await fetchDeepHistory(ws, symbol, 86400, days);
  const h1  = await fetchDeepHistory(ws, symbol, 3600,  days * 24);
  const m15 = await fetchDeepHistory(ws, symbol, 900,   days * 96);

  fs.mkdirSync("backtest/data", { recursive: true });
  const outPath = `backtest/data/${symbol}.json`;
  fs.writeFileSync(outPath, JSON.stringify({ symbol, d1, h1, m15 }));

  console.log(`[${symbol}] done — d1:${d1.length} h1:${h1.length} m15:${m15.length} bars`);
}

async function main() {
  const opts = parseArgs(process.argv);
  const days = opts.days;

  console.log(`Fetching ${days} days (~${(days / 365).toFixed(1)} years) for ${SYMBOLS.length} symbols...`);
  console.log(`Mode: ${opts.mode} | Force re-fetch: ${opts.force}\n`);

  const wsUrl = await connectForMode(opts.mode, process.env.DERIV_PAT_TOKEN, process.env.DERIV_APP_ID);
  let ws = await connectWebSocket(wsUrl);

  let done = 0, skipped = 0, failed = 0;

  for (const symbol of SYMBOLS) {
    const outPath = `backtest/data/${symbol}.json`;

    if (!opts.force && fs.existsSync(outPath)) {
      console.log(`[skip] ${symbol} — data already exists (use --force to re-fetch)`);
      skipped++;
      continue;
    }

    try {
      await fetchSymbol(ws, symbol, days);
      done++;
    } catch (e) {
      console.error(`[FAILED] ${symbol}: ${e.message}`);
      failed++;
      // Reconnect in case the failure was connection-related
      try { ws.close(); } catch {}
      const freshUrl = await connectForMode(opts.mode, process.env.DERIV_PAT_TOKEN, process.env.DERIV_APP_ID);
      ws = await connectWebSocket(freshUrl);
    }

    await new Promise(r => setTimeout(r, DELAY_BETWEEN_SYMBOLS_MS));
  }

  console.log(`\n══════════════════════════════════════`);
  console.log(`  Fetched: ${done}  Skipped: ${skipped}  Failed: ${failed}`);
  console.log(`══════════════════════════════════════`);
  console.log(`\nRun: node backtest/run-all.js`);

  ws.close();
  process.exit(0);
}

main().catch(err => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
