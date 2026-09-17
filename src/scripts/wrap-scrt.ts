// Wraps native SCRT into sSCRT from the provider's own wallet (SNIP-20 `deposit`).
// The dashboard has a button for this; the logic lives in maintenance.ts so both agree.
//
// Usage: tsx src/scripts/wrap-scrt.ts <amountUscrt>
import { wrapScrt } from "../maintenance.js";

const amount = process.argv[2];
if (!amount) {
  console.error("usage: tsx src/scripts/wrap-scrt.ts <amountUscrt>   (e.g. 2000000 = 2 SCRT)");
  process.exit(1);
}

wrapScrt(amount, (m) => console.log(m)).catch((err) => {
  console.error("WRAP FAILED:", err.message ?? err);
  process.exit(1);
});
