// Proves the core claim behind the whole pivot for a native staking action specifically,
// not just a bank send: a brand-new address delegates under ITS OWN name (delegator_address
// is the address itself, since it signs the MsgDelegate directly — no forwarder contract
// involved anywhere in this design), paying gas via the provider's grant and reimbursing the
// provider in sSCRT in the same transaction.
import { MsgDelegate, MsgExecuteContract, SecretNetworkClient, Wallet } from "secretjs";
import { requestQuote } from "../quote.js";
import { submitQuote } from "../submit.js";
import { onboardUser } from "../onboarding.js";
import { config } from "../config.js";
import { getSscrtCodeHash, providerAddress, providerClient } from "../chain.js";

const VALIDATOR = "secretvaloper14aj08vd2ntty7dvskdmdu4zhf23mcwgtdvh6qt";

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
    "delegate-smoke-test",
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
  // Delegating requires actually owning uscrt to stake — the grant only ever covers gas, on
  // purpose (plan: "provider s allowance tahající platbu vlastní transakcí" was rejected
  // precisely because a grant must never reach into what it's meant to only pay fees for).
  // This is the address's own stake, separate from the sponsorship mechanism entirely.
  await providerClient.tx.bank.send(
    { from_address: providerAddress, to_address: address, amount: [{ denom: "uscrt", amount: "50000" }] },
    { gasLimit: 100_000, gasPriceInFeeDenom: 0.25 },
  );
  console.log("funded with sSCRT (for the fee reimbursement) and uscrt (the stake itself)");

  const pubkeyBase64 = Buffer.from((await wallet.getAccounts())[0].pubkey).toString("base64");
  const delegateMsg = new MsgDelegate({
    delegator_address: address,
    validator_address: VALIDATOR,
    amount: { denom: "uscrt", amount: "10000" },
  });

  const quote = await requestQuote({ address, messages: [delegateMsg], pubkeyBase64 });
  console.log("quote issued: gasLimit", quote.gasLimit, "sSCRT payment", quote.sscrtPaymentAmount);

  const paymentMsg = new MsgExecuteContract({
    sender: address,
    contract_address: config.sscrtContract,
    code_hash: codeHash,
    msg: { transfer: { recipient: providerAddress, amount: quote.sscrtPaymentAmount } },
  });
  const signedBytes = await userClient.tx.signTx([delegateMsg, paymentMsg], {
    gasLimit: quote.gasLimit,
    feeDenom: "uscrt",
    feeGranter: providerAddress,
    explicitSignerData: { accountNumber: quote.accountNumber, sequence: quote.sequence, chainId: config.chainId },
  });

  const result = await submitQuote(quote.quoteId, signedBytes);
  console.log("submit result:", result);
  if (result.code !== 0) throw new Error(`FAILED: delegate tx landed with code ${result.code}: ${result.rawLog}`);

  // The point of this whole test: does the delegation belong to the USER, not to any
  // forwarder/provider identity?
  const delegation = await userClient.query.staking.delegation({ delegator_addr: address, validator_addr: VALIDATOR } as any);
  console.log("delegation query result:", JSON.stringify(delegation));
  const shares = (delegation as any)?.delegation_response?.delegation?.shares;
  if (!shares || Number(shares) <= 0) {
    throw new Error("FAILED: no delegation recorded under the user's own address");
  }

  console.log(`OK: delegation belongs to ${address} (shares=${shares}), provider was reimbursed ${result.sscrtReceived} sSCRT`);
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
