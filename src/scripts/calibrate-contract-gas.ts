// Measures the real gas cost of calling a whitelisted contract, the same way
// calibrate-payment-gas.ts does for the payment message: real signed+broadcast transactions,
// reading gas_used back — simulate can't handle MsgExecuteContract at all (see
// gasEstimation.ts). Required before quote.ts will price any action targeting that contract
// (settings.allowedContractAddresses) — it refuses to quote rather than guess.
//
// Whole-contract calibration, not per-entry-point: the recorded constant must cover the most
// expensive call the operator intends to sponsor on this contract, so pass a *sample message
// shaped like the priciest allowed call* (e.g. the actual swap call, not a cheap query-adjacent
// one), not just whatever's convenient to construct.
//
// The call runs as the provider's own account, so whatever it needs to succeed (token balance,
// allowance, pool membership, …) must already be true for that address — calibration measures a
// call that actually executes, not one that fails fast.
//
// The logic lives in maintenance.ts so this and the dashboard agree, and so that a run survives
// the flaky public endpoints: samples are retried, a sample that stays broken is skipped, and a
// run that collects too few of them fails rather than recording a constant nobody should trust.
//
// Usage: tsx src/scripts/calibrate-contract-gas.ts <contractAddress> <execMsgJson> [sampleCount]
// Example: tsx src/scripts/calibrate-contract-gas.ts secret1abc...
//   '{"increase_allowance":{"spender":"secret1...","amount":"1000"}}' 5
import { calibrateContractGas } from "../maintenance.js";

const contractAddress = process.argv[2];
const execMsgJson = process.argv[3];
const n = Number(process.argv[4] ?? 10);

if (!contractAddress || !execMsgJson) {
  console.error("usage: tsx src/scripts/calibrate-contract-gas.ts <contractAddress> <execMsgJson> [sampleCount]");
  process.exit(1);
}

let execMsg: object;
try {
  execMsg = JSON.parse(execMsgJson);
} catch (err) {
  console.error(`the exec message is not valid JSON: ${(err as Error).message}`);
  process.exit(1);
}

calibrateContractGas(contractAddress, execMsg, n, (m) => console.log(m))
  .then((r) => console.log(`min=${r.min} max=${r.max} avg=${r.avg}`))
  .catch((err) => {
    console.error("CALIBRATION FAILED:", err.message ?? err);
    process.exit(1);
  });
