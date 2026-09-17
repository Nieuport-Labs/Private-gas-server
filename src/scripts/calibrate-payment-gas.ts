// Measures the real gas cost of the SNIP-20 payment message by sending it for real and
// reading gas_used back — never by simulate, which can't handle MsgExecuteContract at all.
//
// Run this periodically (cron / before first use), not once at setup and never again: the
// exact figure drifts with contract storage state (a shrinking balance's decimal string gets
// shorter to write, same effect the earlier chain-level phase measured), and a stale
// under-quote produces real out-of-gas failures in production, not just an inaccurate quote.
//
// Usage: tsx src/scripts/calibrate-payment-gas.ts [sampleCount]
import { buildPaymentMessage, recordPaymentGasCalibration } from "../payment.js";
import { getSscrtCodeHash, providerAddress, providerClient } from "../chain.js";
import { config } from "../config.js";

async function main() {
  const n = Number(process.argv[2] ?? 10);
  // Measured from the provider's own wallet: it is the one account guaranteed to hold both the
  // native SCRT to pay for these samples and the sSCRT to move in them, on any deployment. The
  // samples are self-transfers (provider -> provider), which the SNIP-20 contract charges the
  // same way as a user's payment — same message shape, same balance writes, same history entry.
  const client = providerClient;

  const codeHash = await getSscrtCodeHash();
  const samples: number[] = [];

  for (let i = 0; i < n; i++) {
    // Amount varies slightly (1 + i) so the message isn't byte-identical across samples —
    // matches how it'll actually be used (a real quoted fee amount each time), and avoids
    // measuring a mempool/cache artifact instead of real execution cost.
    const msg = buildPaymentMessage(providerAddress, String(1000 + i), codeHash);
    const tx = await client.tx.broadcast([msg], { gasLimit: 200_000, gasPriceInFeeDenom: config.nativeGasPriceUscrt });
    if (tx.code !== 0) {
      console.error(`sample ${i} failed (code ${tx.code}): ${tx.rawLog}`);
      continue;
    }
    console.log(`sample ${i}: gas_used=${tx.gasUsed}`);
    samples.push(Number(tx.gasUsed));
  }

  if (samples.length === 0) throw new Error("no successful samples — calibration failed");

  const constant = recordPaymentGasCalibration(samples);
  console.log(`\nrecorded calibration: constant=${constant} from ${samples.length} samples`);
  console.log(`min=${Math.min(...samples)} max=${Math.max(...samples)} avg=${(samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(0)}`);
}

main().catch((err) => {
  console.error("CALIBRATION FAILED:", err);
  process.exit(1);
});
