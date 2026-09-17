// Proves MsgVote works through the sponsorship flow: a brand-new address votes under its
// OWN name (no forwarder), paying gas via the grant and reimbursing sSCRT — and crucially,
// MsgVote needs no token balance of its own at all (unlike delegate/send), which is exactly
// why it matters that requestQuote doesn't wrongly assume every native action needs funds.
import { MsgVote, MsgExecuteContract, SecretNetworkClient, Wallet, VoteOption } from "secretjs";
import { requestQuote } from "../quote.js";
import { submitQuote } from "../submit.js";
import { onboardUser } from "../onboarding.js";
import { config } from "../config.js";
import { getSscrtCodeHash, getProviderAddress, getProviderClient } from "../chain.js";

const PROPOSAL_ID = Number(process.argv[2] ?? 1);

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
    "vote-smoke-test",
    [config.sscrtContract],
    ["balance"],
    false,
  );
  await onboardUser(address, permit);

  const codeHash = await getSscrtCodeHash();
  const fundTx = await getProviderClient().tx.broadcast(
    [
      new MsgExecuteContract({
        sender: getProviderAddress(),
        contract_address: config.sscrtContract,
        code_hash: codeHash,
        msg: { transfer: { recipient: address, amount: "1000000" } },
      }),
    ],
    { gasLimit: 200_000, gasPriceInFeeDenom: 0.25 },
  );
  if (fundTx.code !== 0) throw new Error(`funding tx failed (code ${fundTx.code}): ${fundTx.rawLog}`);
  console.log("funded with sSCRT only — no uscrt at all, voting needs none");

  const pubkeyBase64 = Buffer.from((await wallet.getAccounts())[0].pubkey).toString("base64");
  const voteMsg = new MsgVote({
    voter: address,
    proposal_id: String(PROPOSAL_ID),
    option: VoteOption.VOTE_OPTION_YES,
    metadata: "", // required by gov v1's proto (not optional) despite secretjs's params type not marking it so at the call site
  });

  const quote = await requestQuote({ address, messages: [voteMsg], pubkeyBase64 });
  console.log("quote issued: gasLimit", quote.gasLimit, "sSCRT payment", quote.sscrtPaymentAmount);

  const paymentMsg = new MsgExecuteContract({
    sender: address,
    contract_address: config.sscrtContract,
    code_hash: codeHash,
    msg: { transfer: { recipient: getProviderAddress(), amount: quote.sscrtPaymentAmount } },
  });
  const signedBytes = await userClient.tx.signTx([voteMsg, paymentMsg], {
    gasLimit: quote.gasLimit,
    feeDenom: "uscrt",
    feeGranter: getProviderAddress(),
    explicitSignerData: { accountNumber: quote.accountNumber, sequence: quote.sequence, chainId: config.chainId },
  });

  const result = await submitQuote(quote.quoteId, signedBytes);
  console.log("submit result:", result);
  if (result.code !== 0) throw new Error(`FAILED: vote tx landed with code ${result.code}: ${result.rawLog}`);

  const voteResp: any = await userClient.query.gov.vote({ proposal_id: PROPOSAL_ID, voter: address } as any);
  console.log("vote query result:", JSON.stringify(voteResp));
  const recordedVoter = voteResp?.vote?.voter;
  if (recordedVoter !== address) throw new Error(`FAILED: vote recorded under ${recordedVoter}, not the user's address`);

  console.log(`OK: vote belongs to ${address}, no uscrt needed, provider reimbursed ${result.sscrtReceived} sSCRT`);
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
