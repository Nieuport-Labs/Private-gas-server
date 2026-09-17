// Smoke test for step 2 of the plan: confirm secretjs can (a) talk to the local devnet,
// (b) sign a SNIP-24 permit for a wallet that never held a single uscrt, and (c) use that
// permit to read the wallet's private sSCRT balance — the exact mechanism the onboarding
// endpoint needs so the server can check sufficiency before quoting a transaction.
//
// Uses the "fresh" key created during step 0 manual verification (mnemonic captured then;
// it never received native SCRT, only a fee grant and a snip20-reference-impl balance).
import { SecretNetworkClient, Wallet } from "secretjs";

const LCD = "http://localhost:1317";
const RPC = "http://localhost:26657";
const CHAIN_ID = "secretdev-1";
const CONTRACT = "secret18wy2w4rzg9xxsm2ru8jq8tdq053h39epxvd4rl";
const CODE_HASH_PROMPT = true; // resolved via query below

const FRESH_MNEMONIC =
  "scheme assume rocket adjust kick notable pumpkin crouch muscle village match poet dynamic adapt keen glove sister dumb lend drill sketch among surround never";

async function main() {
  const wallet = new Wallet(FRESH_MNEMONIC);
  const address = wallet.address;
  console.log("fresh address:", address);

  const client = new SecretNetworkClient({
    url: LCD,
    chainId: CHAIN_ID,
    wallet,
    walletAddress: address,
  });

  // Resolve code hash so the client can encrypt the query without a manual lookup step.
  const codeHashResp = await client.query.compute.codeHashByContractAddress({
    contract_address: CONTRACT,
  });
  const codeHash = codeHashResp.code_hash!;
  console.log("code hash:", codeHash);

  // Sanity check: this address must have NO x/auth account balance in uscrt, only sSCRT.
  const bankBalance = await client.query.bank.balance({
    address,
    denom: "uscrt",
  });
  console.log("native uscrt balance (expect 0/undefined):", bankBalance.balance?.amount ?? "0");

  // Sign a SNIP-24 permit scoped to "balance" only — offline, no gas, revocable. This is
  // exactly what the onboarding endpoint asks the user for in Keplr, once.
  const permit = await client.utils.accessControl.permit.sign(
    address,
    CHAIN_ID,
    "provider-devnet-smoke-test",
    [CONTRACT],
    ["balance"],
    false, // not signing via Keplr here, plain secp256k1 wallet
  );
  console.log("permit signed:", JSON.stringify(permit, null, 2));

  // Query balance using the permit — no viewing key involved at all.
  const result: any = await client.query.compute.queryContract({
    contract_address: CONTRACT,
    code_hash: codeHash,
    query: {
      with_permit: {
        permit,
        query: { balance: {} },
      },
    },
  });
  console.log("balance via permit:", JSON.stringify(result));

  if (!result?.balance?.amount) {
    throw new Error("permit query did not return a balance — smoke test FAILED");
  }
  console.log(`OK: permit-based balance read succeeded, amount=${result.balance.amount}`);
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
