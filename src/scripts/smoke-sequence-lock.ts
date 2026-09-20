// Regression test the plan calls for explicitly: a quote must be refused at /submit — without
// broadcasting, without spending the grant — if the account's sequence advanced after the
// quote was issued. This is the mechanism the whole design leans on to rule out a race
// draining funds between quote-time and submit-time (see plan Context).
import { MsgSend, MsgExecuteContract, SecretNetworkClient, Wallet } from "secretjs";
import { requestPurchaseQuote } from "../quote.js";
import { submitQuote, SubmitError } from "../submit.js";
import { onboardUser } from "../onboarding.js";
import { config } from "../config.js";
import { getSscrtCodeHash, getProviderAddress, getProviderClient } from "../chain.js";
import { getSettings } from "../settings.js";
import { quotedMessages } from "./quotedSigning.js";

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
    "seqlock-smoke-test",
    [config.sscrtContract],
    ["balance"],
    false,
  );
  await onboardUser(address, permit);

  const codeHash = await getSscrtCodeHash();
  await getProviderClient().tx.broadcast(
    [
      new MsgExecuteContract({
        sender: getProviderAddress(),
        contract_address: config.sscrtContract,
        code_hash: codeHash,
        msg: { transfer: { recipient: address, amount: (BigInt(getSettings().creditPurchaseUscrt) * 2n).toString() } },
      }),
    ],
    { gasLimit: 200_000, gasPriceInFeeDenom: 0.25 },
  );
  // Enough to pay for its own "advance the sequence" transaction below at 100_000 gas *
  // 0.25uscrt/gas = 25_000uscrt, plus a small margin.
  await getProviderClient().tx.bank.send(
    { from_address: getProviderAddress(), to_address: address, amount: [{ denom: "uscrt", amount: "30000" }] },
    { gasLimit: 100_000, gasPriceInFeeDenom: 0.25 },
  );

  const pubkeyBase64 = Buffer.from((await wallet.getAccounts())[0].pubkey).toString("base64");

  const quote = await requestPurchaseQuote({ address, pubkeyBase64 });
  console.log("quote issued at sequence", quote.sequence);

  // Advance the account's own sequence with an ordinary, unrelated transaction — exactly the
  // race the design has to survive: something else touches this account between quote and
  // submit. Paid natively by the user's own uscrt top-up, standing in for "any other
  // transaction from this signer, sponsored or not."
  const advanceTx = await userClient.tx.bank.send(
    { from_address: address, to_address: RECIPIENT, amount: [{ denom: "uscrt", amount: "1" }] },
    { gasLimit: 100_000, gasPriceInFeeDenom: 0.25 },
  );
  if (advanceTx.code !== 0) throw new Error(`setup step failed: could not advance sequence (${advanceTx.rawLog})`);
  console.log("sequence advanced by an unrelated transaction, code:", advanceTx.code);

  // Sign against the NOW-STALE quote parameters (as if the client had been sitting on it) and
  // submit — this must be rejected before any broadcast happens. The quoted bytes are signed as
  // they are: rebuilding the message would fail byte-equality first and the test would pass for
  // the wrong reason.
  const staleSignedBytes = await userClient.tx.signTx(quotedMessages(quote), {
    gasLimit: quote.gasLimit,
    gasPriceInFeeDenom: Number(quote.feeAmountUscrt) / quote.gasLimit,
    feeDenom: "uscrt",
    feeGranter: quote.feeGranter,
    explicitSignerData: { accountNumber: quote.accountNumber, sequence: quote.sequence, chainId: config.chainId },
  });

  try {
    await submitQuote(quote.quoteId, staleSignedBytes);
    throw new Error("FAILED: submitQuote should have rejected a stale-sequence quote, but it did not");
  } catch (err) {
    if (err instanceof SubmitError && err.code === "sequence_changed") {
      console.log(`OK: stale quote correctly rejected before broadcast — ${err.message}`);
    } else {
      throw err;
    }
  }
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
