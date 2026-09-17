// Generic gas-constant store for message shapes that can't be simulated on Secret at all
// (MsgExecuteContract — see gasEstimation.ts's doc comment for why). Two callers share this:
// payment.ts (fixed key "sscrt_payment_transfer", the payment leg every quote includes) and
// quote.ts for whitelisted-contract actions (key = contract address, one constant per contract
// — see the plan's "Rozšíření: whitelist kontraktů" section for why per-contract, not
// per-action: coarser but far simpler to operate than calibrating every entry point).
import { db } from "./db.js";

export function getGasConstant(key: string): number {
  const row = db.prepare(`SELECT gas_constant FROM calibration WHERE key = ?`).get(key) as
    | { gas_constant: number }
    | undefined;
  if (!row) {
    throw new Error(`no gas calibration on record for "${key}" — run the calibration script for it first`);
  }
  return row.gas_constant;
}

export function recordGasCalibration(key: string, samples: number[]): number {
  const max = Math.max(...samples);
  // Round up, same reasoning throughout this project: overestimating costs the user a little
  // headroom, underestimating produces an out-of-gas failure after the fee is already spent.
  const constant = Math.ceil((max * 1.15) / 100) * 100;
  db.prepare(
    `INSERT INTO calibration (key, gas_constant, sample_gas_used) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET gas_constant = excluded.gas_constant,
       measured_at = datetime('now'), sample_gas_used = excluded.sample_gas_used`,
  ).run(key, constant, JSON.stringify(samples));
  return constant;
}
