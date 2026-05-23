// ═══════════════════════════════════════════════════════
//  src/index.js — Main bot loop
// ═══════════════════════════════════════════════════════

import "dotenv/config";

import { connectForMode }                from "./auth/deriv-auth.js";
import { connectWebSocket, sendMessage } from "./utils/ws-client.js";
import { getMultiTf }                    from "./data/candles.js";
import {
  getLatestSignalMtf,
  getSignalStrength,
  getVolatilityScalar,
  marketIsTradeable,
  get15mTrend,
  getTradeReason,
  sessionName,
  isMarketOpen,
} from "./strategy/signals.js";
import { placeTradeWithRetry }           from "./trading/trader.js";
import {
  initPortfolio,
  syncActiveSymbols,
  getActiveSymbols,
  getOpenCount,
  lockSymbol,
} from "./trading/portfolio.js";
import { RiskManager, StopLossTakeProfit } from "./risk/risk-manager.js";
import { startHealthServer }               from "./utils/health-server.js";
import {
  notifyStartup,
  notifyTradeOpened,
  notifyRiskBlock,
  notifyReconnecting,
  notifyMaxTrades,
  notifyDailySummary,
} from "./utils/telegram.js";


// ═══════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════
const SYMBOLS = [
  "R_75",
  "R_100",
  "frxXAUUSD",
  "frxXAGUSD",
  "cryBTCUSD",
  "cryETHUSD",
];

const POLL_SECS        = 15;
const MAX_IDLE_SECS    = 45;
const TRADING_MODE     = "demo";   // "demo" or "real"
const DAILY_SUMMARY_HR = 23;       // UTC hour to send daily summary (23 = 11pm)


// ═══════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════

async function getBalance(ws) {
  const resp = await sendMessage(ws, { balance: 1 }, "balance");
  return parseFloat(resp.balance.balance);
}

function sleep(secs) {
  return new Promise(resolve => setTimeout(resolve, secs * 1000));
}


