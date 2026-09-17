// Regression test for the debt closed in this pass: /submit must re-simulate the native part
// right before broadcast (plan: third pre-broadcast check, alongside sequence + balance). The
// sequence-lock alone can't catch this class of failure — the ACCOUNT's own sequence never
// moves, but a proposal's voting period ends between quote and submit. Proves the check added
// to submit.ts actually rejects, not just that it doesn't break the happy path.
//
// Usage: tsx src/scripts/smoke-resim-guard.ts <proposal_id>
// The proposal must already be close to (but not past) its voting_end_time when this starts —
// this script gets a quote immediately, then sleeps until just after voting ends, then submits.
import { MsgVote, MsgExecuteContract, SecretNetworkClient, Wallet, VoteOption } from "secretjs";
import { requestQuote } from "../quote.js";
import { submitQuote, SubmitError } from "../submit.js";
import { onboardUser } from "../onboarding.js";
import { config } from "../config.js";
import { getSscrtCodeHash, providerAddress, providerClient, readClient } from "../chain.js";

const PROPOSAL_ID = Number(process.argv[2] ?? 2);

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
    "resim-guard-smoke-test",
    [config.sscrtContract],
    ["balance"],
    false,
  );
  await onboardUser(address, permit);

  const codeHash = await getSscrtCodeHash();
  await providerClient.tx.broadcast(
    [
      new MsgExecuteContract({
        sender: providerAddress,
        contract_address: config.sscrtContract,
        code_hash: codeHash,
        msg: { transfer: { recipient: address, amount: "1000000" } },
      }),
    ],
    { gasLimit: 200_000, gasPriceInFeeDenom: 0.25 },
  );

  const proposal: any = await readClient.query.gov.proposal({ proposal_id: PROPOSAL_ID } as any);
  const votingEndTime = new Date(proposal.proposal.voting_end_time);
  console.log("proposal", PROPOSAL_ID, "voting_end_time:", votingEndTime.toISOString());

  const pubkeyBase64 = Buffer.from((await wallet.getAccounts())[0].pubkey).toString("base64");
  const voteMsg = new MsgVote({
    voter: address,
    proposal_id: String(PROPOSAL_ID),
    option: VoteOption.VOTE_OPTION_YES,
    metadata: "",
  });

  const quote = await requestQuote({ address, messages: [voteMsg], pubkeyBase64 });
  console.log("quote issued while voting still open, gasLimit:", quote.gasLimit);

  // The proposal's status only flips to non-voting at the first EndBlocker whose block time is
  // >= voting_end_time — on this devnet's ~5s block time that transition can itself lag the
  // deadline by a block or two, so the buffer has to be generous, not just "past the deadline".
  const waitMs = votingEndTime.getTime() - Date.now() + 20_000;
  if (waitMs <= 0) throw new Error("test setup problem: voting already ended before the quote was issued");
  console.log(`sleeping ${Math.ceil(waitMs / 1000)}s until just after voting ends...`);
  await new Promise((r) => setTimeout(r, waitMs));

  const paymentMsg = new MsgExecuteContract({
    sender: address,
    contract_address: config.sscrtContract,
    code_hash: codeHash,
    msg: { transfer: { recipient: providerAddress, amount: quote.sscrtPaymentAmount } },
  });
  const signedBytes = await userClient.tx.signTx([voteMsg, paymentMsg], {
    gasLimit: quote.gasLimit,
    feeDenom: "uscrt",
    feeGranter: providerAddress,
    explicitSignerData: { accountNumber: quote.accountNumber, sequence: quote.sequence, chainId: config.chainId },
  });

  try {
    const result = await submitQuote(quote.quoteId, signedBytes);
    console.log("unexpected: submitQuote did not throw, result:", result);
    throw new Error("FAILED: submitQuote should have rejected a vote on a closed proposal, but it did not");
  } catch (err) {
    if (err instanceof SubmitError && err.code === "native_action_would_fail") {
      console.log(`OK: submit-time re-simulation correctly rejected the stale vote before broadcast — ${err.message}`);
    } else {
      throw err;
    }
  }
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
