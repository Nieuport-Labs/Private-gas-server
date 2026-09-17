// Measures the real gas cost of the SNIP-20 payment message by sending it for real and reading
// gas_used back — never by simulate, which can't handle MsgExecuteContract at all.
//
// Run this periodically, not once at setup and never again: the figure drifts with contract
// storage state, and a stale under-quote produces real out-of-gas failures in production.
// The dashboard has a button for this; the logic lives in maintenance.ts so both agree.
//
// Usage: tsx src/scripts/calibrate-payment-gas.ts [sampleCount]
import { calibratePaymentGas } from "../maintenance.js";

const n = Number(process.argv[2] ?? 10);

calibratePaymentGas(n, (m) => console.log(m))
  .then((r) => console.log(`min=${r.min} max=${r.max} avg=${r.avg}`))
  .catch((err) => {
    console.error("CALIBRATION FAILED:", err.message ?? err);
    process.exit(1);
  });