// ═══════════════════════════════════════════════════════
//  MAIN BOT LOOP
// ═══════════════════════════════════════════════════════
async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  Launching bot...");
  console.log("  Strategy  : Smart Money Concepts (SMC)");
  console.log("  Timeframes: 5m execution | 15m entry | 4H bias");
  console.log("═══════════════════════════════════════════════\n");

  initPortfolio(SYMBOLS);

  const rm   = new RiskManager();
  const sltp = new StopLossTakeProfit();

  let lastSummaryDate = "";   // tracks when we last sent daily summary

  // ── OUTER LOOP — reconnects on any failure ───────────
  while (true) {

    let lastApiCall = Date.now();

    try {

      // STEP 1: Connect
      console.log("🔌 Connecting to Deriv...");
      const wsUrl = await connectForMode(TRADING_MODE);
      const ws    = await connectWebSocket(wsUrl);
      lastApiCall = Date.now();

      // STEP 2: Sync portfolio
      const openCount = await syncActiveSymbols(ws);
      lastApiCall     = Date.now();
      rm.openTrades   = openCount;
      console.log(`Open trades: ${openCount}/${rm.maxOpen} | Slots: ${Math.max(0, rm.maxOpen - openCount)}`);

      // STEP 3: Get balance
      let balance = await getBalance(ws);
      lastApiCall = Date.now();
      if (rm.startingBalance === null) rm.setStartingBalance(balance);
      console.log(`💰 Balance: $${balance.toFixed(2)}\n`);

      // Send startup notification
      await notifyStartup(balance, TRADING_MODE);

      // ── INNER LOOP ────────────────────────────────────
      while (true) {

        await sleep(POLL_SECS);

        // Proactive reconnect if idle
        if ((Date.now() - lastApiCall) / 1000 > MAX_IDLE_SECS) {
          console.log("⏱️  Connection idle — reconnecting proactively...");
          ws.close();
          break;
        }

        // Refresh balance + portfolio
        balance     = await getBalance(ws);
        lastApiCall = Date.now();

        const currentOpen = await syncActiveSymbols(ws);
        lastApiCall       = Date.now();
        rm.openTrades     = currentOpen;

        console.log(
          `\n📡 Session: ${sessionName()} | Balance: $${balance.toFixed(2)} | ` +
          `Open: ${currentOpen}/${rm.maxOpen}`
        );

        // ── DAILY SUMMARY ─────────────────────────────
        const todayStr  = new Date().toISOString().slice(0, 10);
        const utcHour   = new Date().getUTCHours();
        if (utcHour === DAILY_SUMMARY_HR && lastSummaryDate !== todayStr) {
          lastSummaryDate = todayStr;
          await notifyDailySummary({
            balance,
            dailyPnl:          rm.dailyPnl,
            openTrades:        currentOpen,
            consecutiveLosses: rm.consecutiveLosses,
          });
        }

        // ── MAX OPEN TRADES CHECK ─────────────────────
        if (currentOpen >= rm.maxOpen) {
          console.log(`🔒 Max open trades (${currentOpen}/${rm.maxOpen}) — waiting`);
          await notifyMaxTrades(currentOpen, rm.maxOpen);
          continue;
        }

        // ── OTHER RISK CHECKS ─────────────────────────
        if (!rm.canTrade(balance)) {
          const status = rm.status();
          const reason =
            status.consecutiveLosses >= rm.maxConsecutiveLosses
              ? `${status.consecutiveLosses} consecutive losses`
              : `Daily loss limit hit ($${Math.abs(status.dailyPnl).toFixed(2)})`;
          console.log("🚫 Risk block — skipping cycle");
          await notifyRiskBlock(reason);
          continue;
        }

        const slotsLeft = rm.maxOpen - currentOpen;
        console.log(`✅ ${slotsLeft} slot(s) available — scanning...`);

        // ── SYMBOL LOOP ───────────────────────────────
        let tradesPlacedThisCycle = 0;

        for (const symbol of SYMBOLS) {

          if (tradesPlacedThisCycle >= slotsLeft) {
            console.log(`Slot limit reached — stopping scan`);
            break;
          }

          if (getOpenCount() >= rm.maxOpen) {
            console.log(`🔒 Max trades reached mid-scan — stopping`);
            break;
          }

          const activeSymbols = getActiveSymbols();

          if (activeSymbols.has(symbol)) {
            console.log(`${symbol} | LOCKED (trade open) — skipping`);
            continue;
          }

          if (!isMarketOpen(symbol)) {
            console.log(`${symbol} | MARKET CLOSED — skipping`);
            continue;
          }

          // Fetch candles
          const tf = await getMultiTf(ws, symbol);
          lastApiCall = Date.now();

          const df5  = tf.m5;
          const df15 = tf.m15;
          const df4h = tf.h4;

          if (!df5 || df5.length < 2) continue;

          if (!marketIsTradeable(df5)) {
            console.log(`${symbol} | FILTERED (poor market conditions)`);
            continue;
          }

          // SMC signal
          const signal = getLatestSignalMtf(df5, df15, df4h);

          if (signal === 0) {
            const trend    = get15mTrend(df15);
            const strength = getSignalStrength(df5, df15, df4h);
            console.log(`${symbol} | HOLD | HTF: ${trend} | Strength: ${strength.toFixed(0)}%`);
            continue;
          }

          // Signal fired
          const label     = signal === 1 ? "BUY"    : "SELL";
          const direction = signal === 1 ? "MULTUP" : "MULTDOWN";

          const baseStake  = rm.calculateStake(balance);
          const volScalar  = getVolatilityScalar(df5);
          const stake      = parseFloat(Math.max(baseStake * volScalar, rm.minStake).toFixed(2));
          const strength   = getSignalStrength(df5, df15, df4h);
          const limitOrder = sltp.getMultiplierLimitOrder(stake);

          // Get multiplier from fallback/cache for notification
          const multiplier = 100; // will be auto-corrected by placeTradeWithRetry if wrong

          console.log(
            `\n${symbol} | ${label} | Strength: ${strength.toFixed(0)}% | ` +
            `Stake: $${stake.toFixed(2)} (scalar ${volScalar.toFixed(2)}) | ` +
            `Limit: SL=$${limitOrder.stop_loss} TP=$${limitOrder.take_profit}`
          );
          console.log(getTradeReason(df5, df15, df4h));

          // Place trade
          const result = await placeTradeWithRetry(ws, symbol, direction, stake, limitOrder);

          if (result) {
            lastApiCall = Date.now();
            lockSymbol(symbol);
            rm.tradeOpened();
            tradesPlacedThisCycle++;

            // Send Telegram notification
            await notifyTradeOpened({
              symbol,
              direction,
              stake,
              multiplier,
              limitOrder,
              strength,
              contractId: typeof result === "object" ? result.contractId : "N/A",
            });

            console.log(
              `✅ Trade recorded. Open: ${rm.openTrades}/${rm.maxOpen} | ` +
              `Slots left: ${rm.maxOpen - rm.openTrades} | ` +
              `Locked: ${[...getActiveSymbols()].sort().join(", ")}`
            );
          }

        } // end symbol loop

      } // end inner loop

    } catch (e) {
      console.error("\n❌ Connection lost:", e.message);
      console.log("🔄 Reconnecting in 10 seconds...\n");
      await notifyReconnecting(e.message);
      await sleep(10);
    }

  } // end outer loop
}


// ═══════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════
startHealthServer();
main();