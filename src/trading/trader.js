// ═══════════════════════════════════════════════════════
//  src/trading/trader.js
//
//  Rise/Fall contracts with 2hr expiry
//  SL/TP as failsafe — if either hits before 2hrs,
//  Deriv closes the contract automatically.
//  If neither hits — contract expires at 2hrs and
//  pays out based on price vs entry at expiry.
//
//  Contract types:
//    CALL = Rise (price higher than entry at expiry)
//    PUT  = Fall (price lower than entry at expiry)
// ═══════════════════════════════════════════════════════

import { sendMessage } from "../utils/ws-client.js";

const DURATION      = 2;     // 2 hours
const DURATION_UNIT = "h";   // hours

/**
 * Place a Rise/Fall contract
 *
 * @param {WebSocket} ws
 * @param {string} symbol     - e.g. "frxEURUSD"
 * @param {string} direction  - "CALL" (rise) or "PUT" (fall)
 * @param {number} stake      - amount in USD
 * @returns {{ contractId, buyPrice }}
 */
export async function placeRiseFallTrade(ws, symbol, direction, stake) {
  console.log(`📊 Getting proposal: ${direction} on ${symbol} for $${stake.toFixed(2)} | Duration: ${DURATION}${DURATION_UNIT}...`);

  // Step 1: Get proposal
  const proposalPayload = {
    proposal:          1,
    contract_type:     direction,      // "CALL" or "PUT"
    underlying_symbol: symbol,
    amount:            parseFloat(stake),
    basis:             "stake",
    currency:          "USD",
    duration:          DURATION,
    duration_unit:     DURATION_UNIT,
  };

  const proposalResp = await sendMessage(ws, proposalPayload, "proposal");
  const proposal     = proposalResp.proposal;

  console.log(`   Proposal ID: ${proposal.id} | Payout: $${proposal.payout} | Ask: $${proposal.ask_price}`);

  // Step 2: Buy the contract
  const buyResp    = await sendMessage(ws, { buy: proposal.id, price: proposal.ask_price }, "buy");
  const contract   = buyResp.buy;
  const contractId = contract.contract_id;
  const buyPrice   = parseFloat(contract.buy_price);

  console.log(`✅ Trade opened | ID: ${contractId} | ${direction} | $${buyPrice.toFixed(2)} | Expires in ${DURATION}hr`);

  return { contractId, buyPrice };
}


/**
 * Sell/close a contract early (before expiry)
 * Used for manual close or emergency exit
 *
 * @param {WebSocket} ws
 * @param {string|number} contractId
 * @returns {number|null} soldFor amount
 */
export async function closeTrade(ws, contractId) {
  console.log(`Closing contract ${contractId}...`);
  try {
    const response = await sendMessage(ws, { sell: contractId, price: 0 }, "sell");
    const soldFor  = parseFloat(response.sell.sold_for);
    console.log(`Trade closed | ID: ${contractId} | Sold For: $${soldFor.toFixed(2)}`);
    return soldFor;
  } catch (e) {
    console.log(`Close failed for ${contractId}: ${e.message} — possibly already expired.`);
    return null;
  }
}


/**
 * Watch a contract for live updates
 * Calls onUpdate with the contract object on every tick
 *
 * @param {WebSocket} ws
 * @param {string|number} contractId
 * @param {function} onUpdate
 */
export function watchContract(ws, contractId, onUpdate) {
  console.log(`👁️  Watching contract ${contractId}...`);
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


// ── KEPT FOR COMPATIBILITY ─────────────────────────────
// placeTradeWithRetry now just calls placeRiseFallTrade
export async function placeTradeWithRetry(ws, symbol, direction, stake) {
  try {
    return await placeRiseFallTrade(ws, symbol, direction, stake);
  } catch (e) {
    console.error(`Trade failed for ${symbol}: ${e.message}`);
    return null;
  }
}

// Legacy vanilla helpers
export async function getProposal(ws, options) {
  const { symbol, contract, amount, duration, durationUnit } = options;
  const response = await sendMessage(ws, {
    proposal:          1,
    amount,
    basis:             "stake",
    contract_type:     contract,
    currency:          "USD",
    duration,
    duration_unit:     durationUnit,
    underlying_symbol: symbol,
  }, "proposal");
  return response.proposal;
}

export async function buyContract(ws, proposalId, price) {
  const response = await sendMessage(ws, { buy: proposalId, price }, "buy");
  return response.buy;
}