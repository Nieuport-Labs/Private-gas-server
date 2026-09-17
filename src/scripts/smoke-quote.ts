// End-to-end smoke test for requestQuote(): a brand-new address is onboarded (grant + permit,
// same as smoke-onboard.ts) and then immediately asks for a quote to send 1 uscrt natively,
// bundled with the sSCRT payment the server computes — before it has ever transacted, and
// before it holds a single uscrt of its own.
import { MsgSend, SecretNetworkClient, Wallet, MsgExecuteContract } from "secretjs";
import { requestQuote } from "../quote.js";
import { onboardUser } from "../onboarding.js";
import { config } from "../config.js";
import { getSscrtCodeHash, getProviderAddress, getProviderClient } from "../chain.js";

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
    "quote-smoke-test",
    [config.sscrtContract],
    ["balance"],
    false,
  );
  await onboardUser(address, permit);
  console.log("onboarded (grant + permit stored)");

  // requestQuote needs a pubkey for a never-transacted address (no on-chain record yet) — a
  // real client gets this from Keplr's getKey(); here it comes from the same test wallet.
  const accountData = (await wallet.getAccounts())[0];
  const pubkeyBase64 = Buffer.from(accountData.pubkey).toString("base64");

  // This address holds no sSCRT yet either — give it a small amount from the provider's own
  // stash so the balance check in requestQuote has something to find sufficient.
  const codeHash = await getSscrtCodeHash();
  const fundMsg = new MsgExecuteContract({
    sender: getProviderAddress(),
    contract_address: config.sscrtContract,
    code_hash: codeHash,
    msg: { transfer: { recipient: address, amount: "1000000" } },
  });
  const fundTx = await getProviderClient().tx.broadcast([fundMsg], { gasLimit: 200_000, gasPriceInFeeDenom: 0.25 });
  if (fundTx.code !== 0) throw new Error(`funding tx failed: ${fundTx.rawLog}`);
  console.log("funded with 1000000 sSCRT from provider");

  // The quoted action is a native MsgSend of 1uscrt, so — unlike the zero-SCRT bootstrap case
  // step 0/smoke-onboard.ts already proved — this address needs at least 1uscrt of its own to
  // send, or the message genuinely fails and requestQuote correctly refuses to quote it (that
  // refusal is itself the desired behaviour: catch a doomed action before anyone signs
  // anything, not paper over it). This tiny top-up is a test-setup convenience for exercising
  // the quote machinery end to end, not a statement that the design needs native SCRT.
  const topUpTx = await getProviderClient().tx.bank.send(
    { from_address: getProviderAddress(), to_address: address, amount: [{ denom: "uscrt", amount: "10" }] },
    { gasLimit: 100_000, gasPriceInFeeDenom: 0.25 },
  );
  if (topUpTx.code !== 0) throw new Error(`uscrt top-up failed: ${topUpTx.rawLog}`);
  console.log("topped up with 10uscrt so the quoted MsgSend can actually succeed");

  const msg = new MsgSend({
    from_address: address,
    to_address: RECIPIENT,
    amount: [{ denom: "uscrt", amount: "1" }],
  });

  const quote = await requestQuote({ address, messages: [msg], pubkeyBase64 });
  console.log(JSON.stringify(quote, null, 2));

  if (quote.messages.length !== 2)
    throw new Error(`FAILED: expected 2 messages (action+payment), got ${quote.messages.length}`);
  console.log(
    `OK: quote issued — gasLimit=${quote.gasLimit}, native fee=${quote.feeAmountUscrt}uscrt, ` +
      `sSCRT payment=${quote.sscrtPaymentAmount}, feeGranter=${quote.feeGranter}`,
  );
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
