// ═══════════════════════════════════════════════════════
//  src/trading/trader.js
//
//  Converted from trading.py + multiplier cache logic
//  from main.py — all combined in one file
//
//  Functions:
//    placeMultiplierTrade()   — open a MULTUP/MULTDOWN contract
//    placeTradeWithRetry()    — auto-learn multipliers on error
//    closeTrade()             — manually close a contract
//    getProposal()            — get a price quote (vanilla contracts)
//    buyContract()            — buy a vanilla contract
//    watchContract()          — subscribe to live contract updates
// ═══════════════════════════════════════════════════════

import { sendMessage } from "../utils/ws-client.js";

// ── FALLBACK MULTIPLIERS ──────────────────────────────
// Used when no cached value exists for a symbol+direction
// Equivalent to FALLBACK_MULTIPLIERS dict in main.py
const FALLBACK_MULTIPLIERS = {
  R_10:      400,
  R_25:      160,
  R_50:       80,
  R_75:       50,
  R_100:      40,
  frxXAUUSD: 100,
  frxXAGUSD: 100,
  cryBTCUSD: 100,
  cryETHUSD: 100,
};

// ── MULTIPLIER CACHE ──────────────────────────────────
// Map of "symbol|direction" → [allowed multipliers]
// Equivalent to _multiplier_cache dict in main.py
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

