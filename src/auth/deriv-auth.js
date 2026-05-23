
import fetch from "node-fetch";
import "dotenv/config";

const REST_BASE_URL = "https://api.derivws.com/trading/v1";

export function getAuthHeaders() {
  const token = process.env.DERIV_PAT_TOKEN;
  const appId = process.env.DERIV_APP_ID;
  if (!token || token === "pat_your_token_here") throw new Error("DERIV_PAT_TOKEN not set in .env");
  if (!appId || appId === "your_app_id_here") throw new Error("DERIV_APP_ID not set in .env");
  return {
    Authorization: `Bearer ${token}`,
    "Deriv-App-ID": appId,
    "Content-Type": "application/json",
  };
}

export async function getAccounts() {
  console.log("Fetching accounts...");
  const response = await fetch(`${REST_BASE_URL}/options/accounts`, {
    method: "GET",
    headers: getAuthHeaders(),
  });
  const text = await response.text();
  console.log("RAW accounts response:", text);
  if (!response.ok) throw new Error(`Accounts failed [${response.status}]: ${text}`);
  const data = JSON.parse(text);
  const accounts = data?.data?.accounts || data?.data || data?.accounts || (Array.isArray(data) ? data : null);
  if (!accounts || accounts.length === 0) throw new Error("No accounts found");
  return accounts;
}

export async function connectForMode(mode = "demo") {
  const accounts = await getAccounts();
  console.log("All accounts:", JSON.stringify(accounts, null, 2));
  const account = accounts.find(a => {
    const type = (a.account_type || a.type || a.accountType || "").toLowerCase();
    return mode === "demo" ? type.includes("demo") || type.includes("virtual") : type.includes("real");
  }) || accounts[0];
  const accountId = account.account_id || account.accountId || account.id || account.loginid || account.login_id;
  console.log("Using account ID:", accountId);
  console.log("Full account object:", JSON.stringify(account));
  if (!accountId) throw new Error("Could not find account ID. Keys: " + Object.keys(account).join(", "));
  const otpRes = await fetch(`${REST_BASE_URL}/options/accounts/${accountId}/otp`, {
    method: "POST",
    headers: getAuthHeaders(),
  });
  const otpText = await otpRes.text();
  console.log("RAW OTP response:", otpText);
  if (!otpRes.ok) throw new Error(`OTP failed [${otpRes.status}]: ${otpText}`);
  const otpData = JSON.parse(otpText);
  const wsUrl = otpData?.data?.url || otpData?.url || otpData?.websocket_url;
  if (!wsUrl) throw new Error("No WebSocket URL in OTP response: " + otpText);
  return wsUrl;
}
