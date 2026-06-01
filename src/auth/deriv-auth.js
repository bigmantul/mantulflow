// ============================================
//  src/auth/deriv-auth.js
//  Each user passes their OWN token + appId
//  Never reads from process.env globally
// ============================================

import fetch from "node-fetch";

const REST_BASE_URL = "https://api.derivws.com/trading/v1";

/**
 * Build auth headers using the provided token and appId.
 * Falls back to env vars only for standalone bot (index.js).
 */
export function getAuthHeaders(token, appId) {
  const t = token || process.env.DERIV_PAT_TOKEN;
  const a = appId || process.env.DERIV_APP_ID;

  if (!t || t === "pat_your_token_here")
    throw new Error("DERIV_PAT_TOKEN not set");
  if (!a || a === "your_app_id_here")
    throw new Error("DERIV_APP_ID not set");

  return {
    Authorization:  `Bearer ${t}`,
    "Deriv-App-ID": a,
    "Content-Type": "application/json",
  };
}

/**
 * Fetch accounts for a specific user using their own credentials.
 */
export async function getAccounts(token, appId) {
  const response = await fetch(`${REST_BASE_URL}/options/accounts`, {
    method:  "GET",
    headers: getAuthHeaders(token, appId),
  });

  const text = await response.text();
  if (!response.ok)
    throw new Error(`Failed to fetch accounts [${response.status}]: ${text}`);

  const data     = JSON.parse(text);
  const accounts =
    data?.data?.accounts ||
    data?.data ||
    data?.accounts ||
    (Array.isArray(data) ? data : null);

  if (!accounts || accounts.length === 0)
    throw new Error("No trading accounts found. Check PAT token scopes.");

  return accounts;
}

/**
 * Get authenticated WebSocket URL for a specific account.
 */
export async function getAuthenticatedWebSocketURL(accountId, token, appId) {
  const response = await fetch(
    `${REST_BASE_URL}/options/accounts/${accountId}/otp`,
    {
      method:  "POST",
      headers: getAuthHeaders(token, appId),
    }
  );

  const text = await response.text();
  if (!response.ok)
    throw new Error(`OTP failed [${response.status}]: ${text}`);

  const data  = JSON.parse(text);
  const wsUrl = data?.data?.url || data?.url;
  if (!wsUrl)
    throw new Error(`No WebSocket URL in OTP response: ${text}`);

  return wsUrl;
}

/**
 * Main connection function — picks the right account by mode
 * and returns an authenticated WebSocket URL.
 *
 * @param {string} mode    - "demo" or "real"
 * @param {string} token   - user's PAT token
 * @param {string} appId   - user's App ID
 */
export async function connectForMode(mode = "demo", token, appId) {
  // Use env vars as fallback for standalone bot (index.js)
  const t = token || process.env.DERIV_PAT_TOKEN;
  const a = appId || process.env.DERIV_APP_ID;

  const accounts = await getAccounts(t, a);

  const account = accounts.find(acc => {
    const type = (acc.account_type || acc.type || "").toLowerCase();
    return mode === "demo"
      ? type.includes("demo") || type.includes("virtual")
      : type.includes("real") || type.includes("live");
  }) || accounts[0];

  const accountId =
    account.account_id || account.accountId ||
    account.id        || account.loginid   || account.login_id;

  if (!accountId)
    throw new Error(`Could not find account ID. Keys: ${Object.keys(account).join(", ")}`);

  console.log(`🎯 [${mode}] Account: ${accountId}`);

  return await getAuthenticatedWebSocketURL(accountId, t, a);
}