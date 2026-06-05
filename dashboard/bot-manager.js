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
import { placeTradeWithRetry, startForcedCloseTimer, cancelForcedCloseTimer, closeTrade } from "../src/trading/trader.js";
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
  "cryBTCUSD", "cryETHUSD",
];
const POLL_SECS          = 20;
const MAX_IDLE_SECS      = 20;
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

      // Cancel the 2hr timer — trade already closed by SL/TP
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
// Now uses DB as source of truth for locked symbols
// so locks persist across reconnects
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

        // Update live PnL
        await Trade.findByIdAndUpdate(trade._id, { pnl: currentPnl });

        // ── EXIT 1: TREND REVERSAL ──────────────────────
        const h4Candles = dfH4Cache.get(trade.symbol);
        if (h4Candles && h4Candles.length >= 50) {
          const { get15mTrend } = await import("../src/strategy/signals.js");
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
          await log(userId, `[${label}] ${trade.symbol} | 📈 Profit $${currentPnl.toFixed(2)} >= 50% TP — moving SL to breakeven $${breakevenSL}`, "trade");
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

function createPortfolio(userId) {
  let activeSymbols = new Set();
  let openCount     = 0;
  // Per-user timer map: symbol → { contractId, expiresAt }
  // Completely isolated — no sharing between users
  const timers = new Map();

  return {
    getActiveSymbols: () => activeSymbols,
    getOpenCount:     () => openCount,

    // Lock symbol and start 2hr countdown timer
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

    // Unlock symbol and remove its timer
    unlockSymbol(sym) {
      activeSymbols.delete(sym);
      timers.delete(sym);
      openCount = Math.max(0, openCount - 1);
    },

    // Get countdown string for a symbol e.g. " | ⏱️ Expires in 1h 47m"
    getCountdown(sym) {
      const t = timers.get(sym);
      if (!t) return "";
      const remaining = t.expiresAt - Date.now();
      if (remaining <= 0) return " | ⏱️ Expiring soon";
      const hrs  = Math.floor(remaining / 3600000);
      const mins = Math.floor((remaining % 3600000) / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      return hrs > 0
        ? ` | ⏱️ Expires in ${hrs}h ${mins}m`
        : ` | ⏱️ Expires in ${mins}m ${secs}s`;
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

        // Also check DB for open trades — prevents duplicate trades after reconnect
        const dbOpenTrades = await Trade.find({ userId, status: "open" });
        for (const t of dbOpenTrades) {
          activeNow.add(t.symbol);
        }

        // Remove timers for symbols no longer active
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
  // Cache last fetched 4H candles per symbol for trade monitor
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

        // Monitor open trades for trend reversal + trailing stop
        await monitorOpenTrades(ws, user._id, label, portfolio, dfH4Cache);

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
            const countdown = portfolio.getCountdown(symbol);
            await log(userId, `[${label}] ${symbol} | 🔒 LOCKED${countdown}`, "info");
            cycleResults.push({ symbol, status: "LOCKED", countdown });
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
          const { h4: dfH4, m30: dfM30, m15: dfM15 } = tf;
          // Cache 4H candles for trade monitor (trend reversal detection)
          if (dfH4 && dfH4.length > 0) dfH4Cache.set(symbol, dfH4);

          if (!dfM15 || dfM15.length < 2) continue;

          if (!marketIsTradeable(dfM15)) {
            await log(userId, `[${label}] ${symbol} | ⛔ FILTERED — poor volatility`, "info");
            cycleResults.push({ symbol, status: "FILTERED" });
            continue;
          }

          const signal = getLatestSignalMtf(dfM15, dfM30, dfH4);

          if (signal === 0) {
            // Show which phase failed using new strategy engine
            const strength  = getSignalStrength(dfM15, dfM30, dfH4);
            const h4trend   = get15mTrend(dfM30);
            const h4icon    = h4trend !== "neutral" ? "✅" : "❌";
            const phasePct  = strength.toFixed(0);

            await log(userId,
              `[${label}] ${symbol} | 4H: ${h4trend.toUpperCase()} ${h4icon} | ${phasePct}% | HOLD`,
              "info"
            );
            await log(userId, getTradeReason(dfM15, dfM30, dfH4), "info");

            // Extract reject reason from getTradeReason output
            const reasonText  = getTradeReason(dfM15, dfM30, dfH4);
            const rejectMatch = reasonText.match(/REJECTED at \w+: (.+)/);
            const rejectReason = rejectMatch ? rejectMatch[1].trim() : "";

            cycleResults.push({
              symbol,
              status:       "HOLD",
              h4bias:       h4trend,
              m30trend:      get15mTrend(dfM30),
              strength,
              rejectReason,
            });
            continue;
          }

          const direction  = signal === 1 ? "MULTUP" : "MULTDOWN";
          const label2     = signal === 1 ? "BUY" : "SELL";
          const baseStake  = rm.calculateStake(balance);
          const volScalar  = getVolatilityScalar(dfM15);
          const stake      = parseFloat(Math.max(baseStake * volScalar, rm.minStake).toFixed(2));
          const strength   = getSignalStrength(dfM15, dfM30, dfH4);
          const limitOrder = {
            stop_loss:   parseFloat((stake * freshUser.risk.stopLossPct).toFixed(2)),
            take_profit: parseFloat((stake * freshUser.risk.takeProfitPct).toFixed(2)),
          };
          const multiplier = 100;

          cycleResults.push({
            symbol,
            status:  label2,
            h4bias:  direction === "MULTUP" ? "bullish" : "bearish",
            m30trend: direction === "MULTUP" ? "bullish" : "bearish",
            strength,
          });

          const tradeMsg = `[${label}] ${symbol} | ${label2}! | Stake: $${stake.toFixed(2)} | SL=$${limitOrder.stop_loss} TP=$${limitOrder.take_profit} | ⏱️ 2hr failsafe`;
          await log(userId, tradeMsg, "trade");
          await log(userId, getTradeReason(dfM15, dfM30, dfH4), "trade");

          const result = await placeTradeWithRetry(ws, symbol, direction, stake, limitOrder);

          if (result) {
            lastApiCall = Date.now();

            // Lock symbol immediately in memory AND via DB trade record
            const contractId = typeof result === "object" ? result.contractId : String(result);
            const buyPrice   = typeof result === "object" ? result.buyPrice : 0;

            portfolio.lockSymbol(symbol, contractId);
            rm.tradeOpened();
            placed++;

            // Start 2hr forced close timer with user credentials
            // Uses fresh WebSocket when it fires — not affected by reconnections
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