// Measures the real gas cost of the SNIP-20 payment message by sending it for real and
// reading gas_used back — never by simulate, which can't handle MsgExecuteContract at all.
//
// Run this periodically (cron / before first use), not once at setup and never again: the
// exact figure drifts with contract storage state (a shrinking balance's decimal string gets
// shorter to write, same effect the earlier chain-level phase measured), and a stale
// under-quote produces real out-of-gas failures in production, not just an inaccurate quote.
//
// Usage: tsx src/scripts/calibrate-payment-gas.ts [sampleCount]
import { Wallet, SecretNetworkClient } from "secretjs";
import { buildPaymentMessage, recordPaymentGasCalibration } from "../payment.js";
import { getSscrtCodeHash, providerAddress } from "../chain.js";
import { config } from "../config.js";

// Genesis key "a" — has both native SCRT (pays its own gas here, no feegrant needed for a
// maintenance/calibration run) and plenty of wrapped sSCRT from the devnet setup.
const CALIBRATION_MNEMONIC =
  "grant rice replace explain federal release fix clever romance raise often wild taxi quarter soccer fiber love must tape steak together observe swap guitar";

async function main() {
  const n = Number(process.argv[2] ?? 10);
  const wallet = new Wallet(CALIBRATION_MNEMONIC);
  const client = new SecretNetworkClient({
    url: config.lcdUrl,
    chainId: config.chainId,
    wallet,
    walletAddress: wallet.address,
  });

  const codeHash = await getSscrtCodeHash();
  const samples: number[] = [];

  for (let i = 0; i < n; i++) {
    // Amount varies slightly (1 + i) so the message isn't byte-identical across samples —
    // matches how it'll actually be used (a real quoted fee amount each time), and avoids
    // measuring a mempool/cache artifact instead of real execution cost.
    const msg = buildPaymentMessage(wallet.address, String(1000 + i), codeHash);
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
