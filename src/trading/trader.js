// ═══════════════════════════════════════════════════════
//  src/trading/trader.js
//
//  Multiplier trades (MULTUP/MULTDOWN) with:
//    - SL/TP as primary exit
//    - 2hr forced close as failsafe for EVERY trade
//
//  REDEPLOY FIX:
//    restoreTimersFromDB() is called on bot startup.
//    It reads all open trades from MongoDB, calculates
//    remaining time from openedAt, and restarts each
//    timer with the CORRECT remaining ms — not full 2hrs.
//
//    If a trade has already been open > 2hrs when the
//    bot restarts, it fires the close immediately.
// ═══════════════════════════════════════════════════════

import { sendMessage, connectWebSocket } from "../utils/ws-client.js";
import { connectForMode }                from "../auth/deriv-auth.js";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

// Timer registry: contractId → timeoutHandle
const openTimers = new Map();

// Fallback multipliers per symbol
const FALLBACK_MULTIPLIERS = {
  frxEURUSD: 100, frxGBPUSD: 100, frxUSDJPY: 100,
  frxUSDCHF: 100, frxAUDUSD: 100, frxUSDCAD: 100,
  frxNZDUSD: 100, frxGBPJPY: 80,
  frxEURGBP: 80, frxEURCHF: 80, frxEURCAD: 80, frxEURAUD: 80,
  frxXAUUSD: 60, frxXAGUSD: 60,
  cryBTCUSD: 40, cryETHUSD: 40,
  BOOM500: 30,   CRASH500: 30,
  JD75: 25,      JD100: 25,
  R_75: 25,      R_100: 20,
};

const multiplierCache = new Map();

function cacheKey(symbol, direction) {
  return `${symbol}|${direction}`;
}

function pickMultiplier(symbol, direction) {
  const key    = cacheKey(symbol, direction);
  const cached = multiplierCache.get(key);
  if (cached) return { value: cached[0], source: "cached" };
  return { value: FALLBACK_MULTIPLIERS[symbol] ?? 50, source: "fallback" };
}

