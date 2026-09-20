// The cold start, end to end: an address that has never held SCRT buys gas credits with sSCRT.
//
// This is the only path the provider is involved in, so it is the one that has to work. It
// replaces the old smoke-quote/smoke-submit pair, which quoted a bundle of [user action,
// payment] -- a shape that no longer exists.
//
// Verified by measurement, not by `code: 0`: the provider's sSCRT balance has to rise by exactly
// what was quoted, and the buyer's allowance at the vault has to rise by exactly what was bought.
import { MsgExecuteContract, SecretNetworkClient, Wallet } from "secretjs";
import { requestPurchaseQuote } from "../quote.js";
import { submitQuote } from "../submit.js";
import { onboardUser, getStoredPermit } from "../onboarding.js";
import { config } from "../config.js";
import { getSscrtCodeHash, getProviderAddress, getProviderClient } from "../chain.js";
import { queryRemaining } from "../gasVault.js";
import { getSettings } from "../settings.js";
import { quotedMessages } from "./quotedSigning.js";

async function main() {
  if (!getSettings().gasVaultAddress) {
    throw new Error("no gas vault configured — set GAS_VAULT_ADDRESS, or the vault address in Settings");
  }

  const wallet = new Wallet();
  const address = wallet.address;
  console.log("brand-new address:", address);

  const userClient = new SecretNetworkClient({
    url: config.lcdUrl,
    chainId: config.chainId,
    wallet,
    walletAddress: address,
  });

  const codeHash = await getSscrtCodeHash();

  // Fund it with sSCRT and nothing else. No uscrt at all: holding native SCRT would let it pay
  // its own way and quietly turn this into a different test.
  const fundAmount = (BigInt(getSettings().creditPurchaseUscrt) * 2n).toString();
  await getProviderClient().tx.broadcast(
    [
      new MsgExecuteContract({
        sender: getProviderAddress(),
        contract_address: config.sscrtContract,
        code_hash: codeHash,
        msg: { transfer: { recipient: address, amount: fundAmount } },
      }),
    ],
    { gasLimit: 200_000, gasPriceInFeeDenom: config.nativeGasPriceUscrt },
  );
  console.log(`funded with ${fundAmount} sSCRT and zero native SCRT`);

  const permit = await userClient.utils.accessControl.permit.sign(
    address,
    config.chainId,
    "cold-start-smoke-test",
    [config.sscrtContract],
    ["balance"],
    false,
  );
  const onboarded = await onboardUser(address, permit);
  console.log("onboarded:", onboarded);

  const providerSscrtBefore = await providerSscrtBalance(codeHash);
  const creditsBefore = await queryRemaining(address);
  console.log("provider sSCRT before:", providerSscrtBefore, "| buyer credits before:", creditsBefore);

  const pubkeyBase64 = Buffer.from((await wallet.getAccounts())[0].pubkey).toString("base64");
  const quote = await requestPurchaseQuote({ address, pubkeyBase64 });
  console.log(
    `quote ${quote.quoteId}: ${quote.sscrtPaymentAmount} sSCRT for ${quote.creditsUscrt} uscrt of credits`,
  );

  // Stands in for the browser wallet. It signs the server's bytes as they are -- rebuilding the
  // message locally would re-encrypt with a fresh nonce and be rejected, which is the point.
  const signedBytes = await userClient.tx.signTx(quotedMessages(quote), {
    gasLimit: quote.gasLimit,
    gasPriceInFeeDenom: Number(quote.feeAmountUscrt) / quote.gasLimit,
    feeDenom: "uscrt",
    feeGranter: quote.feeGranter,
    explicitSignerData: {
      accountNumber: quote.accountNumber,
      sequence: quote.sequence,
      chainId: config.chainId,
    },
  });

  const result = await submitQuote(quote.quoteId, signedBytes);
  console.log("submit result:", result);
  if (result.code !== 0) throw new Error(`FAILED: tx landed with code ${result.code}: ${result.rawLog}`);
  if (result.delivery !== "delivered") {
    throw new Error(`FAILED: credits were not delivered (state: ${result.delivery})`);
  }

  const providerSscrtAfter = await providerSscrtBalance(codeHash);
  const paid = BigInt(providerSscrtAfter) - BigInt(providerSscrtBefore);
  if (paid !== BigInt(quote.sscrtPaymentAmount)) {
    throw new Error(`FAILED: provider received ${paid}, expected exactly ${quote.sscrtPaymentAmount}`);
  }

  const creditsAfter = await queryRemaining(address);
  if (creditsAfter === null) throw new Error("FAILED: the vault could not report the buyer's allowance");
  const gained = BigInt(creditsAfter) - BigInt(creditsBefore ?? "0");
  if (gained !== BigInt(quote.creditsUscrt)) {
    throw new Error(`FAILED: buyer gained ${gained} of allowance, expected exactly ${quote.creditsUscrt}`);
  }

  // The permit existed to check the buyer could pay. They have paid.
  if (getStoredPermit(address) !== null) {
    throw new Error("FAILED: the balance permit outlived the purchase it was needed for");
  }

  console.log(
    `OK: cold start passed. Provider received exactly ${paid} sSCRT, buyer gained exactly ` +
      `${gained} uscrt of gas credits, and the permit is gone.`,
  );
}

async function providerSscrtBalance(codeHash: string): Promise<string> {
  const permit = await getProviderClient().utils.accessControl.permit.sign(
    getProviderAddress(),
    config.chainId,
    "smoke-test-provider-balance-check",
    [config.sscrtContract],
    ["balance"],
    false,
  );
  const result = (await getProviderClient().query.compute.queryContract({
    contract_address: config.sscrtContract,
    code_hash: codeHash,
    query: { with_permit: { permit, query: { balance: {} } } },
  })) as { balance?: { amount?: string } };
  return result?.balance?.amount ?? "0";
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
