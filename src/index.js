// ═══════════════════════════════════════════════════════
//  src/index.js — Main bot loop (standalone)
// ═══════════════════════════════════════════════════════

import "dotenv/config";

import { connectForMode }                from "./auth/deriv-auth.js";
import { connectWebSocket, sendMessage } from "./utils/ws-client.js";
import { getMultiTf }                    from "./data/candles.js";
import {
  getVolatilityScalar,
  marketIsTradeable,
  get15mTrend,
  getTradeReason,
  sessionName,
  isMarketOpen,
  collectSignals,
} from "./strategy/signals.js";
import { placeTradeWithRetry, startForcedCloseTimer } from "./trading/trader.js";
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
  "frxGBPJPY", "frxEURGBP", "frxEURCHF", "frxEURCAD", "frxEURAUD",

  // Metals
  "frxXAUUSD", "frxXAGUSD",

  // Crypto
  "cryBTCUSD", "cryETHUSD",

  // Boom & Crash
  "BOOM500",
  "CRASH500",

  // Jump Indices
  "JD75",
  "JD100",

  // Volatility Indices
  "R_75",
  "R_100",
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
  console.log("  Strategy  : Multi-Strategy Signal Engine");
  console.log("  Strategies: Trend | S&D | SMC | Breakout | MeanRev");
  console.log("  Timeframes: 4H / 1H / 30M / 15M");
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

        const cycleResults          = [];
        let   tradesPlacedThisCycle = 0;

        // ── SYMBOL LOOP ───────────────────────────────
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
            cycleResults.push({ symbol, status: "LOCKED" });
            continue;
          }

          if (!isMarketOpen(symbol)) {
            console.log(`${symbol} | MARKET CLOSED — skipping`);
            cycleResults.push({ symbol, status: "CLOSED" });
            continue;
          }

          // Fetch the 3 timeframes used by the Daily Bias strategy
          const tf = await getMultiTf(ws, symbol);
          const { d1: dfD1, h1: dfH1, m15: dfM15 } = tf;
          lastApiCall = Date.now();

          if (!dfM15 || dfM15.length < 2) continue;

          // Global volatility filter
          if (!marketIsTradeable(dfM15)) {
            console.log(`${symbol} | FILTERED (poor market conditions)`);
            cycleResults.push({ symbol, status: "FILTERED" });
            continue;
          }

          // Run Daily Bias strategy
          const result = collectSignals({ d1: dfD1, h1: dfH1, m15: dfM15 });
          const { signal, breakdown, reason, dailyBias } = result;

          if (signal === 0) {
            console.log(`${symbol} | HOLD | Bias: ${(dailyBias || "none").toUpperCase()} | ${reason}`);
            cycleResults.push({
              symbol,
              status:    "HOLD",
              dailyBias: dailyBias || "none",
              reason,
            });
            continue;
          }

          // Signal fired
          const label     = signal === 1 ? "BUY"    : "SELL";
          const direction = signal === 1 ? "MULTUP" : "MULTDOWN";

          const baseStake  = rm.calculateStake(balance);
          const volScalar  = getVolatilityScalar(dfM15);
          const stake      = parseFloat(Math.max(baseStake * volScalar, rm.minStake).toFixed(2));
          const limitOrder = sltp.getMultiplierLimitOrder(stake);
          const multiplier = 100;

          console.log(
            `\n${symbol} | ${label} | Daily Bias: ${dailyBias.toUpperCase()} | Stake: $${stake.toFixed(2)}`
          );
          console.log(getTradeReason({ d1: dfD1, h1: dfH1, m15: dfM15 }));

          cycleResults.push({ symbol, status: label, dailyBias });

          // Place trade
          const tradeResult = await placeTradeWithRetry(ws, symbol, direction, stake, limitOrder);

          if (tradeResult) {
            lastApiCall = Date.now();
            lockSymbol(symbol);
            rm.tradeOpened();
            tradesPlacedThisCycle++;

            startForcedCloseTimer({
              contractId: typeof tradeResult === "object" ? tradeResult.contractId : String(tradeResult),
              symbol,
              direction,
              stake,
              token:        process.env.DERIV_PAT_TOKEN,
              appId:        process.env.DERIV_APP_ID,
              mode:         TRADING_MODE,
              label:        "Bot",
              durationMins: parseFloat(process.env.CONTRACT_DURATION_MINS || "120"),
            });

            await notifyTradeOpened({
              symbol,
              direction,
              stake,
              multiplier,
              limitOrder,
              contractId: typeof tradeResult === "object" ? tradeResult.contractId : "N/A",
            });

            console.log(
              `✅ Trade recorded. Open: ${rm.openTrades}/${rm.maxOpen} | ` +
              `Locked: ${[...getActiveSymbols()].sort().join(", ")}`
            );
          }

        } // end symbol loop

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