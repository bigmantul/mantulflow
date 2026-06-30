# Backtesting the Daily Bias Strategy

## 1. Set up your personal risk settings (recommended, do this first)
```bash
cp backtest/my-risk-settings.example.js backtest/my-risk-settings.js
```
Edit `backtest/my-risk-settings.js` and copy in your actual dashboard values (stake amount, stop loss %, take profit %, PnL Lock %, contract duration, no-profit cutoff, cutoff cooldown). This file is gitignored — your personal numbers never get committed. Once it exists, `run.js` and `run-all.js` both load it automatically as their defaults, so you don't need to retype every flag on every run. Any CLI flag you do pass still overrides just that one value.

## 2. Quick start (synthetic dry run — no Deriv account needed)
```bash
node backtest/generate-sample-data.js frxEURUSD 365
node backtest/run.js frxEURUSD
```
This proves the machinery works end-to-end. It is NOT real market data — don't draw conclusions about strategy edge from it, only use it to confirm everything runs.

## 3. Real backtest, one symbol
Fetching must run on YOUR machine, not in this sandbox — Deriv's API is blocked here.
```bash
DERIV_PAT_TOKEN=xxx DERIV_APP_ID=yyy node backtest/fetch-history.js frxEURUSD --days=365 --mode=demo
node backtest/run.js frxEURUSD
```
If you've set up `my-risk-settings.js`, that second command alone uses your real numbers. Otherwise pass them explicitly:
```bash
node backtest/run.js frxEURUSD --equity=1000 --stake=1.00 --trailing=0.5 --duration=120 --cutoff=20 --cooldown=2
```

## 4. Real backtest, ALL symbols at once
```bash
DERIV_PAT_TOKEN=xxx DERIV_APP_ID=yyy node backtest/fetch-all-history.js --days=1095 --mode=demo
node backtest/run-all.js
```
`fetch-all-history.js` loops every symbol in `src/config/symbols.js` (the same 48 the live bot scans) and writes one data file per symbol. This takes a while — 3 years of M15 data per symbol means many paginated requests, with a 1-second delay between symbols to stay clear of rate limits. It's safe to stop and resume: existing `backtest/data/<symbol>.json` files are skipped automatically unless you pass `--force`.

`run-all.js` then scans every symbol — using real data wherever a file exists, falling back to synthetic for anything missing (add `--real-only` to skip those instead of substituting synthetic data).

## CLI flags (all optional, all override `my-risk-settings.js` if passed)
| Flag | Matches dashboard setting | Default | 0 means |
|---|---|---|---|
| `--equity=1000` | starting balance per symbol (backtest-only, not a real dashboard field) | 1000 | — |
| `--stake=1.00` | `stakeAmount` — fixed dollar stake, exactly how production sizes trades | none (falls back to `--risk`) | — |
| `--risk=0.02` | backtest-only fallback, % of equity (production doesn't use this mode) | 0.02 | — |
| `--sl=0.80` | `stopLossPct` | 0.80 | — |
| `--tp=2.00` | `takeProfitPct` | 2.00 | — |
| `--trailing=0.5` | `trailingStopPct` (PnL Lock %) | 0.5 | disables PnL Lock |
| `--duration=120` | `contractDurationMins` | 120 | disables forced-close timer |
| `--cutoff=20` | `noProfitCutoffMins` | 20 | disables the no-profit cutoff entirely |
| `--cooldown=2` | `cutoffCooldownHours` | 2 | no cooldown lock applied after a cutoff exit |

Example — disable the no-profit cutoff entirely for one test run, leaving everything else as your saved settings:
```bash
node backtest/run.js frxEURUSD --cutoff=0
```

## What this does NOT reimplement
`engine.js` imports the real `collectSignals()`, `RiskManager`, and `StopLossTakeProfit` from `src/`. It does not re-derive the strategy logic — a backtest result reflects what the actual strategy code does, including any bugs in it (good for finding them, bad if you forget that and think it's a clean reference implementation).

## Exit rules simulated (same priority order as `dashboard/bot-manager.js`'s `monitorOpenTrades`)
1. No-profit cutoff (configurable, default 20min, 0 = OFF) — closes if open ≥ `noProfitCutoffMins` and PnL ≤ 0, then locks the symbol for `cutoffCooldownHours`
2. PnL Lock / trailing stop — activates at `trailingStopPct` of TP, moves to breakeven, then trails by the same step
3. Stop Loss (fixed dollar limit order)
4. Take Profit (fixed dollar limit order)
5. Forced contract close — after `contractDurationMins`, regardless of P&L

**Known gap**: production's Daily Bias Reversal exit (closing early if the D1 bias flips against an open position) is NOT simulated here yet — positions in the backtest only close via the 5 rules above.

## Things to know about how the simulation works
- **No lookahead**: at each simulated M15 bar, the engine only exposes D1/H1/M15 data that would actually have been "closed" by that point in time.
- **Date mocking**: `signals.js` decides "is this a new trading day" and "are we in the London/NY session" using real `new Date()`. Looping it over history naively would freeze Stage 1 after the very first call. `engine.js` works around this with a scoped fake-clock wrapper — `signals.js` itself isn't modified.
- **Same-bar SL/TP conflict**: if a bar's range could have hit both stop-loss and take-profit, the engine assumes SL hit first (conservative, avoids overstating results).
- **Exit checking is at M15 resolution**, not tick-level — fine for swing-style SL/TP distances, less precise for very tight stops.
- **One position at a time per symbol** (mirrors the live trade-lock behavior). Multi-symbol portfolio-level concurrency isn't modeled — each symbol's stats are independent, and `--equity` is the starting capital for EACH symbol individually, not a shared pool.

## Bugs found and fixed while building this (in `src/risk/risk-manager.js`)
1. **`calculateStake()` was using `riskPct` as a raw multiplier** (`balance * riskPct`) instead of a percentage (`balance * riskPct/100`). With the default `riskPct=10`, that computed `balance × 10`, which immediately clamped to the `$1000` hard cap regardless of account size. **Fixed**: now divides by 100. Scope check: this only affects **standalone bot mode** (`npm run bot` → `src/index.js`) — dashboard-managed bots use a fixed `stakeAmount` field and never call this method, so they were unaffected.
2. **`maxDailyLossPct` defaulted to `30`** but is compared against a 0–1 ratio, so the circuit breaker could never trip in standalone mode. **Fixed**: default changed to `0.30`.

## Files
- `engine.js` — the simulator (`runBacktest()`)
- `generate-sample-data.js` — synthetic OHLC generator for dry runs
- `fetch-history.js` — real Deriv historical data puller, one symbol
- `fetch-all-history.js` — same, but loops every symbol automatically
- `run.js` — CLI: load data → run backtest → print report → write trade CSV, one symbol
- `run-all.js` — same, but across every symbol with a combined summary
- `my-risk-settings.example.js` — template; copy to `my-risk-settings.js` (gitignored) with your real values
- `data/` — fetched/generated candle JSON per symbol (gitignored — these get large)
- `results/` — output trade-log CSVs
