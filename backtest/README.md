# Backtesting the Daily Bias Strategy

## Quick start (synthetic dry run — no Deriv account needed)
```bash
node backtest/generate-sample-data.js frxEURUSD 365
node backtest/run.js frxEURUSD
```

## Real backtest (run on your machine/Render — Deriv API isn't reachable from Claude's sandbox)
```bash
DERIV_PAT_TOKEN=xxx DERIV_APP_ID=yyy node backtest/fetch-history.js frxEURUSD --days=365 --mode=demo
node backtest/run.js frxEURUSD --equity=1000 --risk=0.02 --sl=0.80 --tp=2.00
```
Repeat `fetch-history.js` for each symbol you want to test (BOOM500, R_75, frxXAUUSD, etc.) — `--days` controls how far back to pull (it pages past Deriv's 5000-candle-per-request cap automatically).

## What this does NOT reimplement
`engine.js` imports the real `collectSignals()`, `RiskManager`, and `StopLossTakeProfit` from `src/`. It does not re-derive the strategy logic — a backtest result reflects what the actual strategy code does, including any bugs in it (good for finding them, bad if you forget that and think it's a clean reference implementation).

## Things to know about how the simulation works
- **No lookahead**: at each simulated M15 bar, the engine only exposes D1/H1/M15 data that would actually have been "closed" by that point in time.
- **Date mocking**: `signals.js` decides "is this a new trading day" and "are we in the London/NY session" using real `new Date()`. Looping it over history naively would freeze Stage 1 after the very first call. `engine.js` works around this with a scoped fake-clock wrapper — `signals.js` itself isn't modified.
- **Same-bar SL/TP conflict**: if a bar's range could have hit both stop-loss and take-profit, the engine assumes SL hit first (conservative, avoids overstating results).
- **Exit checking is at M15 resolution**, not tick-level — fine for swing-style SL/TP distances, less precise for very tight stops.
- **One position at a time per symbol** (mirrors your trade-lock behavior). Multi-symbol portfolio-level concurrency isn't modeled yet — each symbol's stats are independent.
- **Stake sizing bypasses `RiskManager.calculateStake()` on purpose** and computes `equity × riskPct` directly — see the bug note below.

## Bugs found and fixed while building this (in `src/risk/risk-manager.js`)
1. **`calculateStake()` was using `riskPct` as a raw multiplier** (`balance * riskPct`) instead of a percentage (`balance * riskPct/100`). With the default `riskPct=10`, that computed `balance × 10`, which immediately clamps to the `$1000` hard cap regardless of account size. **Fixed**: now divides by 100.
   - Scope check: this only affects **standalone bot mode** (`npm run bot` → `src/index.js`, the only caller of `calculateStake()`). Your **dashboard-managed bots use a fixed `stakeAmount` field** (`bot-manager.js:556`) and never call this method, so they were unaffected.
2. **`maxDailyLossPct` defaulted to `30`** but is compared against a 0–1 ratio (`-dailyPnl/startingBalance >= maxDailyLossPct`), so the circuit breaker could never trip in standalone mode. The dashboard's Mongoose schema already defaults this correctly to `0.30` — only the class's own fallback default was wrong. **Fixed**: default changed to `0.30`.

## Files
- `engine.js` — the simulator (`runBacktest()`)
- `generate-sample-data.js` — synthetic OHLC generator for dry runs
- `fetch-history.js` — real Deriv historical data puller (paginated)
- `run.js` — CLI: load data → run backtest → print report → write trade CSV
- `data/` — fetched/generated candle JSON per symbol (gitignored-worthy — these can get large)
- `results/` — output trade-log CSVs
