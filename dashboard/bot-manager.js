// ═══════════════════════════════════════════════════════
//  dashboard/bot-manager.js
//
//  Manages running bot instances per user.
//  Each user who starts their bot gets their own
//  independent bot loop running in the background.
// ═══════════════════════════════════════════════════════

import { connectForMode }                from "../src/auth/deriv-auth.js";
import { connectWebSocket, sendMessage } from "../src/utils/ws-client.js";
import { getMultiTf }                    from "../src/data/candles.js";
import {
  getLatestSignalMtf, getSignalStrength, getVolatilityScalar,
  marketIsTradeable, get15mTrend, getTradeReason,
  sessionName, isMarketOpen,
} from "../src/strategy/signals.js";
import { placeTradeWithRetry }           from "../src/trading/trader.js";
import { RiskManager, StopLossTakeProfit } from "../src/risk/risk-manager.js";
import { Trade, User }                   from "./db.js";
import {
  notifyStartup, notifyTradeOpened, notifyRiskBlock,
  notifyReconnecting, notifyMaxTrades, notifyDailySummary,
  notifyCycleScan,
} from "../src/utils/telegram.js";

const SYMBOLS       = ["R_75","R_100","frxXAUUSD","frxXAGUSD","cryBTCUSD","cryETHUSD"];
const POLL_SECS     = 15;
const MAX_IDLE_SECS = 45;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Map of userId → { stop: Function }
const runningBots = new Map();

function sleep(secs) {
  return new Promise(resolve => setTimeout(resolve, secs * 1000));
}

async function getBalance(ws) {
  const resp = await sendMessage(ws, { balance: 1 }, "balance");
  return parseFloat(resp.balance.balance);
}

function createPortfolio() {
  let activeSymbols = new Set();
  let openCount     = 0;
  return {
    getActiveSymbols: () => activeSymbols,
    getOpenCount:     () => openCount,
    lockSymbol(sym)   { activeSymbols.add(sym);    openCount = activeSymbols.size; },
    async sync(ws) {
      try {
        const resp      = await sendMessage(ws, { portfolio: 1 }, "portfolio");
        const contracts = resp?.portfolio?.contracts ?? [];
        const activeNow = new Set();
        let total = 0;
        for (const c of contracts) {
          const status = String(c.status ?? "").toLowerCase();
          if (["sold","closed","expired"].includes(status)) continue;
          total++;
          for (const field of ["underlying","symbol","shortcode","underlying_symbol"]) {
            const val = String(c[field] ?? "");
            for (const sym of SYMBOLS) {
              if (val.includes(sym)) { activeNow.add(sym); break; }
            }
          }
        }
        activeSymbols = activeNow;
        openCount     = total;
        return total;
      } catch (e) {
        console.error("Portfolio sync error:", e.message);
        return openCount;
      }
    },
  };
}

