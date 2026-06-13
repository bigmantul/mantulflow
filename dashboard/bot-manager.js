// ═══════════════════════════════════════════════════════
//  dashboard/bot-manager.js
//
//  Multi-strategy signal engine integration:
//    - Fetches 4 timeframes (4H / 1H / 30M / 15M)
//    - Runs 5 independent strategies via collectSignals()
//    - Conflict engine resolves BUY/SELL/HOLD per symbol
//    - All existing infrastructure unchanged
// ═══════════════════════════════════════════════════════

import { connectForMode }                from "../src/auth/deriv-auth.js";
import { connectWebSocket, sendMessage } from "../src/utils/ws-client.js";
import { getCachedMultiTf, startGlobalScanner, getCacheStats } from "../src/data/candle-cache.js";
import {
  collectSignals,
  getTradeReason,
  getVolatilityScalar,
  marketIsTradeable,
  get15mTrend,
  sessionName,
  isMarketOpen,
  SIG_BUY,
  SIG_SELL,
} from "../src/strategy/signals.js";
import { placeTradeWithRetry, startForcedCloseTimer, cancelForcedCloseTimer, closeTrade } from "../src/trading/trader.js";
import { RiskManager, StopLossTakeProfit } from "../src/risk/risk-manager.js";
import { Trade, User, BotLog }             from "./db.js";

let _broadcast = null;
async function getBroadcast() {
  if (!_broadcast) {
    const mod = await import("./server.js");
    _broadcast = mod.broadcastToUser;
  }
  return _broadcast;
}

import {
  notifyStartup, notifyTradeOpened, notifyRiskBlock,
  notifyReconnecting, notifyMaxTrades, notifyDailySummary,
  notifyCycleScan,
} from "../src/utils/telegram.js";

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

const POLL_SECS          = 30;
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
async function log(userId, message, level = "info") {
  console.log(message);
  try {
    const entry = await BotLog.create({ userId, message, level });
    try {
      const broadcast = await getBroadcast();
      broadcast(String(userId), {
        type:      "log",
        level,
        message,
        createdAt: entry.createdAt,
        id:        entry._id,
      });
    } catch {}
  } catch {}
}

