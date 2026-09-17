// End-to-end smoke test for the full quote -> sign -> submit loop: a brand-new address is
// onboarded, funded with a little sSCRT and uscrt (same setup as smoke-quote.ts), gets a
// quote, and then — standing in for "the client's own secretjs+Keplr wallet" — signs a
// transaction against the EXACT quoted parameters (sequence, gas limit, fee, granter) and
// hands the resulting bytes to submitQuote(). The server never sees this wallet's key for
// anything except this one local test convenience; in production that signing step happens
// entirely in the client's browser.
import { MsgSend, MsgExecuteContract, SecretNetworkClient, Wallet } from "secretjs";
import { requestQuote } from "../quote.js";
import { submitQuote } from "../submit.js";
import { onboardUser } from "../onboarding.js";
import { config } from "../config.js";
import { getSscrtCodeHash, providerAddress, providerClient } from "../chain.js";

const RECIPIENT = "secret1ap26qrlp8mcq2pg6r47w43l0y8zkqm8a450s03";

async function main() {
  const wallet = new Wallet();
  const address = wallet.address;
  console.log("brand-new address:", address);

  const userClient = new SecretNetworkClient({
    url: config.lcdUrl,
    chainId: config.chainId,
    wallet,
    walletAddress: address,
  });
  const permit = await userClient.utils.accessControl.permit.sign(
    address,
    config.chainId,
    "submit-smoke-test",
    [config.sscrtContract],
    ["balance"],
    false,
  );
  await onboardUser(address, permit);

  const accountData = (await wallet.getAccounts())[0];
  const pubkeyBase64 = Buffer.from(accountData.pubkey).toString("base64");

  const codeHash = await getSscrtCodeHash();
  const fundMsg = new MsgExecuteContract({
    sender: providerAddress,
    contract_address: config.sscrtContract,
    code_hash: codeHash,
    msg: { transfer: { recipient: address, amount: "1000000" } },
  });
  await providerClient.tx.broadcast([fundMsg], { gasLimit: 200_000, gasPriceInFeeDenom: 0.25 });
  await providerClient.tx.bank.send(
    { from_address: providerAddress, to_address: address, amount: [{ denom: "uscrt", amount: "10" }] },
    { gasLimit: 100_000, gasPriceInFeeDenom: 0.25 },
  );
  console.log("funded with sSCRT + a little uscrt");

  const providerSscrtBefore = await providerBalance(codeHash);
  console.log("provider sSCRT balance before:", providerSscrtBefore);

  const nativeMsg = new MsgSend({
    from_address: address,
    to_address: RECIPIENT,
    amount: [{ denom: "uscrt", amount: "1" }],
  });

  const quote = await requestQuote({ address, messages: [nativeMsg], pubkeyBase64 });
  console.log("quote issued:", quote.quoteId, "gasLimit:", quote.gasLimit, "sSCRT payment:", quote.sscrtPaymentAmount);

  // Stand-in for "the client's wallet signs the quoted transaction". Reconstructing the
  // payment message here independently (not by parsing the quote's amino JSON back into a
  // Msg) is fine for this test: it proves the same logical transaction — same recipient,
  // same amount — round-trips correctly, which is what /submit's re-checks care about, not
  // byte-identical ciphertext.
  const paymentMsg = new MsgExecuteContract({
    sender: address,
    contract_address: config.sscrtContract,
    code_hash: codeHash,
    msg: { transfer: { recipient: providerAddress, amount: quote.sscrtPaymentAmount } },
  });

  const signedBytes = await userClient.tx.signTx([nativeMsg, paymentMsg], {
    gasLimit: quote.gasLimit,
    feeDenom: "uscrt",
    feeGranter: providerAddress,
    explicitSignerData: {
      accountNumber: quote.accountNumber,
      sequence: quote.sequence,
      chainId: config.chainId,
    },
  });
  console.log("client-side signing done, bytes length:", signedBytes.length);

  const result = await submitQuote(quote.quoteId, signedBytes);
  console.log("submit result:", result);

  if (result.code !== 0) throw new Error(`FAILED: tx landed with non-zero code ${result.code}: ${result.rawLog}`);

  const providerSscrtAfter = await providerBalance(codeHash);
  console.log("provider sSCRT balance after:", providerSscrtAfter);
  const delta = BigInt(providerSscrtAfter) - BigInt(providerSscrtBefore);
  if (delta !== BigInt(quote.sscrtPaymentAmount)) {
    throw new Error(`FAILED: provider received ${delta}, expected exactly ${quote.sscrtPaymentAmount}`);
  }

  console.log(`OK: full quote -> sign -> submit loop passed. Provider received exactly ${delta} sSCRT.`);

  async function providerBalance(codeHash: string): Promise<string> {
    const permit = await providerClient.utils.accessControl.permit.sign(
      providerAddress,
      config.chainId,
      "smoke-test-provider-balance-check",
      [config.sscrtContract],
      ["balance"],
      false,
    );
    const r: any = await providerClient.query.compute.queryContract({
      contract_address: config.sscrtContract,
      code_hash: codeHash,
      query: { with_permit: { permit, query: { balance: {} } } },
    });
    return r.balance.amount;
  }
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