// ── RUN ONE USER'S BOT ────────────────────────────────
async function runUserBot(user, stopSignal) {
  const userId    = user._id.toString();
  const label     = user.name;
  const botToken  = TELEGRAM_BOT_TOKEN;
  const chatId    = user.telegramChatId;

  console.log(`[${label}] Bot starting...`);

  // Build risk manager from user's saved settings
  const rm = new RiskManager({
    riskPct:              user.risk.riskPct,
    maxDailyLossPct:      user.risk.maxDailyLossPct,
    maxOpenTrades:        user.risk.maxOpenTrades,
    maxConsecutiveLosses: user.risk.maxConsecutiveLosses,
  });

  const sltp = new StopLossTakeProfit({
    slPct: user.risk.stopLossPct,
    tpPct: user.risk.takeProfitPct,
  });

  const portfolio      = createPortfolio();
  let lastSummaryDate  = "";

  while (!stopSignal.stopped) {
    let lastApiCall = Date.now();
    try {
      const wsUrl = await connectForMode(user.derivMode, user.derivPAT, user.derivAppId);
      const ws    = await connectWebSocket(wsUrl);
      lastApiCall = Date.now();

      const openCount = await portfolio.sync(ws);
      lastApiCall     = Date.now();
      rm.openTrades   = openCount;

      let balance = await getBalance(ws);
      lastApiCall = Date.now();
      if (rm.startingBalance === null) rm.setStartingBalance(balance);

      console.log(`[${label}] Connected | Balance: $${balance.toFixed(2)}`);
      await notifyStartup(balance, user.derivMode, label, botToken, chatId);

      while (!stopSignal.stopped) {
        await sleep(POLL_SECS);

        if ((Date.now() - lastApiCall) / 1000 > MAX_IDLE_SECS) {
          ws.close(); break;
        }

        // Re-fetch latest user settings from DB (in case they changed risk)
        const freshUser = await User.findById(userId);
        if (!freshUser || !freshUser.botActive) {
          console.log(`[${label}] Bot stopped from dashboard`);
          ws.close();
          stopSignal.stopped = true;
          break;
        }

        balance     = await getBalance(ws);
        lastApiCall = Date.now();

        const currentOpen = await portfolio.sync(ws);
        lastApiCall       = Date.now();
        rm.openTrades     = currentOpen;

        // Update risk settings live if user changed them
        rm.maxOpen              = freshUser.risk.maxOpenTrades;
        rm.maxConsecutiveLosses = freshUser.risk.maxConsecutiveLosses;
        rm.maxDailyLossPct      = freshUser.risk.maxDailyLossPct;
        rm.riskPct              = freshUser.risk.riskPct;

        console.log(`\n[${label}] 📡 Session: ${sessionName()} | Balance: $${balance.toFixed(2)} | Open: ${currentOpen}/${rm.maxOpen}`);

        // Daily summary
        const todayStr = new Date().toISOString().slice(0, 10);
        if (new Date().getUTCHours() === 23 && lastSummaryDate !== todayStr) {
          lastSummaryDate = todayStr;
          await notifyDailySummary({ balance, dailyPnl: rm.dailyPnl, openTrades: currentOpen, consecutiveLosses: rm.consecutiveLosses, label, botToken, chatId });
        }

        if (currentOpen >= rm.maxOpen) {
          await notifyMaxTrades(currentOpen, rm.maxOpen, label, botToken, chatId);
          continue;
        }

        if (!rm.canTrade(balance)) {
          const s      = rm.status();
          const reason = s.consecutiveLosses >= rm.maxConsecutiveLosses
            ? `${s.consecutiveLosses} consecutive losses`
            : `Daily loss limit ($${Math.abs(s.dailyPnl).toFixed(2)})`;
          await notifyRiskBlock(reason, label, botToken, chatId);
          continue;
        }

        const slotsLeft    = rm.maxOpen - currentOpen;
        console.log(`[${label}] ✅ ${slotsLeft} slot(s) available — scanning...`);
        const cycleResults = [];
        let   placed       = 0;

        for (const symbol of SYMBOLS) {
          if (stopSignal.stopped) break;
          if (placed >= slotsLeft || portfolio.getOpenCount() >= rm.maxOpen) break;

          if (portfolio.getActiveSymbols().has(symbol)) {
            cycleResults.push({ symbol, status: "LOCKED" });
            console.log(`[${label}] ${symbol} | LOCKED (trade open) — skipping`);
            continue;
          }
          if (!isMarketOpen(symbol)) {
            cycleResults.push({ symbol, status: "CLOSED" });
            console.log(`[${label}] ${symbol} | MARKET CLOSED — skipping`);
            continue;
          }

          const tf = await getMultiTf(ws, symbol);
          lastApiCall = Date.now();
          const { m5: df5, m15: df15, h4: df4h } = tf;

          if (!df5 || df5.length < 2) continue;
          if (!marketIsTradeable(df5)) {
            cycleResults.push({ symbol, status: "FILTERED" });
            console.log(`[${label}] ${symbol} | FILTERED (poor market conditions)`);
            continue;
          }

          const signal = getLatestSignalMtf(df5, df15, df4h);
          if (signal === 0) {
            const trend    = get15mTrend(df15);
            const strength = getSignalStrength(df5, df15, df4h);
            console.log(`[${label}] ${symbol} | HOLD | HTF: ${trend} | Strength: ${strength.toFixed(0)}%`);
            cycleResults.push({ symbol, status: "HOLD", trend, strength });
            continue;
          }

          const direction  = signal === 1 ? "MULTUP" : "MULTDOWN";
          const label2     = signal === 1 ? "BUY" : "SELL";
          const baseStake  = rm.calculateStake(balance);
          const volScalar  = getVolatilityScalar(df5);
          const stake      = parseFloat(Math.max(baseStake * volScalar, rm.minStake).toFixed(2));
          const strength   = getSignalStrength(df5, df15, df4h);
          const limitOrder = {
            stop_loss:   parseFloat((stake * freshUser.risk.stopLossPct).toFixed(2)),
            take_profit: parseFloat((stake * freshUser.risk.takeProfitPct).toFixed(2)),
          };
          const multiplier = 100;

          cycleResults.push({ symbol, status: label2, strength });
          console.log(
            `\n[${label}] ${symbol} | ${label2} | Strength: ${strength.toFixed(0)}% | ` +
            `Stake: $${stake.toFixed(2)} | ` +
            `Limit: SL=$${limitOrder.stop_loss} TP=$${limitOrder.take_profit}`
          );
          console.log(getTradeReason(df5, df15, df4h));

          const result = await placeTradeWithRetry(ws, symbol, direction, stake, limitOrder);

          if (result) {
            lastApiCall = Date.now();
            portfolio.lockSymbol(symbol);
            rm.tradeOpened();
            placed++;

            // Save trade to MongoDB
            const contractId = typeof result === "object" ? result.contractId : String(result);
            await Trade.create({
              userId:     user._id,
              symbol,
              direction,
              stake,
              multiplier,
              contractId,
              buyPrice:   typeof result === "object" ? result.buyPrice : 0,
              stopLoss:   limitOrder.stop_loss,
              takeProfit: limitOrder.take_profit,
              strength,
              status:     "open",
            });

            await notifyTradeOpened({
              symbol, direction, stake, multiplier, limitOrder, strength,
              contractId, label, botToken, chatId,
            });

            console.log(
              `[${label}] ✅ Trade recorded. Open: ${rm.openTrades}/${rm.maxOpen} | ` +
              `Slots left: ${rm.maxOpen - rm.openTrades} | ` +
              `Locked: ${[...portfolio.getActiveSymbols()].sort().join(", ")}`
            );
          }
        }

        if (cycleResults.length > 0) {
          await notifyCycleScan({ balance, openTrades: currentOpen, maxTrades: rm.maxOpen, session: sessionName(), results: cycleResults, label, botToken, chatId });
        }

      } // inner loop

    } catch (e) {
      if (stopSignal.stopped) break;
      console.error(`[${label}] Error:`, e.message);
      await notifyReconnecting(e.message, label, botToken, chatId);
      await sleep(10);
    }
  } // outer loop

  console.log(`[${label}] Bot fully stopped.`);
  runningBots.delete(userId);
}