// ── SYNC TRADE STATUSES ───────────────────────────────
async function syncTradeStatuses(ws, userId, label) {
  try {
    const openTrades = await Trade.find({ userId, status: "open" });
    if (!openTrades.length) return;

    const resp      = await sendMessage(ws, { portfolio: 1 }, "portfolio");
    const contracts = resp?.portfolio?.contracts ?? [];

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
        const liveContract = activeContracts.get(contractIdStr);
        const livePnl      = parseFloat(liveContract.profit ?? liveContract.bid_price ?? 0);
        await Trade.findByIdAndUpdate(trade._id, { pnl: livePnl });
        continue;
      }

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
        finalStatus = "closed";
      }

      await Trade.findByIdAndUpdate(trade._id, {
        status:   finalStatus,
        pnl:      finalPnl,
        closedAt: new Date(),
      });

      cancelForcedCloseTimer(String(trade.contractId));
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
async function monitorOpenTrades(ws, userId, label, portfolio, dfH4Cache) {
  try {
    const openTrades = await Trade.find({ userId, status: "open" });
    if (!openTrades.length) return;

    for (const trade of openTrades) {
      try {
        const detail   = await sendMessage(ws, {
          proposal_open_contract: 1,
          contract_id: parseInt(trade.contractId),
        }, "proposal_open_contract");

        const contract = detail?.proposal_open_contract;
        if (!contract || contract.status !== "open") continue;

        const currentPnl = parseFloat(contract.profit ?? 0);
        const stake      = trade.stake;
        const takeProfit = trade.takeProfit;
        const direction  = trade.direction;

        await Trade.findByIdAndUpdate(trade._id, { pnl: currentPnl });

        // ── EXIT 1: TREND REVERSAL ──────────────────────
        const h4Candles = dfH4Cache.get(trade.symbol);
        if (h4Candles && h4Candles.length >= 50) {
          const currentBias = get15mTrend(h4Candles);
          const tradeBias   = direction === "MULTUP" ? "bullish" : "bearish";
          const biasFlipped = currentBias !== "neutral" && currentBias !== tradeBias;

          if (biasFlipped) {
            await log(userId, `[${label}] ${trade.symbol} | 🔄 EXIT: 4H reversed to ${currentBias.toUpperCase()} — closing ${direction}`, "trade");
            const soldFor = await closeTrade(ws, trade.contractId);
            if (soldFor !== null) {
              const finalPnl = soldFor - stake;
              await Trade.findByIdAndUpdate(trade._id, {
                status:   finalPnl >= 0 ? "won" : "lost",
                pnl:      finalPnl,
                closedAt: new Date(),
              });
              portfolio.unlockSymbol(trade.symbol);
              await log(userId, `[${label}] ${trade.symbol} | Closed $${soldFor.toFixed(2)} | PnL: $${finalPnl.toFixed(2)}`, "trade");
            }
            continue;
          }
        }

        // ── EXIT 2: TRAILING STOP ────────────────────────
        if (takeProfit && currentPnl >= takeProfit * 0.5) {
          const breakevenSL = stake;
          await log(userId, `[${label}] ${trade.symbol} | 📈 Profit $${currentPnl.toFixed(2)} >= 50% TP — moving SL to breakeven`, "trade");
          try {
            await sendMessage(ws, {
              contract_update: 1,
              contract_id:     parseInt(trade.contractId),
              limit_order:     { stop_loss: breakevenSL },
            }, "contract_update");
            await Trade.findByIdAndUpdate(trade._id, { stopLoss: breakevenSL });
          } catch (updateErr) {
            console.log(`[${label}] Could not update SL: ${updateErr.message}`);
          }
        }

      } catch (tradeErr) {
        if (!tradeErr.message.includes("closed") && !tradeErr.message.includes("expired")) {
          console.error(`[${label}] Monitor error for ${trade.contractId}:`, tradeErr.message);
        }
      }
    }
  } catch (e) {
    console.error(`[${label}] Trade monitor error:`, e.message);
  }
}

