// ═══════════════════════════════════════════════════════
//  dashboard/bot-manager.js
//
//  Daily Bias Strategy integration:
//    - Fetches 3 timeframes (D1 / H1 / M15)
//    - Step 1: Daily candle bias (bullish/bearish/none)
//    - Step 2: Trend alignment check (HH/HL or LH/LL)
//    - Step 3: 1H confluence check
//    - Step 4: 15M entry on rejection/engulfing candle
//    - All existing infrastructure (risk, trailing stop,
//      forced close, portfolio locking) unchanged
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
  notifyCycleScan, notifyTradeClosed, notifyPnlLockUpdate,
} from "../src/utils/telegram.js";

const SYMBOLS = [
  // Forex
  "frxEURUSD",
  "frxGBPUSD",
  "frxUSDJPY",
  "frxUSDCHF",
  "frxAUDUSD",
  "frxUSDCAD",
  "frxNZDUSD",
  "frxGBPJPY",
  "frxEURGBP",
  "frxEURCHF",
  "frxEURCAD",
  "frxEURAUD",

  // Metals
  "frxXAUUSD",
  "frxXAGUSD",

  // Crypto
  "cryBTCUSD",
  "cryETHUSD",

  // Boom Indices
  "BOOM50",
  "BOOM500",
  "BOOM600",
  "BOOM900",
  "BOOM1000",

  // Crash Indices
  "CRASH50",
  "CRASH500",
  "CRASH600",
  "CRASH900",
  "CRASH1000",

  // Jump Indices
  "JD10",
  "JD25",
  "JD50",
  "JD75",
  "JD100",

  // Step Indices
  "STPRNG",
  "STPRNG2",
  "STPRNG3",
  "STPRNG4",
  "STPRNG5",

  // Volatility Indices
  "R_10",
  "R_25",
  "R_50",
  "R_75",
  "R_100",

  // 1Hz Volatility Indices
  "1HZ10V",
  "1HZ15V",
  "1HZ25V",
  "1HZ50V",
  "1HZ75V",
  "1HZ90V",
  "1HZ100V",
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
async function monitorOpenTrades(ws, userId, label, portfolio, dfD1Cache, riskSettings, botToken, chatId) {
  try {
    const openTrades = await Trade.find({ userId, status: "open" });
    if (!openTrades.length) return;

    // pnlLockPct = % of TAKE PROFIT that must be reached to activate the
    // PnL lock (field name in the DB is still trailingStopPct for backward
    // compatibility with existing user documents — only the dashboard
    // label and all log/Telegram text now say "PnL Lock"). Defaults to
    // 0.5 (50%) if the user has never set this.
    const pnlLockPct = (riskSettings?.trailingStopPct === undefined || riskSettings?.trailingStopPct === null)
      ? 0.5
      : riskSettings.trailingStopPct;

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
        const direction  = trade.direction;

        await Trade.findByIdAndUpdate(trade._id, { pnl: currentPnl });

        // ── EXIT 1: DAILY BIAS REVERSAL ──────────────────
        const d1Candles = dfD1Cache.get(trade.symbol);
        if (d1Candles && d1Candles.length >= 3) {
          const currentBias = get15mTrend(d1Candles); // now reflects D1 bias, see signals.js
          const tradeBias   = direction === "MULTUP" ? "bullish" : "bearish";
          const biasFlipped = currentBias !== "neutral" && currentBias !== tradeBias;

          if (biasFlipped) {
            const reason = `Daily bias reversed to ${currentBias.toUpperCase()}`;
            await log(userId, `[${label}] ${trade.symbol} | 🔄 EXIT: ${reason} — closing ${direction}`, "trade");
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
              await notifyTradeClosed({ symbol: trade.symbol, direction, soldFor, pnl: finalPnl, stake, reason, label, botToken, chatId });
            }
            continue;
          }
        }

        // ── EXIT 1B: NO-PROFIT 20-MINUTE CUTOFF ──────────
        // If a trade has been open for >= 20 minutes and is NOT in
        // profit (currentPnl <= 0), close it immediately and lock
        // the symbol for a 2-hour cooldown (separate from the normal
        // unlock-on-close — this is a deliberate "stay away" period
        // after a stalled/losing setup, even though no trade remains
        // open on this symbol).
        const openedAtMs   = new Date(trade.openedAt).getTime();
        const minutesOpen  = (Date.now() - openedAtMs) / 60000;

        // Real-time countdown visibility every cycle while waiting,
        // not just when the cutoff actually fires.
        if (currentPnl <= 0 && minutesOpen < 20) {
          const remainingMin = (20 - minutesOpen).toFixed(1);
          await log(userId,
            `[${label}] ${trade.symbol} | ⏱️ ${minutesOpen.toFixed(1)}min open | PnL: $${currentPnl.toFixed(2)} | Auto-closes in ${remainingMin}min if still not profitable`,
            "info"
          );
        }

        if (minutesOpen >= 20 && currentPnl <= 0) {
          const reason = `Not profitable after ${minutesOpen.toFixed(0)}min`;
          await log(userId,
            `[${label}] ${trade.symbol} | ⏱️ EXIT: ${reason} ($${currentPnl.toFixed(2)}) — closing + 2hr cooldown lock`,
            "trade"
          );
          const soldFor = await closeTrade(ws, trade.contractId);
          if (soldFor !== null) {
            const finalPnl = soldFor - stake;
            await Trade.findByIdAndUpdate(trade._id, {
              status:   finalPnl >= 0 ? "won" : "lost",
              pnl:      finalPnl,
              closedAt: new Date(),
            });
            portfolio.unlockSymbol(trade.symbol);
            portfolio.lockSymbolForCooldown(trade.symbol, 2 * 60 * 60 * 1000); // 2hr cooldown
            await log(userId, `[${label}] ${trade.symbol} | Closed $${soldFor.toFixed(2)} | PnL: $${finalPnl.toFixed(2)} | 🧊 locked 2hrs`, "trade");
            await notifyTradeClosed({ symbol: trade.symbol, direction, soldFor, pnl: finalPnl, stake, reason: `${reason} — 2hr cooldown lock applied`, label, botToken, chatId });
          }
          continue;
        }

        // ── EXIT 2: PNL LOCK (user-configurable, default 50% of TP) ───
        // Client-side profit lock. Does NOT use Deriv's contract_update —
        // per Deriv support's own chat transcript, trailing isn't natively
        // supported, and Deriv's own docs define stop_loss as a LOSS-amount
        // threshold, not a price/equity level, so pushing a profit floor
        // through that field is unverified at best. Instead: track peak
        // profit, compute floor = peak * pnlLockPct once activated, and
        // close via `sell` (closeTrade — the exact same function EXIT 1
        // and EXIT 1B already use successfully) the moment current profit
        // falls to/below that floor. Floor only ever moves UP, never down.
        // The original stop_loss/take_profit set at trade-open are NOT
        // touched — they remain the hard backstop on Deriv's side.
        const takeProfit = trade.takeProfit;

        if (pnlLockPct > 0 && takeProfit > 0) {
          const activationThreshold = takeProfit * pnlLockPct;
          const priorPeak  = trade.trailingPeakPnl || 0;
          const priorFloor = trade.pnlLockFloor    || 0;
          const peak       = Math.max(priorPeak, currentPnl);

          if (peak >= activationThreshold) {
            const candidateFloor = parseFloat((peak * pnlLockPct).toFixed(4));
            const floor          = Math.max(candidateFloor, priorFloor); // never lower the floor

            // Full visibility every single cycle, per request — current
            // PnL and exactly what PnL would trigger a close, in real time.
            await log(userId,
              `[${label}] ${trade.symbol} | 🔒 PnL Lock | Profit: $${currentPnl.toFixed(4)} | Peak: $${peak.toFixed(4)} | Closes if PnL <= $${floor.toFixed(4)}`,
              "info"
            );

            if (floor > priorFloor) {
              // Floor just ratcheted up — meaningful event: persist + notify
              const wasActive = trade.trailingActive;
              await Trade.findByIdAndUpdate(trade._id, {
                trailingActive:  true,
                trailingPeakPnl: peak,
                pnlLockFloor:    floor,
              });
              await log(userId,
                `[${label}] ${trade.symbol} | 📈 PnL Lock ${wasActive ? "raised" : "ACTIVATED"} | New close-floor: $${floor.toFixed(4)} ` +
                `(locks ${(pnlLockPct * 100).toFixed(0)}% of $${peak.toFixed(4)} peak)`,
                "trade"
              );
              await notifyPnlLockUpdate({
                symbol: trade.symbol, direction, currentPnl, peak, floor, lockPct: pnlLockPct,
                label, botToken, chatId,
              });
            } else if (peak > priorPeak) {
              // Peak ticked up but not enough to raise the floor yet
              await Trade.findByIdAndUpdate(trade._id, { trailingPeakPnl: peak });
            }

            // ── Price fell back to the locked floor → close now ──
            if (currentPnl <= floor) {
              const reason = `PnL Lock floor hit ($${currentPnl.toFixed(4)} <= $${floor.toFixed(4)})`;
              await log(userId, `[${label}] ${trade.symbol} | 🔒 EXIT: ${reason} — closing`, "trade");
              const soldFor = await closeTrade(ws, trade.contractId);
              if (soldFor !== null) {
                const finalPnl = soldFor - stake;
                await Trade.findByIdAndUpdate(trade._id, {
                  status:   finalPnl >= 0 ? "won" : "lost",
                  pnl:      finalPnl,
                  closedAt: new Date(),
                });
                portfolio.unlockSymbol(trade.symbol);
                await log(userId, `[${label}] ${trade.symbol} | Closed $${soldFor.toFixed(2)} | PnL: $${finalPnl.toFixed(2)} (locked floor was $${floor.toFixed(4)})`, "trade");
                await notifyTradeClosed({ symbol: trade.symbol, direction, soldFor, pnl: finalPnl, stake, reason, label, botToken, chatId });
              }
              continue;
            }
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
  const cooldowns   = new Map(); // symbol -> expiresAt (ms epoch) — survives sync()

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

    // Locks a symbol for a fixed cooldown window WITHOUT requiring an
    // open trade — used by the 20-min-no-profit auto-close rule so the
    // symbol stays off-limits for 2hrs after that specific exit, even
    // though no trade is open anymore. Independent of timers/activeSymbols
    // so portfolio.sync() rebuilding those from Deriv/DB doesn't erase it.
    lockSymbolForCooldown(sym, durationMs = 2 * 60 * 60 * 1000) {
      cooldowns.set(sym, Date.now() + durationMs);
    },

    isOnCooldown(sym) {
      const expiresAt = cooldowns.get(sym);
      if (!expiresAt) return false;
      if (Date.now() >= expiresAt) { cooldowns.delete(sym); return false; }
      return true;
    },

    getCooldownRemaining(sym) {
      const expiresAt = cooldowns.get(sym);
      if (!expiresAt) return "";
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) return "";
      const hrs  = Math.floor(remaining / 3600000);
      const mins = Math.floor((remaining % 3600000) / 60000);
      return hrs > 0 ? ` | 🧊 cooldown ${hrs}h ${mins}m` : ` | 🧊 cooldown ${mins}m`;
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

  await log(userId, `[${label}] Bot starting — Daily Bias Strategy (D1 -> H1 -> M15)`, "info");

  const rm = new RiskManager({
    riskPct:              user.risk.riskPct,
    maxDailyLossPct:      user.risk.maxDailyLossPct,
    maxOpenTrades:        user.risk.maxOpenTrades,
    maxConsecutiveLosses: user.risk.maxConsecutiveLosses,
  });

  const portfolio     = createPortfolio(user._id);
  let lastSummaryDate = "";
  const dfD1Cache      = new Map();

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

        await monitorOpenTrades(ws, user._id, label, portfolio, dfD1Cache, freshUser.risk, botToken, chatId);
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
        await log(userId, `[${label}] ✅ ${slotsLeft} slot(s) available — scanning (Daily Bias)...`, "info");

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

          if (portfolio.isOnCooldown(symbol)) {
            const cooldownText = portfolio.getCooldownRemaining(symbol);
            await log(userId, `[${label}] ${symbol} | 🧊 COOLDOWN${cooldownText}`, "info");
            cycleResults.push({ symbol, status: "LOCKED", countdown: cooldownText });
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

          // Read from global cache — 3 timeframes (D1/H1/M15)
          lastApiCall    = Date.now();
          const tf       = await getCachedMultiTf(ws, symbol);
          const { d1: dfD1, h1: dfH1, m15: dfM15 } = tf;

          if (dfD1 && dfD1.length > 0) dfD1Cache.set(symbol, dfD1);

          if (!dfM15 || dfM15.length < 2) continue;

          // Global volatility filter
          if (!marketIsTradeable(dfM15)) {
            await log(userId, `[${label}] ${symbol} | ⛔ FILTERED — poor volatility`, "info");
            cycleResults.push({ symbol, status: "FILTERED" });
            continue;
          }

          // ── RUN DAILY BIAS STRATEGY ────────────────────
          const result = collectSignals({ d1: dfD1, h1: dfH1, m15: dfM15, symbol });
          const { signal, breakdown, reason, dailyBias } = result;

          if (signal === 0) {
            await log(userId,
              `[${label}] ${symbol} | HOLD | Bias: ${(dailyBias || "none").toUpperCase()} | ${reason}`,
              "info"
            );
            cycleResults.push({
              symbol,
              status:       "HOLD",
              dailyBias:    dailyBias || "none",
              strength:     0,
              rejectReason: reason,
              breakdown,
            });
            continue;
          }

          // ── SIGNAL FIRED ─────────────────────────────
          const direction = signal === SIG_BUY ? "MULTUP" : "MULTDOWN";
          const label2    = signal === SIG_BUY ? "BUY"    : "SELL";

          // Fixed dollar stake — user sets amount directly (min $1)
          const stake      = parseFloat(Math.max(freshUser.risk.stakeAmount || 1.00, 1.00).toFixed(2));
          const limitOrder = {
            stop_loss:   parseFloat((stake * freshUser.risk.stopLossPct).toFixed(2)),
            take_profit: parseFloat((stake * freshUser.risk.takeProfitPct).toFixed(2)),
          };
          const multiplier = 100;

          // Log full strategy breakdown
          await log(userId,
            `[${label}] ${symbol} | ${label2}! | Daily Bias: ${dailyBias.toUpperCase()} | Stake: $${stake} | SL=$${limitOrder.stop_loss} TP=$${limitOrder.take_profit}`,
            "trade"
          );
          await log(userId, getTradeReason({ d1: dfD1, h1: dfH1, m15: dfM15, symbol }), "trade");

          cycleResults.push({
            symbol,
            status:    label2,
            dailyBias,
            breakdown,
          });

          const tradeResult = await placeTradeWithRetry(ws, symbol, direction, stake, limitOrder);

          if (tradeResult) {
            lastApiCall = Date.now();

            const contractId = typeof tradeResult === "object" ? tradeResult.contractId : String(tradeResult);
            const buyPrice   = typeof tradeResult === "object" ? tradeResult.buyPrice : 0;

            portfolio.lockSymbol(symbol, contractId);
            rm.tradeOpened();
            placed++;

            // Default to 120 mins (2hrs) if the user has never set this
            // (covers existing user documents created before this field
            // existed in the schema). Explicit 0 from the dashboard toggle
            // still correctly means OFF.
            const durationMins = (freshUser.risk.contractDurationMins === undefined || freshUser.risk.contractDurationMins === null)
              ? 120
              : freshUser.risk.contractDurationMins;

            startForcedCloseTimer({
              contractId,
              symbol,
              direction,
              stake,
              token:        user.derivPAT,
              appId:        user.derivAppId,
              mode:         user.derivMode,
              label,
              durationMins, // 0 = OFF (explicit user choice), no min/max otherwise
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
              limitOrder,
              contractId, label, botToken, chatId,
              breakdown,
              dailyBias,
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