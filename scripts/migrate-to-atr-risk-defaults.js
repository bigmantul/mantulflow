// ═══════════════════════════════════════════════════════
//  scripts/migrate-to-atr-risk-defaults.js
//
//  ONE-TIME migration. Schema defaults in dashboard/db.js only apply
//  to brand-new user documents — existing users (created before this
//  change) already have noProfitCutoffMins:20, contractDurationMins:120,
//  trailingStopPct:0.5 saved in Mongo, and the schema change alone won't
//  touch those saved values. This script updates existing users to the
//  validated new defaults. slAtrMult/tpAtrMult are NOT set here on
//  purpose — bot-manager.js already falls back to 0.75/1.5 in code for
//  any user missing them, so this only touches the three fields whose
//  OLD values would otherwise silently stick around.
//
//  Run once from the project root:  node scripts/migrate-to-atr-risk-defaults.js
//  Safe to run more than once (idempotent — just re-sets the same values).
// ═══════════════════════════════════════════════════════
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB, User } from "../dashboard/db.js";

async function main() {
  await connectDB();

  const result = await User.updateMany({}, {
    $set: {
      "risk.trailingStopPct":      0.20,
      "risk.noProfitCutoffMins":   0,
      "risk.contractDurationMins": 0,
    },
  });

  console.log(`Matched ${result.matchedCount} user(s), modified ${result.modifiedCount}.`);
  console.log("New live exits: ATR-calibrated SL/TP (0.75x/1.5x ATR) + 20% PnL-lock trailing.");
  console.log("No-profit cutoff and forced-close timer are now OFF for every existing user.");
  console.log("If you want any user to keep the old cutoff/duration behavior, update that user's");
  console.log("risk settings back through the dashboard after this runs.");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