// ── PARSE MULTIPLIERS FROM ERROR TEXT ─────────────────
// Equivalent to parse_multipliers_from_error() in main.py
function parseMultipliersFromError(errorText) {
  const match = errorText.match(
    /(?:Accepts|Allowed)[:\s\[]*([\d,\s\[\]\.]+)/i
  );
  if (!match) return [];
  const nums = [...match[1].matchAll(/\d+/g)].map(m => parseInt(m[0]));
  return nums.sort((a, b) => a - b);
}


// ═══════════════════════════════════════════════════════
//  PLACE MULTIPLIER TRADE
//  Equivalent to place_multiplier_trade() in trading.py
// ═══════════════════════════════════════════════════════

/**
 * Open a Deriv Multiplier trade.
 *
 * @param {WebSocket} ws
 * @param {string} symbol      - e.g. "R_75"
 * @param {string} direction   - "MULTUP" (buy) or "MULTDOWN" (sell)
 * @param {number} stake       - amount in USD
 * @param {number} multiplier  - e.g. 50, 100, 200, 300, 500
 * @param {object|null} limitOrder - { stop_loss, take_profit } or null
 * @returns {{ contractId, buyPrice }}
 */
export async function placeMultiplierTrade(
  ws,
  symbol,
  direction,
  stake,
  multiplier = 50,
  limitOrder = null,
) {
  // ── Step 1: Get proposal ─────────────────────────────
  // New Deriv API uses two-step: proposal first, then buy
  const proposalPayload = {
    proposal:          1,
    contract_type:     direction,
    underlying_symbol: symbol,      // new API uses underlying_symbol not symbol
    amount:            parseFloat(stake),
    basis:             "stake",
    currency:          "USD",
    multiplier,
  };

  if (limitOrder) {
    proposalPayload.limit_order = limitOrder;
    console.log(`   Attaching limit_order: SL=$${limitOrder.stop_loss} TP=$${limitOrder.take_profit}`);
  }

  const proposalResp = await sendMessage(ws, proposalPayload, "proposal");
  const proposalId   = proposalResp.proposal.id;
  const askPrice     = proposalResp.proposal.ask_price;

  // ── Step 2: Buy the proposal ──────────────────────────
  const response = await sendMessage(ws, { buy: proposalId, price: askPrice }, "buy");

  const contract   = response.buy;
  const contractId = contract.contract_id;
  const buyPrice   = parseFloat(contract.buy_price);

  console.log(
    `✅ Trade opened | ID: ${contractId} | Price: $${buyPrice.toFixed(2)} | ` +
    `${direction} | Stake: $${stake.toFixed(2)} | x${multiplier}`
  );

  return { contractId, buyPrice };
}


// ═══════════════════════════════════════════════════════
//  PLACE TRADE WITH AUTO-LEARN MULTIPLIER RETRY
//  Equivalent to place_trade_with_retry() in main.py
// ═══════════════════════════════════════════════════════

/**
 * Tries to place a multiplier trade, and if Deriv rejects the
 * multiplier, parses the allowed values from the error, caches
 * them, and retries — up to 3 attempts with intersection logic.
 *
 * @returns {boolean} true if trade placed, false if all retries failed
 */
export async function placeTradeWithRetry(ws, symbol, direction, stake, limitOrder) {
  const key                    = cacheKey(symbol, direction);
  const { value: multiplier, source } = pickMultiplier(symbol, direction);

  console.log(`${symbol} | Multiplier: ${multiplier} (${source})`);

  // ── Attempt 1: use current multiplier ─────────────────
  try {
    await placeMultiplierTrade(ws, symbol, direction, stake, multiplier, limitOrder);
    return true;
  } catch (e) {
    const errorText = e.message;

    // If error is not about multipliers, re-throw immediately
    const isMultiplierError = /multiplier|Accepts|Allowed|acceptable range/i.test(errorText);
    if (!isMultiplierError) throw e;

    // Parse allowed multipliers from error message
    const allowed = parseMultipliersFromError(errorText);
    if (!allowed.length) {
      console.log(`${symbol} | Cannot parse multipliers from: ${errorText}`);
      throw e;
    }

    multiplierCache.set(key, allowed);
    const retry1Multiplier = allowed[0];
    console.log(`${symbol} | ${direction} allowed: [${allowed}] → retrying with ${retry1Multiplier}`);

    // ── Attempt 2: use first allowed multiplier ──────────
    try {
      await placeMultiplierTrade(ws, symbol, direction, stake, retry1Multiplier, limitOrder);
      return true;
    } catch (e2) {
      const retryText    = e2.message;
      const newAllowed   = parseMultipliersFromError(retryText);

      // ── Attempt 3: intersection of both lists ────────────
      if (newAllowed.length && newAllowed.join() !== allowed.join()) {
        const common = allowed.filter(x => newAllowed.includes(x)).sort((a,b) => a-b);

        if (common.length) {
          const retry2Multiplier = common[0];
          multiplierCache.set(key, common);
          console.log(
            `${symbol} | Conflicting lists [${allowed}] vs [${newAllowed}] ` +
            `→ intersection [${common}], retrying with ${retry2Multiplier}`
          );

          try {
            await placeMultiplierTrade(ws, symbol, direction, stake, retry2Multiplier, limitOrder);
            return true;
          } catch (e3) {
            console.log(`${symbol} | Final retry failed: ${e3.message} — skipping.`);
            multiplierCache.delete(key);
            return false;
          }
        } else {
          console.log(`${symbol} | No common multipliers — skipping.`);
          multiplierCache.delete(key);
          return false;
        }
      } else {
        console.log(`${symbol} | Retry failed: ${retryText} — skipping.`);
        return false;
      }
    }
  }
}


// ═══════════════════════════════════════════════════════
//  CLOSE TRADE
//  Equivalent to close_trade() in trading.py
// ═══════════════════════════════════════════════════════

/**
 * Manually close an open contract at current market price.
 * Handles already-stopped-out contracts gracefully.
 *
 * @returns {number|null} soldFor amount, or null if already closed
 */
export async function closeTrade(ws, contractId) {
  console.log(`Closing contract ${contractId}...`);

  try {
    const response = await sendMessage(
      ws,
      { sell: contractId, price: 0 },  // price: 0 = accept market price
      "sell"
    );

    const soldFor = parseFloat(response.sell.sold_for);
    console.log(`Trade closed | ID: ${contractId} | Sold For: $${soldFor.toFixed(2)}`);
    return soldFor;

  } catch (e) {
    // Equivalent to Python's "possibly already stopped out" check
    console.log(
      `Close failed for contract ${contractId}: ${e.message} — ` +
      `possibly already stopped out or expired.`
    );
    return null;
  }
}


// ═══════════════════════════════════════════════════════
//  VANILLA CONTRACT HELPERS (kept from original trader.js)
//  Used for simple Rise/Fall contracts (non-multiplier)
// ═══════════════════════════════════════════════════════

export async function getProposal(ws, options) {
  const { symbol, contract, amount, duration, durationUnit } = options;
  console.log(`📊 Getting proposal: ${contract} on ${symbol} for $${amount}...`);

  const response = await sendMessage(ws, {
    proposal:       1,
    amount,
    basis:          "stake",
    contract_type:  contract,
    currency:       "USD",
    duration,
    duration_unit:  durationUnit,
    underlying_symbol: symbol,
  }, "proposal");

  const proposal = response.proposal;
  console.log(`   Proposal ID: ${proposal.id} | Payout: $${proposal.payout} | Ask: $${proposal.ask_price}`);
  return proposal;
}

export async function buyContract(ws, proposalId, price) {
  console.log(`🛒 Buying contract (proposal: ${proposalId})...`);
  const response = await sendMessage(ws, { buy: proposalId, price }, "buy");
  const contract = response.buy;
  console.log(`✅ Contract bought! ID: ${contract.contract_id} | Buy: $${contract.buy_price} | Payout: $${contract.payout}`);
  return contract;
}

export function watchContract(ws, contractId, onUpdate) {
  console.log(`👁️  Watching contract ${contractId}...`);
  ws.send(JSON.stringify({
    proposal_open_contract: 1,
    contract_id: contractId,
    subscribe: 1,
  }));

  ws.on("message", (data) => {
    const response = JSON.parse(data);
    if (response.msg_type === "proposal_open_contract") {
      onUpdate(response.proposal_open_contract);
    }
  });
}