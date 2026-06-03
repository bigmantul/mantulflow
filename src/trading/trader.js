// ═══════════════════════════════════════════════════════
//  src/trading/trader.js
//
//  Multiplier trades (MULTUP/MULTDOWN) with:
//    - SL/TP as primary exit
//    - 2hr forced close as failsafe
//
//  Exit priority:
//    1. SL hits   → Deriv closes automatically
//    2. TP hits   → Deriv closes automatically
//    3. 2hr timer → bot calls sell at market price
// ═══════════════════════════════════════════════════════

import { sendMessage } from "../utils/ws-client.js";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

// Map of contractId → timeout handle
// So we can cancel the timer if SL/TP closes it early
const openTimers = new Map();

// Fallback multipliers per symbol
const FALLBACK_MULTIPLIERS = {
  frxEURUSD: 100, frxGBPUSD: 100, frxUSDJPY: 100,
  frxUSDCHF: 100, frxAUDUSD: 100, frxUSDCAD: 100,
  frxNZDUSD: 100,
  cryBTCUSD: 100, cryETHUSD: 100,
  cryLTCUSD: 100, cryBCHUSD: 100,
  frxXAUUSD: 100, frxXAGUSD: 100,
};

// Multiplier cache — learns from API errors
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
  return [...match[1].matchAll(/\d+/g)].map(m => parseInt(m[0])).sort((a, b) => a - b);
}


// ═══════════════════════════════════════════════════════
//  PLACE MULTIPLIER TRADE
// ═══════════════════════════════════════════════════════

/**
 * Place a MULTUP or MULTDOWN contract with SL/TP
 * and start a 2hr forced-close timer.
 *
 * @param {WebSocket} ws
 * @param {string} symbol
 * @param {string} direction  - "MULTUP" or "MULTDOWN"
 * @param {number} stake
 * @param {number} multiplier
 * @param {object} limitOrder - { stop_loss, take_profit }
 * @returns {{ contractId, buyPrice }}
 */
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
    console.log(`   SL: $${limitOrder.stop_loss} | TP: $${limitOrder.take_profit} | Failsafe: 2hr close`);
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

  // Step 3: Start 2hr forced-close timer
  startForcedCloseTimer(ws, contractId, symbol, direction, stake);

  return { contractId, buyPrice };
}


// ═══════════════════════════════════════════════════════
//  2HR FORCED CLOSE TIMER
// ═══════════════════════════════════════════════════════

/**
 * Starts a 2hr timer. When it fires:
 *   - If SL/TP already closed the contract → Deriv will
 *     return an error on sell, which we catch gracefully
 *   - If contract is still open → we close it at market
 */
function startForcedCloseTimer(ws, contractId, symbol, direction, stake) {
  console.log(`⏱️  2hr timer started for contract ${contractId}`);

  const timer = setTimeout(async () => {
    console.log(`\n⏰ 2hr timer expired for ${contractId} (${symbol} ${direction})`);
    console.log(`   Closing at market price...`);

    const soldFor = await closeTrade(ws, contractId);

    if (soldFor !== null) {
      const pnl = soldFor - stake;
      const result = pnl >= 0 ? "✅ WON" : "❌ LOST";
      console.log(`   ${result} | Sold: $${soldFor.toFixed(2)} | PnL: $${pnl.toFixed(2)}`);
    } else {
      console.log(`   Contract already closed by SL/TP before 2hr timer.`);
    }

    openTimers.delete(String(contractId));
  }, TWO_HOURS_MS);

  openTimers.set(String(contractId), timer);
}


/**
 * Cancel the 2hr timer — call this if you manually close
 * a contract before the timer fires
 */
export function cancelForcedCloseTimer(contractId) {
  const timer = openTimers.get(String(contractId));
  if (timer) {
    clearTimeout(timer);
    openTimers.delete(String(contractId));
    console.log(`⏱️  Timer cancelled for contract ${contractId}`);
  }
}


// ═══════════════════════════════════════════════════════
//  CLOSE TRADE
// ═══════════════════════════════════════════════════════

export async function closeTrade(ws, contractId) {
  console.log(`Closing contract ${contractId}...`);
  try {
    const response = await sendMessage(ws, { sell: contractId, price: 0 }, "sell");
    const soldFor  = parseFloat(response.sell.sold_for);
    console.log(`Trade closed | ID: ${contractId} | Sold For: $${soldFor.toFixed(2)}`);
    // Cancel timer since we closed manually
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
  const key                        = cacheKey(symbol, direction);
  const { value: multiplier, source } = pickMultiplier(symbol, direction);

  console.log(`${symbol} | Multiplier: ${multiplier} (${source})`);

  // Attempt 1
  try {
    return await placeMultiplierTrade(ws, symbol, direction, stake, multiplier, limitOrder);
  } catch (e) {
    const isMultiplierError = /multiplier|Accepts|Allowed|acceptable range/i.test(e.message);
    if (!isMultiplierError) throw e;

    const allowed = parseMultipliersFromError(e.message);
    if (!allowed.length) { console.log(`${symbol} | Cannot parse multipliers`); throw e; }

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


// ── WATCH CONTRACT ────────────────────────────────────
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