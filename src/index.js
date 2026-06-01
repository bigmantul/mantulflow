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
  notifyCycleScan,
} from "./utils/telegram.js";


// ═══════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════
const SYMBOLS = [
  // Forex
  "frxEURUSD", "frxGBPUSD", "frxUSDJPY", "frxUSDCHF",
  "frxAUDUSD", "frxUSDCAD", "frxNZDUSD",
  // Metals
  "frxXAUUSD", "frxXAGUSD",
  // Crypto
  "cryBTCUSD", "cryETHUSD",
];

const POLL_SECS        = 15;
const MAX_IDLE_SECS    = 30;
const TRADING_MODE     = "demo";
const DAILY_SUMMARY_HR = 23;


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

  let lastSummaryDate = "";

  // ── OUTER LOOP ───────────────────────────────────────
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

      // STEP 3: Balance
      let balance = await getBalance(ws);
      lastApiCall = Date.now();
      if (rm.startingBalance === null) rm.setStartingBalance(balance);
      console.log(`💰 Balance: $${balance.toFixed(2)}\n`);

      await notifyStartup(balance, TRADING_MODE);

      // ── INNER LOOP ────────────────────────────────────
      while (true) {

        await sleep(POLL_SECS);

        if ((Date.now() - lastApiCall) / 1000 > MAX_IDLE_SECS) {
          console.log("⏱️  Connection idle — reconnecting proactively...");
          ws.close();
          break;
        }

        balance     = await getBalance(ws);
        lastApiCall = Date.now();

        const currentOpen = await syncActiveSymbols(ws);
        lastApiCall       = Date.now();
        rm.openTrades     = currentOpen;

        console.log(
          `\n📡 Session: ${sessionName()} | Balance: $${balance.toFixed(2)} | ` +
          `Open: ${currentOpen}/${rm.maxOpen}`
        );

        // Daily summary
        const todayStr = new Date().toISOString().slice(0, 10);
        const utcHour  = new Date().getUTCHours();
        if (utcHour === DAILY_SUMMARY_HR && lastSummaryDate !== todayStr) {
          lastSummaryDate = todayStr;
          await notifyDailySummary({
            balance,
            dailyPnl:          rm.dailyPnl,
            openTrades:        currentOpen,
            consecutiveLosses: rm.consecutiveLosses,
          });
        }

        // Max open trades check
        if (currentOpen >= rm.maxOpen) {
          console.log(`🔒 Max open trades (${currentOpen}/${rm.maxOpen}) — waiting`);
          await notifyMaxTrades(currentOpen, rm.maxOpen);
          continue;
        }

        // Risk check
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
        // Collect results for Telegram cycle summary
        const cycleResults        = [];
        let   tradesPlacedThisCycle = 0;

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

          // Locked
          if (activeSymbols.has(symbol)) {
            console.log(`${symbol} | LOCKED (trade open) — skipping`);
            cycleResults.push({ symbol, status: "LOCKED" });
            continue;
          }

          // Market closed
          if (!isMarketOpen(symbol)) {
            console.log(`${symbol} | MARKET CLOSED — skipping`);
            cycleResults.push({ symbol, status: "CLOSED" });
            continue;
          }

          // Fetch candles
          const tf = await getMultiTf(ws, symbol);
          lastApiCall = Date.now();

          const df5  = tf.m5;
          const df15 = tf.m15;
          const df4h = tf.h4;

          if (!dfM15 || dfM15.length < 2) continue;

          // Market quality filter
          if (!marketIsTradeable(dfM15)) {
            console.log(`${symbol} | FILTERED (poor market conditions)`);
            cycleResults.push({ symbol, status: "FILTERED" });
            continue;
          }

          // SMC signal
          const signal = getLatestSignalMtf(dfM15, dfH1, dfH4);

          if (signal === 0) {
            const trend    = get15mTrend(dfH1);
            const strength = getSignalStrength(dfM15, dfH1, dfH4);
            console.log(`${symbol} | HOLD | HTF: ${trend} | Strength: ${strength.toFixed(0)}%`);
            cycleResults.push({ symbol, status: "HOLD", trend, strength });
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
          const multiplier = 100;

          console.log(
            `\n${symbol} | ${label} | Strength: ${strength.toFixed(0)}% | Stake: $${stake.toFixed(2)} | Expires: 2hr`
          );
          console.log(getTradeReason(dfM15, dfH1, dfH4));

          cycleResults.push({ symbol, status: label, strength });

          // Place trade
          const result = await placeTradeWithRetry(ws, symbol, direction, stake, limitOrder);

          if (result) {
            lastApiCall = Date.now();
            lockSymbol(symbol);
            rm.tradeOpened();
            tradesPlacedThisCycle++;

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

        // Send full cycle summary to Telegram
        if (cycleResults.length > 0) {
          await notifyCycleScan({
            balance,
            openTrades:  currentOpen,
            maxTrades:   rm.maxOpen,
            session:     sessionName(),
            results:     cycleResults,
          });
        }

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