function parseMultipliersFromError(errorText) {
  const match = errorText.match(/(?:Accepts|Allowed)[:\s\[]*[\d,\s\[\]\.]+/i);
  if (!match) return [];
  return [...match[0].matchAll(/\d+/g)]
    .map(m => parseInt(m[0]))
    .sort((a, b) => a - b);
}


// ═══════════════════════════════════════════════════════
//  CORE FORCED CLOSE — shared by timer and restore
// ═══════════════════════════════════════════════════════

async function forceCloseContract({ contractId, symbol, direction, stake, token, appId, mode, label }) {
  const contractIdStr = String(contractId);
  let ws = null;
  try {
    const wsUrl = await connectForMode(mode, token, appId);
    ws          = await connectWebSocket(wsUrl);

    const response = await sendMessage(ws, {
      sell:  parseInt(contractIdStr),
      price: 0,
    }, "sell");

    const soldFor  = parseFloat(response.sell.sold_for);
    const finalPnl = soldFor - stake;
    const result   = finalPnl >= 0 ? "✅ WON" : "❌ LOST";
    console.log(`   [${label}] ${result} | ${symbol} | Sold: $${soldFor.toFixed(2)} | PnL: $${finalPnl.toFixed(2)}`);

  } catch (e) {
    if (e.message.includes("sold") || e.message.includes("closed") || e.message.includes("expired")) {
      console.log(`   [${label}] Contract ${contractIdStr} already closed by SL/TP before forced close.`);
    } else {
      console.error(`   [${label}] Force close error: ${e.message}`);
    }
  } finally {
    if (ws) try { ws.close(); } catch {}
    openTimers.delete(contractIdStr);
  }
}


// ═══════════════════════════════════════════════════════
//  START FORCED CLOSE TIMER
//  Used when a NEW trade is placed.
//  Always starts with full TWO_HOURS_MS.
// ═══════════════════════════════════════════════════════

export function startForcedCloseTimer(tradeInfo) {
  const { contractId, symbol, direction, stake, token, appId, mode, label } = tradeInfo;
  const contractIdStr = String(contractId);

  cancelForcedCloseTimer(contractIdStr);

  console.log(`⏱️  [${label}] 2hr timer started for contract ${contractIdStr} (${symbol} ${direction})`);

  const timer = setTimeout(async () => {
    console.log(`\n⏰ [${label}] 2hr timer expired for ${contractIdStr} (${symbol} ${direction})`);
    console.log(`   Opening fresh connection to close trade...`);
    await forceCloseContract({ contractId: contractIdStr, symbol, direction, stake, token, appId, mode, label });
  }, TWO_HOURS_MS);

  openTimers.set(contractIdStr, timer);
}


// ═══════════════════════════════════════════════════════
//  RESTORE TIMERS AFTER REDEPLOY
//
//  Call this ONCE on bot startup per user.
//  Reads all open trades from DB, calculates how much
//  time is left on their 2hr window, and restarts each
//  timer with the correct remaining ms.
//
//  If a trade is already overdue (open > 2hrs) it fires
//  the close immediately with a short 5s delay so the
//  WebSocket connection is ready.
//
//  @param {Array}  openTrades  - Trade documents from DB
//                                (must have contractId, openedAt, symbol,
//                                 direction, stake, status)
//  @param {object} credentials - { token, appId, mode, label }
// ═══════════════════════════════════════════════════════

export function restoreTimersFromDB(openTrades, credentials) {
  const { token, appId, mode, label } = credentials;

  if (!openTrades || openTrades.length === 0) return;

  console.log(`\n🔁 [${label}] Restoring ${openTrades.length} forced-close timer(s) after redeploy...`);

  for (const trade of openTrades) {
    const contractIdStr = String(trade.contractId);

    // Skip if a timer is already running for this contract
    if (openTimers.has(contractIdStr)) {
      console.log(`   ⏭️  ${contractIdStr} already has a timer — skipping`);
      continue;
    }

    const openedAt     = new Date(trade.openedAt).getTime();
    const elapsed      = Date.now() - openedAt;
    const remaining    = TWO_HOURS_MS - elapsed;

    const tradeInfo = {
      contractId: contractIdStr,
      symbol:     trade.symbol,
      direction:  trade.direction,
      stake:      trade.stake,
      token, appId, mode, label,
    };

    if (remaining <= 0) {
      // Already overdue — close after short delay to let WS settle
      const overdueBy = Math.round(Math.abs(remaining) / 60000);
      console.log(`   ⚠️  [${label}] Contract ${contractIdStr} (${trade.symbol}) overdue by ${overdueBy}min — closing in 5s`);

      const timer = setTimeout(async () => {
        console.log(`\n⏰ [${label}] Force closing OVERDUE contract ${contractIdStr} (${trade.symbol})`);
        await forceCloseContract(tradeInfo);
      }, 5000);

      openTimers.set(contractIdStr, timer);

    } else {
      // Still within window — restart with remaining time
      const remainingMins = Math.round(remaining / 60000);
      const remainingHrs  = Math.floor(remainingMins / 60);
      const remainingMinDisplay = remainingMins % 60;
      const timeDisplay   = remainingHrs > 0
        ? `${remainingHrs}h ${remainingMinDisplay}m`
        : `${remainingMins}m`;

      console.log(`   ✅ [${label}] Contract ${contractIdStr} (${trade.symbol}) — ${timeDisplay} remaining`);

      const timer = setTimeout(async () => {
        console.log(`\n⏰ [${label}] 2hr timer expired (restored) for ${contractIdStr} (${trade.symbol})`);
        await forceCloseContract(tradeInfo);
      }, remaining);

      openTimers.set(contractIdStr, timer);
    }
  }

  console.log(`   ✅ [${label}] ${openTimers.size} active timer(s) running\n`);
}


// ═══════════════════════════════════════════════════════
//  CANCEL TIMER
// ═══════════════════════════════════════════════════════

export function cancelForcedCloseTimer(contractId) {
  const contractIdStr = String(contractId);
  const timer = openTimers.get(contractIdStr);
  if (timer) {
    clearTimeout(timer);
    openTimers.delete(contractIdStr);
    console.log(`⏱️  Timer cancelled for contract ${contractIdStr}`);
  }
}

export function getActiveTimerCount() {
  return openTimers.size;
}


// ═══════════════════════════════════════════════════════
//  PLACE MULTIPLIER TRADE
// ═══════════════════════════════════════════════════════

export async function placeMultiplierTrade(ws, symbol, direction, stake, multiplier, limitOrder) {

  const proposalPayload = {
    proposal:          1,
    contract_type:     direction,
    underlying_symbol: symbol,
    amount:            parseFloat(stake),
    basis:             "stake",
    currency:          "USD",
    multiplier,
  };

  if (limitOrder) {
    proposalPayload.limit_order = limitOrder;
    console.log(`   SL: $${limitOrder.stop_loss} | TP: $${limitOrder.take_profit} | Failsafe: 2hr forced close`);
  }

  const proposalResp = await sendMessage(ws, proposalPayload, "proposal");
  const proposalId   = proposalResp.proposal.id;
  const askPrice     = proposalResp.proposal.ask_price;

  const buyResp    = await sendMessage(ws, { buy: proposalId, price: askPrice }, "buy");
  const contract   = buyResp.buy;
  const contractId = contract.contract_id;
  const buyPrice   = parseFloat(contract.buy_price);

  console.log(`✅ Trade opened | ID: ${contractId} | ${direction} | $${buyPrice.toFixed(2)} | x${multiplier}`);

  return { contractId, buyPrice };
}


// ═══════════════════════════════════════════════════════
//  CLOSE TRADE
// ═══════════════════════════════════════════════════════

export async function closeTrade(ws, contractId) {
  console.log(`Closing contract ${contractId}...`);
  try {
    const response = await sendMessage(ws, {
      sell:  parseInt(contractId),
      price: 0,
    }, "sell");
    const soldFor = parseFloat(response.sell.sold_for);
    console.log(`Trade closed | ID: ${contractId} | Sold For: $${soldFor.toFixed(2)}`);
    cancelForcedCloseTimer(contractId);
    return soldFor;
  } catch (e) {
    console.log(`Close failed for ${contractId}: ${e.message} — already closed by SL/TP.`);
    cancelForcedCloseTimer(contractId);
    return null;
  }
}


// ═══════════════════════════════════════════════════════
//  PLACE TRADE WITH AUTO-LEARN MULTIPLIER RETRY
// ═══════════════════════════════════════════════════════

export async function placeTradeWithRetry(ws, symbol, direction, stake, limitOrder) {
  const key                           = cacheKey(symbol, direction);
  const { value: multiplier, source } = pickMultiplier(symbol, direction);

  console.log(`${symbol} | Multiplier: ${multiplier} (${source})`);

  // Attempt 1
  try {
    return await placeMultiplierTrade(ws, symbol, direction, stake, multiplier, limitOrder);
  } catch (e) {
    const isMultiplierError = /multiplier|Accepts|Allowed|acceptable range/i.test(e.message);
    if (!isMultiplierError) throw e;

    const allowed = parseMultipliersFromError(e.message);
    if (!allowed.length) {
      console.log(`${symbol} | Cannot parse multipliers from error`);
      throw e;
    }

    multiplierCache.set(key, allowed);
    const m2 = allowed[0];
    console.log(`${symbol} | Retrying with multiplier ${m2}`);

    // Attempt 2
    try {
      return await placeMultiplierTrade(ws, symbol, direction, stake, m2, limitOrder);
    } catch (e2) {
      const newAllowed = parseMultipliersFromError(e2.message);
      if (newAllowed.length) {
        const common = allowed.filter(x => newAllowed.includes(x));
        if (common.length) {
          multiplierCache.set(key, common);
          const m3 = common[0];
          console.log(`${symbol} | Final retry with multiplier ${m3}`);
          try {
            return await placeMultiplierTrade(ws, symbol, direction, stake, m3, limitOrder);
          } catch (e3) {
            console.log(`${symbol} | All retries failed: ${e3.message}`);
            multiplierCache.delete(key);
            return null;
          }
        }
      }
      console.log(`${symbol} | Retry failed: ${e2.message}`);
      return null;
    }
  }
}


// ── WATCH CONTRACT ─────────────────────────────────────
export function watchContract(ws, contractId, onUpdate) {
  ws.send(JSON.stringify({
    proposal_open_contract: 1,
    contract_id: contractId,
    subscribe:   1,
  }));
  ws.on("message", (data) => {
    const response = JSON.parse(data);
    if (response.msg_type === "proposal_open_contract") {
      onUpdate(response.proposal_open_contract);
    }
  });
}