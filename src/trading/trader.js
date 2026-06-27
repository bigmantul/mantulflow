// ═══════════════════════════════════════════════════════
//  src/trading/trader.js
//
//  Multiplier trades (MULTUP/MULTDOWN) with:
//    - SL/TP as primary exit
//    - Configurable forced close duration as failsafe
//      (per-user setting, can be turned OFF entirely)
// ═══════════════════════════════════════════════════════

import { sendMessage, connectWebSocket } from "../utils/ws-client.js";
import { connectForMode }                from "../auth/deriv-auth.js";
import { FALLBACK_MULTIPLIERS }          from "./multipliers.js";

// Timer registry: contractId → timeoutHandle
const openTimers = new Map();

// Re-exported for backward compatibility — table itself now lives in multipliers.js
export { FALLBACK_MULTIPLIERS };

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
//  CORE FORCED CLOSE
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
//
//  durationMins: number of minutes until forced close.
//  null, 0, or undefined = OFF — no timer is started at
//  all, and the trade relies entirely on SL/TP/trailing
//  stop to close. This is per-user configurable, with NO
//  minimum or maximum enforced.
// ═══════════════════════════════════════════════════════

export function startForcedCloseTimer(tradeInfo) {
  const { contractId, symbol, direction, stake, token, appId, mode, label, durationMins } = tradeInfo;
  const contractIdStr = String(contractId);

  cancelForcedCloseTimer(contractIdStr);

  // OFF — no forced close timer, SL/TP/trailing stop are the only exits
  if (!durationMins || durationMins <= 0) {
    console.log(`⏱️  [${label}] Forced close OFF for contract ${contractIdStr} (${symbol} ${direction}) — SL/TP/trailing only`);
    return;
  }

  const durationMs = durationMins * 60 * 1000;
  const display = durationMins >= 60
    ? `${Math.floor(durationMins / 60)}h ${durationMins % 60}m`
    : `${durationMins}m`;

  console.log(`⏱️  [${label}] Forced close timer started for contract ${contractIdStr} (${symbol} ${direction}) — ${display}`);

  const timer = setTimeout(async () => {
    console.log(`\n⏰ [${label}] Forced close timer expired for ${contractIdStr} (${symbol} ${direction})`);
    console.log(`   Opening fresh connection to close trade...`);
    await forceCloseContract({ contractId: contractIdStr, symbol, direction, stake, token, appId, mode, label });
  }, durationMs);

  openTimers.set(contractIdStr, timer);
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
    console.log(`   SL: $${limitOrder.stop_loss} | TP: $${limitOrder.take_profit}`);
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
//  UPDATE CONTRACT SL/TP (used by trailing stop)
// ═══════════════════════════════════════════════════════

export async function updateContractSL(ws, contractId, newStopLoss) {
  try {
    await sendMessage(ws, {
      contract_update: 1,
      contract_id:     parseInt(contractId),
      limit_order:     { stop_loss: newStopLoss },
    }, "contract_update");
    return true;
  } catch (e) {
    console.log(`Could not update SL for ${contractId}: ${e.message}`);
    return false;
  }
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