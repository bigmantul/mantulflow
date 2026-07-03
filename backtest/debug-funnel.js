// ═══════════════════════════════════════════════════════
//  backtest/debug-funnel.js
//
//  Diagnostic tool — NOT a trading backtest. Walks the same
//  historical bars the same way engine.js does (incremental
//  growing arrays, fake wall-clock time, placeholder trick)
//  but instead of opening/closing trades, it just tallies
//  how many times each Stage of collectSignals() reaches
//  each outcome. Use this to find out WHERE the funnel dies
//  to zero — Stage 1 (no bias ever set), Stage 2 (1H never
//  confirms), or Stage 3 (3-consecutive 15M pattern never
//  found) — instead of guessing.
//
//  Usage:
//    node backtest/debug-funnel.js <SYMBOL> [--minStartIndex=100]
//
//  Reads backtest/data/<SYMBOL>.json (same file run.js uses).
// ═══════════════════════════════════════════════════════

import fs from "fs";
import { collectSignals, resetSymbolState } from "../src/strategy/signals.js";

function parseArgs(argv) {
  const symbol = argv[2];
  const opts = { minStartIndex: 100 };
  for (const arg of argv.slice(3)) {
    const m = arg.match(/^--([\w]+)=(.+)$/);
    if (m) opts[m[1]] = isNaN(Number(m[2])) ? m[2] : Number(m[2]);
  }
  return { symbol, opts };
}

const { symbol, opts } = parseArgs(process.argv);
if (!symbol) {
  console.error("Usage: node backtest/debug-funnel.js <SYMBOL> [--minStartIndex=100]");
  process.exit(1);
}

const dataPath = `backtest/data/${symbol}.json`;
if (!fs.existsSync(dataPath)) {
  console.error(`No data file at ${dataPath}.`);
  process.exit(1);
}

const { d1, h1, m15 } = JSON.parse(fs.readFileSync(dataPath, "utf8"));
const minStartIndex = opts.minStartIndex;

if (!m15 || m15.length < minStartIndex + 5) {
  console.error(`Not enough M15 data for ${symbol} (need > ${minStartIndex + 5} bars, got ${m15?.length ?? 0})`);
  process.exit(1);
}

// ── Same fake-Date + placeholder machinery as engine.js ──
const _clockBox = { ms: Date.now() };
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) return new RealDate(_clockBox.ms);
    return new RealDate(...args);
  }
  static now() { return _clockBox.ms; }
}
function withFakeNow(simulatedMs, fn) {
  _clockBox.ms = simulatedMs;
  globalThis.Date = FakeDate;
  try { return fn(); } finally { globalThis.Date = RealDate; }
}

function makeClosedCounter(arr) {
  let i = 0;
  return function countClosed(targetEpoch) {
    while (i < arr.length && arr[i].epoch <= targetEpoch) i++;
    return i;
  };
}

function pushPlaceholder(arr) {
  if (arr.length === 0) return null;
  const last = arr[arr.length - 1];
  const placeholder = { ...last, epoch: last.epoch + 1, open: last.close, high: last.close, low: last.close, close: last.close };
  arr.push(placeholder);
  return placeholder;
}

// ── Local copy of validateDailyCandle, for DIAGNOSTIC comparison
//    only (signals.js doesn't export it). Keep in sync manually
//    if the shape rule in signals.js ever changes.
function candleRange(c) { return c.high - c.low; }
function validateDailyCandleLocal(candle) {
  const body = candle.close - candle.open;
  const range = candleRange(candle);
  if (range === 0 || body === 0) return { valid: false, direction: null };
  if (body > 0) {
    const upperWick = candle.high - candle.close;
    return { valid: body > upperWick, direction: "bullish" };
  }
  const lowerWick = candle.close - candle.low;
  return { valid: -body > lowerWick, direction: "bearish" };
}

resetSymbolState(symbol);

const d1Counter = makeClosedCounter(d1);
const h1Counter = makeClosedCounter(h1);

const growingD1 = [];
const growingH1 = [];
const growingM15 = [];
let d1Pushed = 0;
let h1Pushed = 0;

// ── Tally counters ──
const stage1 = { BULLISH: 0, BEARISH: 0, NONE: 0 };
const stage2 = { "ENTRY MODE": 0, "ENTRY MODE (active)": 0, WAITING: 0, "OUTSIDE SESSION": 0 };
const stage3 = { BUY: 0, SELL: 0, WAIT: 0 };
let entryModeGrantedCount = 0; // how many times Stage2 flipped false->true (new H1 confirmations)
let stage3EvaluatedCount = 0;  // how many bars actually reached Stage3 (i.e. entry mode was active)
const sampleReasons = { stage2Wait: null, stage3Wait: null };
let barsProcessed = 0;

// ── Rule comparison counters (computed independently of collectSignals,
//    by reading the same last-closed H1 candle + yesterday's D1 level,
//    ONLY when Stage1 has a bias and we're in-session — i.e. only counting
//    the same evaluations Stage2 actually got a chance to run on) ──
let closeOnlyBeyond = 0;       // OLD rule: close beyond level, matching direction (ignores shape)
let closeOnlyBeyondValidShape = 0; // OLD rule + shape check (closest to what pre-reset Stage2 required)
let openAndCloseBeyond = 0;    // NEW rule: open AND close both beyond level (ignores shape)
let openAndCloseBeyondValidShape = 0; // NEW rule + shape (exactly what current Stage2 requires)

