// Wraps native SCRT into sSCRT from the provider's own wallet (SNIP-20 `deposit`).
//
// Needed once per deployment, before calibrate-payment-gas can run: that script measures a real
// sSCRT transfer, so the provider has to hold some sSCRT to move. In steady state the provider
// accumulates sSCRT from users on its own and autoUnwrap.ts converts it back, so this is a
// bootstrap step, not part of normal operation.
//
// Usage: tsx src/scripts/wrap-scrt.ts <amountUscrt>
import { MsgExecuteContract } from "secretjs";
import { getSscrtCodeHash, getProviderAddress, getProviderClient, getProviderBalances } from "../chain.js";
import { config } from "../config.js";

async function main() {
  const amount = process.argv[2];
  if (!amount || !/^\d+$/.test(amount)) {
    throw new Error("usage: tsx src/scripts/wrap-scrt.ts <amountUscrt>   (e.g. 2000000 = 2 SCRT)");
  }

  const before = await getProviderBalances();
  console.log(`before: ${before.uscrt} uscrt, ${before.sscrt} sSCRT`);

  const codeHash = await getSscrtCodeHash();
  const tx = await getProviderClient().tx.broadcast(
    [
      new MsgExecuteContract({
        sender: getProviderAddress(),
        contract_address: config.sscrtContract,
        code_hash: codeHash,
        msg: { deposit: {} },
        sent_funds: [{ denom: "uscrt", amount }],
      }),
    ],
    { gasLimit: 200_000, gasPriceInFeeDenom: config.nativeGasPriceUscrt },
  );

  if (tx.code !== 0) throw new Error(`deposit failed (code ${tx.code}): ${tx.rawLog}`);
  console.log(`deposit ok: ${tx.transactionHash}`);

  const after = await getProviderBalances();
  console.log(`after:  ${after.uscrt} uscrt, ${after.sscrt} sSCRT`);
}

main().catch((err) => {
  console.error("WRAP FAILED:", err);
  process.exit(1);
});
