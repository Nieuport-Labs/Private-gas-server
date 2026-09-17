// Measures the real gas cost of calling a whitelisted contract, the same way
// calibrate-payment-gas.ts does for the payment message: real signed+broadcast transactions,
// reading gas_used back — simulate can't handle MsgExecuteContract at all (see
// gasEstimation.ts). Required before quote.ts will price any action targeting that contract
// (config.allowedContractAddresses) — it refuses to quote rather than guess.
//
// Whole-contract calibration, not per-entry-point: the recorded constant must cover the most
// expensive call the operator intends to sponsor on this contract, so pass a *sample message
// shaped like the priciest allowed call* (e.g. the actual swap call, not a cheap query-adjacent
// one), not just whatever's convenient to construct.
//
// Usage: tsx src/scripts/calibrate-contract-gas.ts <contractAddress> <execMsgJson> [sampleCount]
// Example: tsx src/scripts/calibrate-contract-gas.ts secret1abc...
//   '{"increase_allowance":{"spender":"secret1...","amount":"1000"}}' 10
import { MsgExecuteContract, SecretNetworkClient, Wallet } from "secretjs";
import { config } from "../config.js";
import { recordGasCalibration } from "../gasCalibration.js";

async function main() {
  const contractAddress = process.argv[2];
  const execMsgJson = process.argv[3];
  const n = Number(process.argv[4] ?? 10);
  if (!contractAddress || !execMsgJson) {
    throw new Error("usage: calibrate-contract-gas.ts <contractAddress> <execMsgJson> [sampleCount]");
  }
  const execMsg = JSON.parse(execMsgJson);

  // Runs as the provider's own account — same convention as calibrate-payment-gas.ts. Whatever
  // this call needs to succeed (token balance, allowance, pool membership, ...) has to already
  // be true for the provider's own address; calibration measures a call that actually executes,
  // not one that fails fast.
  const wallet = new Wallet(config.providerMnemonic);
  const client = new SecretNetworkClient({ url: config.lcdUrl, chainId: config.chainId, wallet, walletAddress: wallet.address });

  const codeHashResp = await client.query.compute.codeHashByContractAddress({ contract_address: contractAddress });
  const codeHash = codeHashResp.code_hash;
  if (!codeHash) throw new Error(`could not resolve code hash for ${contractAddress}`);

  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const msg = new MsgExecuteContract({
      sender: wallet.address,
      contract_address: contractAddress,
      code_hash: codeHash,
      msg: execMsg,
    });
    const tx = await client.tx.broadcast([msg], { gasLimit: 300_000, gasPriceInFeeDenom: config.nativeGasPriceUscrt });
    if (tx.code !== 0) {
      console.error(`sample ${i} failed (code ${tx.code}): ${tx.rawLog}`);
      continue;
    }
    console.log(`sample ${i}: gas_used=${tx.gasUsed}`);
    samples.push(Number(tx.gasUsed));
  }

  if (samples.length === 0) throw new Error("no successful samples — calibration failed");

  const constant = recordGasCalibration(contractAddress, samples);
  console.log(`\nrecorded calibration for ${contractAddress}: constant=${constant} from ${samples.length} samples`);
  console.log(`min=${Math.min(...samples)} max=${Math.max(...samples)} avg=${(samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(0)}`);
}

main().catch((err) => {
  console.error("CALIBRATION FAILED:", err);
  process.exit(1);
});