// ── BOT MANAGER PUBLIC API ────────────────────────────
export const botManager = {
  async startUser(user) {
    const userId = user._id.toString();
    if (runningBots.has(userId)) {
      console.log(`[${user.name}] Already running`);
      return;
    }
    const stopSignal = { stopped: false };
    runningBots.set(userId, stopSignal);
    runUserBot(user, stopSignal); // fire and forget
    console.log(`[${user.name}] Bot started`);
  },

  async stopUser(userId) {
    const signal = runningBots.get(userId);
    if (signal) {
      signal.stopped = true;
      runningBots.delete(userId);
      console.log(`[${userId}] Bot stop signal sent`);
    }
  },

  async restartUser(userId) {
    await this.stopUser(userId);
    await sleep(2);
    const user = await User.findById(userId);
    if (user && user.botActive) await this.startUser(user);
  },

  isRunning(userId) {
    return runningBots.has(userId);
  },

  runningCount() {
    return runningBots.size;
  },
};


// ── AUTO-START BOTS ON SERVER BOOT ────────────────────
// Resume all users who had their bot active before restart
export async function resumeActiveBots() {
  const activeUsers = await User.find({ botActive: true });
  console.log(`Resuming ${activeUsers.length} active bot(s)...`);
  for (const user of activeUsers) {
    await botManager.startUser(user);
  }
}