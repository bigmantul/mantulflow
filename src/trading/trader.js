// ═══════════════════════════════════════════════════════
//  src/trading/trader.js
//
//  Multiplier trades (MULTUP/MULTDOWN) with:
//    - SL/TP as primary exit
//    - 2hr forced close as failsafe for EVERY trade
//
//  Timer fix:
//    Each trade gets its own independent timer.
//    Timer stores user credentials so it can open a
//    FRESH WebSocket connection when it fires —
//    not relying on the original ws reference which
//    may have changed due to reconnection.
// ═══════════════════════════════════════════════════════

import { sendMessage, connectWebSocket } from "../utils/ws-client.js";
import { connectForMode }                from "../auth/deriv-auth.js";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000; // ← change here to adjust time

// Timer registry: contractId → timeoutHandle
// Kept so we can cancel if SL/TP closes the trade first
const openTimers = new Map();

// Fallback multipliers per symbol
const FALLBACK_MULTIPLIERS = {

  // =========================
  // FOREX (LOW VOLATILITY)
  // =========================
  frxEURUSD: 100, frxGBPUSD: 100, frxUSDJPY: 100,
  frxUSDCHF: 100, frxAUDUSD: 100, frxUSDCAD: 100,
  frxNZDUSD: 100, frxGBPJPY: 80,
  frxEURGBP: 80, frxEURCHF: 80, frxEURCAD: 80, frxEURAUD: 80,

  // =========================
  // METALS (MEDIUM VOLATILITY)
  // =========================
  frxXAUUSD: 60,  // Gold
  frxXAGUSD: 60,  // Silver

  // =========================
  // CRYPTO (HIGH VOLATILITY)
  // =========================
  cryBTCUSD: 40,
  cryETHUSD: 40,

  // =========================
  // INDICES (MEDIUM RISK)
  // =========================
  frxUS500: 60,
  frxUSTEC: 60,
  frxUS30: 50,

  // =========================
  // BOOM & CRASH (HIGH RISK)
  // =========================
  BOOM500: 30,
  CRASH500: 30,

  // =========================
  // JUMP INDICES (VERY HIGH RISK)
  // =========================
  JD75: 25,
  JD100: 25,

  // =========================
  // STEP INDICES (LOW-MEDIUM RISK)
  // =========================
  stpRNG400: 80,
  stpRNG500: 80,

  // =========================
  // VOLATILITY INDICES (EXTREME RISK)
  // =========================
  R_75: 25,
  R_100: 20
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
  const match = errorText.match(/(?:Accepts|Allowed)[:\s\[]*([\d,\s\[\]\.]+)/i);
  if (!match) return [];
  return [...match[1].matchAll(/\d+/g)]
    .map(m => parseInt(m[0]))
    .sort((a, b) => a - b);
}


// ═══════════════════════════════════════════════════════
//  2HR FORCED CLOSE TIMER
//  Each trade gets its own timer with its own credentials
//  so reconnections don't affect other trades
// ═══════════════════════════════════════════════════════

/**
 * Start a 2hr forced close timer for a specific contract.
 *
 * Stores the user's credentials so when the timer fires
 * it opens a FRESH connection — completely independent
 * of whatever the main bot loop is doing.
 *
 * @param {object} tradeInfo
 * @param {string} tradeInfo.contractId
 * @param {string} tradeInfo.symbol
 * @param {string} tradeInfo.direction
 * @param {number} tradeInfo.stake
 * @param {string} tradeInfo.token     - user's PAT token
 * @param {string} tradeInfo.appId     - user's App ID
 * @param {string} tradeInfo.mode      - "demo" or "real"
 * @param {string} tradeInfo.label     - user's name for logs
 */
export function startForcedCloseTimer(tradeInfo) {
  const { contractId, symbol, direction, stake, token, appId, mode, label } = tradeInfo;
  const contractIdStr = String(contractId);

  // Cancel existing timer for this contract if any
  cancelForcedCloseTimer(contractIdStr);

  console.log(`⏱️  [${label}] 2hr timer started for contract ${contractIdStr} (${symbol} ${direction})`);

  const timer = setTimeout(async () => {
    console.log(`\n⏰ [${label}] 2hr timer expired for ${contractIdStr} (${symbol} ${direction})`);
    console.log(`   Opening fresh connection to close trade...`);

    let ws = null;
    try {
      // Open a FRESH WebSocket — independent of the main bot loop
      const wsUrl = await connectForMode(mode, token, appId);
      ws          = await connectWebSocket(wsUrl);

      // Try to sell the contract at market price
      const response = await sendMessage(ws, {
        sell:  parseInt(contractIdStr),
        price: 0,
      }, "sell");

      const soldFor  = parseFloat(response.sell.sold_for);
      const finalPnl = soldFor - stake;
      const result   = finalPnl >= 0 ? "✅ WON" : "❌ LOST";

      console.log(`   [${label}] ${result} | ${symbol} | Sold: $${soldFor.toFixed(2)} | PnL: $${finalPnl.toFixed(2)}`);

    } catch (e) {
      // Contract already closed by SL/TP — this is normal
      if (e.message.includes("sold") || e.message.includes("closed") || e.message.includes("expired")) {
        console.log(`   [${label}] Contract ${contractIdStr} already closed by SL/TP before 2hr timer.`);
      } else {
        console.error(`   [${label}] Force close error: ${e.message}`);
      }
    } finally {
      if (ws) ws.close();
      openTimers.delete(contractIdStr);
    }
  }, TWO_HOURS_MS);

  openTimers.set(contractIdStr, timer);
}

/**
 * Cancel the 2hr timer for a contract.
 * Call this when SL/TP closes the trade so the timer
 * doesn't try to close an already-closed contract.
 */
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

  // Step 1: Get proposal
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

  // Step 2: Buy
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
  const key                          = cacheKey(symbol, direction);
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