for (let i = minStartIndex; i < m15.length; i++) {
  const bar = m15[i];

  withFakeNow(bar.epoch * 1000, () => {
    const targetD1Count = d1Counter(bar.epoch);
    while (d1Pushed < targetD1Count) growingD1.push(d1[d1Pushed++]);
    const targetH1Count = h1Counter(bar.epoch);
    while (h1Pushed < targetH1Count) growingH1.push(h1[h1Pushed++]);
    growingM15.push(bar);

    if (growingD1.length < 4 || growingH1.length < 20) return;

    pushPlaceholder(growingD1);
    pushPlaceholder(growingH1);
    pushPlaceholder(growingM15);

    let result;
    try {
      result = collectSignals({ d1: growingD1, h1: growingH1, m15: growingM15, symbol });
    } finally {
      growingD1.pop();
      growingH1.pop();
      growingM15.pop();
    }
    barsProcessed++;

    // ── Rule comparison (independent of entryMode gating) ──
    const bias = result.dailyBias;
    if ((bias === "bullish" || bias === "bearish") && growingH1.length >= 1 && growingD1.length >= 1) {
      const lastH1 = growingH1[growingH1.length - 1];
      const yestD1 = growingD1[growingD1.length - 1];
      const level = bias === "bullish" ? yestD1.high : yestD1.low;
      const shape = validateDailyCandleLocal(lastH1);
      const shapeOk = shape.valid && shape.direction === bias;

      const closeBeyond = bias === "bullish" ? lastH1.close > level : lastH1.close < level;
      const openBeyond  = bias === "bullish" ? lastH1.open  > level : lastH1.open  < level;

      if (closeBeyond) {
        closeOnlyBeyond++;
        if (shapeOk) closeOnlyBeyondValidShape++;
      }
      if (closeBeyond && openBeyond) {
        openAndCloseBeyond++;
        if (shapeOk) openAndCloseBeyondValidShape++;
      }
    }

    for (const step of result.breakdown) {
      if (step.step === "Stage1 DailyBias") {
        if (stage1[step.result] !== undefined) stage1[step.result]++;
      }
      if (step.step === "Stage2 1H Confirm") {
        if (stage2[step.result] !== undefined) stage2[step.result]++;
        if (step.result === "ENTRY MODE") {
          entryModeGrantedCount++;
        }
        if (step.result === "WAITING" && !sampleReasons.stage2Wait) {
          sampleReasons.stage2Wait = step.reason;
        }
      }
      if (step.step === "Stage3 15M Entry") {
        stage3EvaluatedCount++;
        if (stage3[step.result] !== undefined) stage3[step.result]++;
        if (step.result === "WAIT" && !sampleReasons.stage3Wait) {
          sampleReasons.stage3Wait = step.reason;
        }
      }
    }
  });
}

console.log(`\n════════════════════════════════════════════════`);
console.log(`  FUNNEL DIAGNOSTIC — ${symbol}`);
console.log(`════════════════════════════════════════════════`);
console.log(`  Bars processed (post-warmup): ${barsProcessed} / ${m15.length}`);
console.log(`  D1 bars: ${d1.length}   H1 bars: ${h1.length}   M15 bars: ${m15.length}`);
console.log(`  ────────────────────────────────────────`);
console.log(`  STAGE 1 — Daily Bias (per-bar readings, same bias repeats all day):`);
console.log(`    BULLISH: ${stage1.BULLISH}   BEARISH: ${stage1.BEARISH}   NONE: ${stage1.NONE}`);
console.log(`  ────────────────────────────────────────`);
console.log(`  STAGE 2 — 1H Confirm:`);
console.log(`    ENTRY MODE (newly granted this bar): ${stage2["ENTRY MODE"]}`);
console.log(`    ENTRY MODE (active, already granted):  ${stage2["ENTRY MODE (active)"]}`);
console.log(`    WAITING (bias set, not yet confirmed): ${stage2.WAITING}`);
console.log(`    OUTSIDE SESSION (FX/Metals only):      ${stage2["OUTSIDE SESSION"]}`);
console.log(`    -> Distinct H1 confirmations over ${(m15.length/96/365).toFixed(1)} yrs: ${entryModeGrantedCount}`);
if (sampleReasons.stage2Wait) console.log(`    Sample WAITING reason: "${sampleReasons.stage2Wait}"`);
console.log(`  ────────────────────────────────────────`);
console.log(`  STAGE 3 — 15M Entry (only evaluated while Entry Mode active):`);
console.log(`    Bars where Stage3 ran at all: ${stage3EvaluatedCount}`);
console.log(`    BUY: ${stage3.BUY}   SELL: ${stage3.SELL}   WAIT: ${stage3.WAIT}`);
if (sampleReasons.stage3Wait) console.log(`    Sample WAIT reason: "${sampleReasons.stage3Wait}"`);
console.log(`  ────────────────────────────────────────`);
console.log(`  RULE COMPARISON (same bars, bias set + in-session):`);
console.log(`    OLD rule — close beyond level:             ${closeOnlyBeyond}`);
console.log(`    OLD rule — close beyond + valid shape:      ${closeOnlyBeyondValidShape}`);
console.log(`    NEW rule — open+close beyond level:         ${openAndCloseBeyond}`);
console.log(`    NEW rule — open+close beyond + valid shape: ${openAndCloseBeyondValidShape}  <- current Stage2 requirement`);
console.log(`════════════════════════════════════════════════\n`);
