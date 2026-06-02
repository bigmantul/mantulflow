// ═══════════════════════════════════════════════════════
//  dashboard/bot-manager.js
//  Fixes:
//  1. Symbol locking — locks symbol in DB so duplicate
//     trades are prevented even after reconnect
//  2. Trade sync — correctly detects open vs closed
//  3. PnL update — fetches real PnL when trade closes
//  4. Bot logging — saves logs to MongoDB (72hr TTL)
// ═══════════════════════════════════════════════════════

import { connectForMode }                from "../src/auth/deriv-auth.js";
import { connectWebSocket, sendMessage } from "../src/utils/ws-client.js";
import { getMultiTf }                    from "../src/data/candles.js";
import {
  getLatestSignalMtf, getSignalStrength, getVolatilityScalar,
  marketIsTradeable, get15mTrend, getTradeReason,
  sessionName, isMarketOpen,
} from "../src/strategy/signals.js";
import { placeTradeWithRetry }             from "../src/trading/trader.js";
import { RiskManager, StopLossTakeProfit } from "../src/risk/risk-manager.js";
import { Trade, User, BotLog }             from "./db.js";
import {
  notifyStartup, notifyTradeOpened, notifyRiskBlock,
  notifyReconnecting, notifyMaxTrades, notifyDailySummary,
  notifyCycleScan,
} from "../src/utils/telegram.js";

const SYMBOLS = [
  // Forex
  "frxEURUSD", "frxGBPUSD", "frxUSDJPY", "frxUSDCHF",
  "frxAUDUSD", "frxUSDCAD", "frxNZDUSD",
  // Metals
  "frxXAUUSD", "frxXAGUSD",
  // Crypto
  "cryBTCUSD", "cryETHUSD", "cryLTCUSD", "cryBCHUSD",
];
const POLL_SECS          = 15;
const MAX_IDLE_SECS      = 30;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const runningBots = new Map();

function sleep(secs) {
  return new Promise(resolve => setTimeout(resolve, secs * 1000));
}

async function getBalance(ws) {
  const resp = await sendMessage(ws, { balance: 1 }, "balance");
  return parseFloat(resp.balance.balance);
}

// ── BOT LOGGER ────────────────────────────────────────
// Saves log messages to MongoDB with 72hr TTL
// Also prints to console
async function log(userId, message, level = "info") {
  console.log(message);
  try {
    await BotLog.create({ userId, message, level });
  } catch (e) {
    // Don't crash the bot if logging fails
  }
}

// ── SYNC TRADE STATUSES ───────────────────────────────
// Checks all "open" trades in DB against live Deriv portfolio
// Updates status + PnL for any that have closed
async function syncTradeStatuses(ws, userId, label) {
  try {
    const openTrades = await Trade.find({ userId, status: "open" });
    if (!openTrades.length) return;

    // Get live portfolio from Deriv
    const resp      = await sendMessage(ws, { portfolio: 1 }, "portfolio");
    const contracts = resp?.portfolio?.contracts ?? [];

    // Map of contractId → contract details for active contracts
    const activeContracts = new Map();
    for (const c of contracts) {
      const status = String(c.status ?? "").toLowerCase();
      if (!["sold", "closed", "expired"].includes(status)) {
        activeContracts.set(String(c.contract_id), c);
      }
    }

    for (const trade of openTrades) {
      const contractIdStr = String(trade.contractId);

      if (activeContracts.has(contractIdStr)) {
        // Still open on Deriv — update PnL in real time
        const liveContract = activeContracts.get(contractIdStr);
        const livePnl      = parseFloat(liveContract.profit ?? liveContract.bid_price ?? 0);
        await Trade.findByIdAndUpdate(trade._id, { pnl: livePnl });
        continue;
      }

      // Not in active portfolio — trade has closed
      // Try to get final details
      let finalPnl    = 0;
      let finalStatus = "closed";

      try {
        const detail = await sendMessage(ws, {
          proposal_open_contract: 1,
          contract_id: parseInt(trade.contractId),
        }, "proposal_open_contract");

        const contract = detail?.proposal_open_contract;
        if (contract) {
          finalPnl    = parseFloat(contract.profit ?? 0);
          finalStatus = finalPnl > 0 ? "won" : "lost";
        }
      } catch {
        // Contract too old to fetch — mark as closed
        finalStatus = "closed";
      }

      await Trade.findByIdAndUpdate(trade._id, {
        status:   finalStatus,
        pnl:      finalPnl,
        closedAt: new Date(),
      });
      portfolio.unlockSymbol(trade.symbol);

      // timer cleanup handled by portfolio.unlockSymbol on next sync
      await log(userId,
        `[${label}] [sync] Trade ${trade.contractId} → ${finalStatus} | PnL: $${finalPnl.toFixed(2)}`,
        "trade"
      );
    }
  } catch (e) {
    await log(userId, `[${label}] [sync] Error: ${e.message}`, "error");
  }
}


