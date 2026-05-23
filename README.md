# Deriv SMC Trading Bot

Automated trading bot using Smart Money Concepts (SMC) strategy on Deriv.
Runs on Render free tier with Telegram notifications.

---

## Complete Setup Guide

---

### PART 1 — Telegram Notifications Setup

#### Step 1: Create your Telegram bot

1. Open Telegram and search for **@BotFather**
2. Send the message: `/newbot`
3. BotFather will ask for a name — type anything e.g. `My Deriv Bot`
4. Then it asks for a username — must end in `bot` e.g. `myderivtrading_bot`
5. BotFather replies with your **Bot Token** — looks like:
   ```
   7123456789:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
6. Copy and save this token

#### Step 2: Get your Chat ID

1. Search for your new bot in Telegram and click **Start**
2. Send any message to the bot (e.g. "hello")
3. Open this URL in your browser (replace YOUR_TOKEN):
   ```
   https://api.telegram.org/botYOUR_TOKEN/getUpdates
   ```
4. You will see a JSON response — find the `"id"` field inside `"chat"`:
   ```json
   "chat": { "id": 123456789, ... }
   ```
5. That number is your **Chat ID** — copy it

#### Step 3: Add to your .env file

Open `.env` and fill in:
```
TELEGRAM_BOT_TOKEN=7123456789:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_CHAT_ID=123456789
```

#### Step 4: Test it

Run the bot locally with `npm start` — you should receive a startup message
on Telegram immediately. If not, double-check the token and chat ID.

---

### PART 2 — Send to GitHub

#### Step 1: Install Git (if not already)

Download from: https://git-scm.com/download/win
During install, select "Git from the command line" option.

#### Step 2: Files to DELETE before pushing

Delete these — they must never go to GitHub:

```
node_modules/        ← delete entire folder
.env                 ← contains your secret keys
```

The `.gitignore` file already tells Git to ignore these.
Just delete `node_modules/` to keep the repo clean.

To delete node_modules in PowerShell:
```powershell
Remove-Item -Recurse -Force node_modules
```

#### Step 3: Create a GitHub repository

1. Go to https://github.com and sign in (create account if needed)
2. Click the **+** button → **New repository**
3. Name it: `deriv-bot`
4. Set to **Private** (important — your strategy is in here)
5. Do NOT tick "Add README" or "Add .gitignore" — we have those already
6. Click **Create repository**
7. GitHub shows you a page with commands — copy the repo URL, looks like:
   ```
   https://github.com/YOUR_USERNAME/deriv-bot.git
   ```

#### Step 4: Push your code

Run these commands in PowerShell inside your `deriv_bot` folder:

```powershell
# 1. Initialize git repo
git init

# 2. Add all files (node_modules and .env are ignored automatically)
git add .

# 3. First commit
git commit -m "Initial bot commit"

# 4. Set branch name
git branch -M main

# 5. Connect to your GitHub repo (paste your URL)
git remote add origin https://github.com/YOUR_USERNAME/deriv-bot.git

# 6. Push to GitHub
git push -u origin main
```

GitHub will ask for your username and password.
For password — use a **Personal Access Token**, not your GitHub password:
1. GitHub → Settings → Developer Settings → Personal access tokens → Tokens (classic)
2. Generate new token → tick `repo` scope → copy the token
3. Use that token as your password when Git asks

#### Step 5: Verify

Go to `https://github.com/YOUR_USERNAME/deriv-bot` — you should see all your files.
Confirm that `.env` and `node_modules/` are NOT there.

---

### PART 3 — Deploy to Render

#### Step 1: Create a Render account

Go to https://render.com and sign up with your GitHub account.

#### Step 2: Create a new Web Service

1. Click **New +** → **Web Service**
2. Click **Connect a repository** → select `deriv-bot`
3. Fill in the settings:

   | Field | Value |
   |---|---|
   | Name | `deriv-bot` |
   | Region | Frankfurt (EU) or closest to you |
   | Branch | `main` |
   | Runtime | `Node` |
   | Build Command | `npm install` |
   | Start Command | `node src/index.js` |
   | Instance Type | `Free` |

4. Click **Advanced** → **Add Environment Variables**

   Add each of these one by one:

   | Key | Value |
   |---|---|
   | `DERIV_PAT_TOKEN` | your `pat_...` token |
   | `DERIV_APP_ID` | your app ID |
   | `TRADING_MODE` | `demo` |
   | `TELEGRAM_BOT_TOKEN` | your telegram bot token |
   | `TELEGRAM_CHAT_ID` | your telegram chat ID |

5. Click **Create Web Service**

#### Step 3: Watch it deploy

Render will:
1. Clone your GitHub repo
2. Run `npm install`
3. Run `node src/index.js`

You will see the bot logs live in the Render dashboard.
You should also receive a Telegram message: **"Deriv Bot Started"**

#### Step 4: Keep it alive (important for free tier)

Render free tier suspends after 15 minutes of no HTTP traffic.
The bot's health server on port 8080 handles this — but you need
an external pinger to call it every 10 minutes.

Use **UptimeRobot** (free):
1. Go to https://uptimerobot.com and create an account
2. Click **Add New Monitor**
3. Type: **HTTP(s)**
4. Friendly Name: `Deriv Bot`
5. URL: your Render URL — looks like `https://deriv-bot-xxxx.onrender.com`
6. Monitoring interval: **5 minutes**
7. Click **Create Monitor**

UptimeRobot will ping your bot every 5 minutes, keeping Render awake 24/7.

---

### Updating the bot later

When you make changes locally:

```powershell
git add .
git commit -m "describe your change here"
git push
```

Render detects the push automatically and redeploys within 1-2 minutes.

---

## Project Structure

```
deriv-bot/
├── src/
│   ├── auth/
│   │   └── deriv-auth.js       PAT login, OTP, WebSocket URL
│   ├── data/
│   │   └── candles.js          Fetch OHLC candles (5m/15m/4H)
│   ├── strategy/
│   │   └── signals.js          SMC engine, 7 vote layers, market hours
│   ├── risk/
│   │   └── risk-manager.js     Stake sizing, daily loss, streak halt
│   ├── trading/
│   │   ├── trader.js           Multiplier trades + auto-retry
│   │   └── portfolio.js        Track open trades, symbol locking
│   ├── utils/
│   │   ├── ws-client.js        WebSocket connection manager
│   │   ├── health-server.js    HTTP :8080 for Render keepalive
│   │   └── telegram.js         Telegram notification functions
│   ├── index.js                Main bot loop
│   └── test-connection.js      Test credentials before running
├── .env                        Secrets — NEVER commit this
├── .gitignore                  Tells git to ignore .env + node_modules
├── package.json
└── README.md
```

---

## Environment Variables Reference

| Variable | Where to get it | Example |
|---|---|---|
| `DERIV_PAT_TOKEN` | developers.deriv.com → API tokens | `pat_abc123...` |
| `DERIV_APP_ID` | developers.deriv.com → Dashboard | `33kDvVzcElBmdV0wfzTy1` |
| `TRADING_MODE` | Set manually | `demo` or `real` |
| `TELEGRAM_BOT_TOKEN` | @BotFather on Telegram | `7123456789:AAF...` |
| `TELEGRAM_CHAT_ID` | getUpdates API call | `123456789` |
| `PORT` | Set by Render automatically | `8080` |