// ── PER-USER PORTFOLIO ────────────────────────────────
function createPortfolio(userId) {
  let activeSymbols = new Set();
  let openCount     = 0;
  const timers      = new Map();

  return {
    getActiveSymbols: () => activeSymbols,
    getOpenCount:     () => openCount,

    lockSymbol(sym, contractId) {
      activeSymbols.add(sym);
      openCount = activeSymbols.size;
      if (contractId) {
        timers.set(sym, {
          contractId: String(contractId),
          expiresAt:  Date.now() + 2 * 60 * 60 * 1000,
        });
      }
    },

    unlockSymbol(sym) {
      activeSymbols.delete(sym);
      timers.delete(sym);
      openCount = Math.max(0, openCount - 1);
    },

    getCountdown(sym) {
      const t = timers.get(sym);
      if (!t) return "";
      const remaining = t.expiresAt - Date.now();
      if (remaining <= 0) return " | ⏱️ Expiring soon";
      const hrs  = Math.floor(remaining / 3600000);
      const mins = Math.floor((remaining % 3600000) / 60000);
      return hrs > 0 ? ` | ⏱️ ${hrs}h ${mins}m` : ` | ⏱️ ${mins}m`;
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

        // DB check — prevents duplicate trades after reconnect
        const dbOpenTrades = await Trade.find({ userId, status: "open" });
        for (const t of dbOpenTrades) activeNow.add(t.symbol);

        for (const sym of timers.keys()) {
          if (!activeNow.has(sym)) timers.delete(sym);
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
let _userStartOffset = 0;

async function runUserBot(user, stopSignal) {
  const userId   = user._id.toString();
  const label    = user.name;
  const myOffset = (_userStartOffset++ % 4) * 7000;
  if (myOffset > 0) await new Promise(r => setTimeout(r, myOffset));
  const botToken = TELEGRAM_BOT_TOKEN;
  const chatId   = user.telegramChatId;

  await log(userId, `[${label}] Bot starting — Multi-Strategy Engine (5 strategies)`, "info");

  const rm = new RiskManager({
    riskPct:              user.risk.riskPct,
    maxDailyLossPct:      user.risk.maxDailyLossPct,
    maxOpenTrades:        user.risk.maxOpenTrades,
    maxConsecutiveLosses: user.risk.maxConsecutiveLosses,
  });

  const portfolio     = createPortfolio(user._id);
  let lastSummaryDate = "";
  const dfH4Cache     = new Map();

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

        if (ws.readyState !== 1) {
          await log(userId, `[${label}] ⏱️ WebSocket dropped — reconnecting...`, "warn");
          ws.close(); break;
        }

        const freshUser = await User.findById(userId);
        if (!freshUser || !freshUser.botActive) {
          await log(userId, `[${label}] Bot stopped from dashboard`, "info");
          ws.close();
          stopSignal.stopped = true;
          break;
        }

        lastApiCall = Date.now();
        balance     = await getBalance(ws);
        lastApiCall = Date.now();

        await syncTradeStatuses(ws, user._id, label);
        lastApiCall = Date.now();

        await monitorOpenTrades(ws, user._id, label, portfolio, dfH4Cache);
        lastApiCall = Date.now();

        const currentOpen = await portfolio.sync(ws);
        lastApiCall = Date.now();
        rm.openTrades     = currentOpen;

        // Apply latest risk settings from DB
        rm.maxOpen              = freshUser.risk.maxOpenTrades;
        rm.maxConsecutiveLosses = freshUser.risk.maxConsecutiveLosses;
        rm.maxDailyLossPct      = freshUser.risk.maxDailyLossPct;
        rm.riskPct              = freshUser.risk.riskPct;

        await log(userId,
          `[${label}] 📡 ${sessionName()} | Balance: $${balance.toFixed(2)} | Open: ${currentOpen}/${rm.maxOpen}`,
          "info"
        );

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
        await log(userId, `[${label}] ✅ ${slotsLeft} slot(s) available — scanning 5 strategies...`, "info");

        const cycleResults = [];
        let   placed       = 0;

        // ── SYMBOL LOOP ───────────────────────────────
        for (const symbol of SYMBOLS) {
          if (stopSignal.stopped) break;
          if (placed >= slotsLeft || portfolio.getOpenCount() >= rm.maxOpen) break;

          const activeSymbols = portfolio.getActiveSymbols();

          if (activeSymbols.has(symbol)) {
            const countdown = portfolio.getCountdown(symbol);
            await log(userId, `[${label}] ${symbol} | 🔒 LOCKED${countdown}`, "info");
            cycleResults.push({ symbol, status: "LOCKED", countdown });
            continue;
          }

          if (!isMarketOpen(symbol)) {
            await log(userId, `[${label}] ${symbol} | 🕐 MARKET CLOSED`, "info");
            cycleResults.push({ symbol, status: "CLOSED" });
            continue;
          }

          // DB duplicate check
          const existingOpenTrade = await Trade.findOne({
            userId: user._id,
            symbol,
            status: "open",
          });
          if (existingOpenTrade) {
            portfolio.lockSymbol(symbol);
            cycleResults.push({ symbol, status: "LOCKED" });
            continue;
          }

          // Read from global cache — 4 timeframes
          lastApiCall    = Date.now();
          const tf       = await getCachedMultiTf(ws, symbol);
          const { h4: dfH4, h1: dfH1, m30: dfM30, m15: dfM15 } = tf;

          if (dfH4 && dfH4.length > 0) dfH4Cache.set(symbol, dfH4);

          if (!dfM15 || dfM15.length < 2) continue;

          // Global volatility filter
          if (!marketIsTradeable(dfM15)) {
            await log(userId, `[${label}] ${symbol} | ⛔ FILTERED — poor volatility`, "info");
            cycleResults.push({ symbol, status: "FILTERED" });
            continue;
          }

          // ── RUN ALL 5 STRATEGIES ──────────────────────
          const result = collectSignals({ h4: dfH4, h1: dfH1, m30: dfM30, m15: dfM15 });
          const { signal, buyCount, sellCount, breakdown, reason } = result;

          if (signal === 0) {
            // Build strategy breakdown for logs
            const breakdownStr = breakdown.map(s => `${s.name}:${s.signal}`).join(" | ");
            await log(userId,
              `[${label}] ${symbol} | HOLD | B:${buyCount} S:${sellCount} | ${reason}`,
              "info"
            );
            cycleResults.push({
              symbol,
              status:       "HOLD",
              h4bias:       get15mTrend(dfM30),
              strength:     0,
              rejectReason: reason,
              breakdown,
            });
            continue;
          }

          // ── SIGNAL FIRED ─────────────────────────────
          const direction = signal === SIG_BUY ? "MULTUP" : "MULTDOWN";
          const label2    = signal === SIG_BUY ? "BUY"    : "SELL";
          const votes     = signal === SIG_BUY ? buyCount : sellCount;
          const strength  = Math.round((votes / 5) * 100);

          // Fixed dollar stake — user sets amount directly (min $1)
          const stake      = parseFloat(Math.max(freshUser.risk.stakeAmount || 1.00, 1.00).toFixed(2));
          const limitOrder = {
            stop_loss:   parseFloat((stake * freshUser.risk.stopLossPct).toFixed(2)),
            take_profit: parseFloat((stake * freshUser.risk.takeProfitPct).toFixed(2)),
          };
          const multiplier = 100;

          // Log full strategy breakdown
          await log(userId,
            `[${label}] ${symbol} | ${label2}! | Votes: ${votes}/5 (${strength}%) | Stake: $${stake} | SL=$${limitOrder.stop_loss} TP=$${limitOrder.take_profit}`,
            "trade"
          );
          await log(userId, getTradeReason({ h4: dfH4, h1: dfH1, m30: dfM30, m15: dfM15 }), "trade");

          cycleResults.push({
            symbol,
            status:    label2,
            strength,
            breakdown,
            buyCount,
            sellCount,
          });

          const tradeResult = await placeTradeWithRetry(ws, symbol, direction, stake, limitOrder);

          if (tradeResult) {
            lastApiCall = Date.now();

            const contractId = typeof tradeResult === "object" ? tradeResult.contractId : String(tradeResult);
            const buyPrice   = typeof tradeResult === "object" ? tradeResult.buyPrice : 0;

            portfolio.lockSymbol(symbol, contractId);
            rm.tradeOpened();
            placed++;

            startForcedCloseTimer({
              contractId,
              symbol,
              direction,
              stake,
              token:  user.derivPAT,
              appId:  user.derivAppId,
              mode:   user.derivMode,
              label,
            });

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
              if (!dbErr.message.includes("duplicate key")) {
                await log(userId, `[${label}] DB save error: ${dbErr.message}`, "error");
              }
            }

            await notifyTradeOpened({
              symbol, direction, stake, multiplier,
              limitOrder, strength,
              contractId, label, botToken, chatId,
              breakdown,
              buyCount,
              sellCount,
            });

            await log(userId,
              `[${label}] ✅ Trade saved | ${symbol} | ${label2} | $${stake} | ID: ${contractId}`,
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
    const stats = getCacheStats();
    if (stats.total === 0) {
      startGlobalScanner(SYMBOLS, user.derivPAT, user.derivAppId, user.derivMode || "demo")
        .catch(e => console.error("[scanner] Failed to start:", e.message));
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

  if (activeUsers.length > 0) {
    const u = activeUsers[0];
    startGlobalScanner(SYMBOLS, u.derivPAT, u.derivAppId, u.derivMode || "demo")
      .catch(e => console.error("[scanner] Failed to start:", e.message));
  } else {
    const token = process.env.DERIV_PAT_TOKEN;
    const appId = process.env.DERIV_APP_ID;
    if (token && appId) {
      startGlobalScanner(SYMBOLS, token, appId, "demo")
        .catch(e => console.error("[scanner] Failed to start:", e.message));
    }
  }

  for (const user of activeUsers) {
    await botManager.startUser(user);
  }
}