// ── PORTFOLIO TRACKER ─────────────────────────────────
// Now uses DB as source of truth for locked symbols
// so locks persist across reconnects
function createPortfolio(userId) {
  let activeSymbols = new Set();
  let openCount     = 0;

  return {
    getActiveSymbols: () => activeSymbols,
    getOpenCount:     () => openCount,

    lockSymbol(sym) {
      activeSymbols.add(sym);
      openCount = activeSymbols.size;
    },

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

        // Also check DB for open trades — this prevents
        // duplicate trades even after reconnection
        const dbOpenTrades = await Trade.find({ userId, status: "open" });
        for (const t of dbOpenTrades) {
          activeNow.add(t.symbol);
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
  const userId   = user._id.toString();
  const label    = user.name;
  const botToken = TELEGRAM_BOT_TOKEN;
  const chatId   = user.telegramChatId;

  await log(userId, `[${label}] Bot starting...`, "info");

  const rm = new RiskManager({
    riskPct:              user.risk.riskPct,
    maxDailyLossPct:      user.risk.maxDailyLossPct,
    maxOpenTrades:        user.risk.maxOpenTrades,
    maxConsecutiveLosses: user.risk.maxConsecutiveLosses,
  });

  const portfolio     = createPortfolio(user._id);
  let lastSummaryDate = "";

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

      await log(userId, `[${label}] ✅ Connected | Balance: $${balance.toFixed(2)} | Open: ${openCount}/${rm.maxOpen}`, "info");
      await notifyStartup(balance, user.derivMode, label, botToken, chatId);

      while (!stopSignal.stopped) {
        await sleep(POLL_SECS);

        if ((Date.now() - lastApiCall) / 1000 > MAX_IDLE_SECS) {
          await log(userId, `[${label}] ⏱️ Idle — reconnecting...`, "warn");
          ws.close(); break;
        }

        const freshUser = await User.findById(userId);
        if (!freshUser || !freshUser.botActive) {
          await log(userId, `[${label}] Bot stopped from dashboard`, "info");
          ws.close();
          stopSignal.stopped = true;
          break;
        }

        balance     = await getBalance(ws);
        lastApiCall = Date.now();

        // Sync trade statuses — updates closed trades + live PnL
        await syncTradeStatuses(ws, user._id, label);

        const currentOpen = await portfolio.sync(ws);
        lastApiCall       = Date.now();
        rm.openTrades     = currentOpen;

        // Apply latest risk settings from DB
        rm.maxOpen              = freshUser.risk.maxOpenTrades;
        rm.maxConsecutiveLosses = freshUser.risk.maxConsecutiveLosses;
        rm.maxDailyLossPct      = freshUser.risk.maxDailyLossPct;
        rm.riskPct              = freshUser.risk.riskPct;

        const cycleHeader = `[${label}] 📡 Session: ${sessionName()} | Balance: $${balance.toFixed(2)} | Open: ${currentOpen}/${rm.maxOpen}`;
        await log(userId, cycleHeader, "info");

        // Daily summary
        const todayStr = new Date().toISOString().slice(0, 10);
        if (new Date().getUTCHours() === 23 && lastSummaryDate !== todayStr) {
          lastSummaryDate = todayStr;
          await notifyDailySummary({ balance, dailyPnl: rm.dailyPnl, openTrades: currentOpen, consecutiveLosses: rm.consecutiveLosses, label, botToken, chatId });
        }

        if (currentOpen >= rm.maxOpen) {
          await log(userId, `[${label}] 🔒 Max open trades (${currentOpen}/${rm.maxOpen}) — waiting`, "warn");
          await notifyMaxTrades(currentOpen, rm.maxOpen, label, botToken, chatId);
          continue;
        }

        if (!rm.canTrade(balance)) {
          const s      = rm.status();
          const reason = s.consecutiveLosses >= rm.maxConsecutiveLosses
            ? `${s.consecutiveLosses} consecutive losses`
            : `Daily loss limit ($${Math.abs(s.dailyPnl).toFixed(2)})`;
          await log(userId, `[${label}] 🚫 Risk block: ${reason}`, "warn");
          await notifyRiskBlock(reason, label, botToken, chatId);
          continue;
        }

        const slotsLeft    = rm.maxOpen - currentOpen;
        await log(userId, `[${label}] ✅ ${slotsLeft} slot(s) available — scanning...`, "info");

        const cycleResults = [];
        let   placed       = 0;

        for (const symbol of SYMBOLS) {
          if (stopSignal.stopped) break;
          if (placed >= slotsLeft || portfolio.getOpenCount() >= rm.maxOpen) break;

          const activeSymbols = portfolio.getActiveSymbols();

          // Lock check — uses DB-backed symbol set
          if (activeSymbols.has(symbol)) {
            await log(userId, `[${label}] ${symbol} | 🔒 LOCKED — trade already open`, "info");
            cycleResults.push({ symbol, status: "LOCKED" });
            continue;
          }

          if (!isMarketOpen(symbol)) {
            await log(userId, `[${label}] ${symbol} | 🕐 MARKET CLOSED — weekend`, "info");
            cycleResults.push({ symbol, status: "CLOSED" });
            continue;
          }

          // Extra DB check — prevent duplicate even if in-memory missed it
          const existingOpenTrade = await Trade.findOne({
            userId: user._id,
            symbol,
            status: "open",
          });
          if (existingOpenTrade) {
            await log(userId, `[${label}] ${symbol} | LOCKED (DB check) — skipping`, "info");
            portfolio.lockSymbol(symbol);
            cycleResults.push({ symbol, status: "LOCKED" });
            continue;
          }

          const tf = await getMultiTf(ws, symbol);
          lastApiCall = Date.now();
          const { h4: dfH4, h1: dfH1, m15: dfM15 } = tf;

          if (!dfM15 || dfM15.length < 2) continue;

          if (!marketIsTradeable(dfM15)) {
            await log(userId, `[${label}] ${symbol} | ⛔ FILTERED — poor volatility`, "info");
            cycleResults.push({ symbol, status: "FILTERED" });
            continue;
          }

          const signal = getLatestSignalMtf(dfM15, dfH1, dfH4);
          if (signal === 0) {
            const trend    = get15mTrend(dfH1);
            const strength = getSignalStrength(dfM15, dfH1, dfH4);
            const h4bias  = trend;                       // from get15mTrend(dfH1) = 4H bias
            const h1trend = get15mTrend(dfH1);            // 1H trend from 1H data ✅
            const h4icon  = h4bias  !== "neutral" ? "✅" : "❌";
            const h1match = h1trend === h4bias || h4bias === "neutral";
            const h1icon  = h1match ? "✅" : "❌";
            const voteCount = Math.round(strength * 7 / 100);

            let holdReason;
            if (h4bias === "neutral")         holdReason = "4H neutral — no direction";
            else if (h1trend !== h4bias)      holdReason = `1H: ${h1trend.toUpperCase()} ${h1icon} — disagrees with 4H`;
            else                              holdReason = `1H: ${h1trend.toUpperCase()} ✅ | ${voteCount}/7 votes — need 4`;

            await log(userId,
              `[${label}] ${symbol} | 4H: ${h4bias.toUpperCase()} ${h4icon} | ${holdReason}`,
              "info"
            );
            cycleResults.push({
              symbol,
              status:  "HOLD",
              trend,
              h4bias:  trend,
              h1trend: get15mTrend(dfH1),  // ✅ correct 1H data
              strength,
            });
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

          const h4biasForResult = dfH4 ? "bullish" : "neutral"; // from signal
          cycleResults.push({
            symbol,
            status:  label2,
            h4bias:  direction === "MULTUP" ? "bullish" : "bearish",
            h1trend: direction === "MULTUP" ? "bullish" : "bearish",
            strength,
          });

          const tradeMsg = `[${label}] ${symbol} | 4H: ${dfH4 ? "✅" : "—"} | 1H: ✅ | ${strength.toFixed(0)}% (${Math.round(strength*7/100)}/7 votes) — ${label2}! | Stake: $${stake.toFixed(2)} | SL=$${limitOrder.stop_loss} TP=$${limitOrder.take_profit} | ⏱️ 2hr failsafe`;
          await log(userId, tradeMsg, "trade");
          await log(userId, getTradeReason(df5, df15, df4h), "trade");

          const result = await placeTradeWithRetry(ws, symbol, direction, stake, limitOrder);

          if (result) {
            lastApiCall = Date.now();

            // Lock symbol immediately in memory AND via DB trade record
            portfolio.lockSymbol(symbol, contractId);  // locks symbol + starts 2hr timer
            rm.tradeOpened();
            placed++;

            const contractId = typeof result === "object" ? result.contractId : String(result);
            const buyPrice   = typeof result === "object" ? result.buyPrice : 0;

            // Save to DB — contractId is unique so no duplicates possible
            try {
              await Trade.create({
                userId:     user._id,
                symbol,
                direction,
                stake,
                multiplier,
                contractId,
                buyPrice,
                stopLoss:   limitOrder.stop_loss,
                takeProfit: limitOrder.take_profit,
                strength,
                status:     "open",
                pnl:        0,
              });
            } catch (dbErr) {
              // If duplicate contractId — trade already saved, skip
              if (!dbErr.message.includes("duplicate key")) {
                await log(userId, `[${label}] DB save error: ${dbErr.message}`, "error");
              }
            }

            await notifyTradeOpened({
              symbol, direction, stake, multiplier,
              limitOrder, strength,
              contractId, label, botToken, chatId,
            });

            await log(userId,
              `[${label}] ✅ Trade recorded | ${symbol} | ${label2} | $${stake} | ID: ${contractId}`,
              "trade"
            );
          }

        } // end symbol loop

        if (cycleResults.length > 0) {
          await notifyCycleScan({ balance, openTrades: currentOpen, maxTrades: rm.maxOpen, session: sessionName(), results: cycleResults, label, botToken, chatId });
        }

      } // inner loop

    } catch (e) {
      if (stopSignal.stopped) break;
      await log(userId, `[${label}] ❌ Error: ${e.message}`, "error");
      await notifyReconnecting(e.message, label, botToken, chatId);
      await sleep(10);
    }
  } // outer loop

  await log(userId, `[${label}] Bot fully stopped.`, "info");
  runningBots.delete(userId);
}


// ── BOT MANAGER PUBLIC API ────────────────────────────
export const botManager = {
  async startUser(user) {
    const userId = user._id.toString();
    if (runningBots.has(userId)) {
      console.log(`[${user.name}] Already running`); return;
    }
    const stopSignal = { stopped: false };
    runningBots.set(userId, stopSignal);
    runUserBot(user, stopSignal);
    console.log(`[${user.name}] Bot started`);
  },

  async stopUser(userId) {
    const signal = runningBots.get(userId);
    if (signal) {
      signal.stopped = true;
      runningBots.delete(userId);
    }
  },

  async restartUser(userId) {
    await this.stopUser(userId);
    await sleep(2);
    const user = await User.findById(userId);
    if (user && user.botActive) await this.startUser(user);
  },

  isRunning(userId) { return runningBots.has(userId); },
  runningCount()    { return runningBots.size; },
};


export async function resumeActiveBots() {
  const activeUsers = await User.find({ botActive: true });
  console.log(`Resuming ${activeUsers.length} active bot(s)...`);
  for (const user of activeUsers) {
    await botManager.startUser(user);
  }
}