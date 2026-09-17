// Proves the whitelisted-contract sponsorship path end to end: a bundle mixing a native action
// (MsgSend, simulated normally) with a whitelisted MsgExecuteContract call (calibrated constant,
// can't be simulated) prices and submits correctly, and a call to a NON-whitelisted contract is
// rejected before anything is quoted. No real DEX exists on this devnet, so the whitelisted
// "target contract" is the sSCRT contract itself, called with a different action
// (increase_allowance) than the payment leg uses (transfer) — a stand-in for "some other
// contract like ShadeSwap", not a claim that whitelisting sSCRT itself is a realistic setup.
//
// Requires ALLOWED_CONTRACT_ADDRESSES to include the sSCRT contract address when this process
// starts (config.ts reads env once at import time) — see package.json's smoke:contract-whitelist
// script for the exact invocation.
import { MsgSend, MsgExecuteContract, SecretNetworkClient, Wallet } from "secretjs";
import { requestQuote, QuoteError } from "../quote.js";
import { submitQuote } from "../submit.js";
import { onboardUser } from "../onboarding.js";
import { config } from "../config.js";
import { getSscrtCodeHash, getProviderAddress, getProviderClient } from "../chain.js";
import { recordGasCalibration } from "../gasCalibration.js";

const RECIPIENT = "secret1ap26qrlp8mcq2pg6r47w43l0y8zkqm8a450s03";

async function main() {
  if (!config.allowedContractAddresses.includes(config.sscrtContract)) {
    throw new Error(
      `test setup problem: run with ALLOWED_CONTRACT_ADDRESSES=${config.sscrtContract} (see package.json)`,
    );
  }

  const codeHash = await getSscrtCodeHash();

  // Calibrate the whitelisted contract's gas constant inline (same measurement
  // calibrate-contract-gas.ts does standalone) — a few real increase_allowance calls as the
  // provider itself, reading gas_used back.
  const calibrationSamples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const msg = new MsgExecuteContract({
      sender: getProviderAddress(),
      contract_address: config.sscrtContract,
      code_hash: codeHash,
      msg: { increase_allowance: { spender: RECIPIENT, amount: String(1000 + i) } },
    });
    const tx = await getProviderClient().tx.broadcast([msg], { gasLimit: 200_000, gasPriceInFeeDenom: 0.25 });
    if (tx.code !== 0) throw new Error(`calibration sample ${i} failed (code ${tx.code}): ${tx.rawLog}`);
    calibrationSamples.push(Number(tx.gasUsed));
  }
  const contractGasConstant = recordGasCalibration(config.sscrtContract, calibrationSamples);
  console.log(`calibrated ${config.sscrtContract}: constant=${contractGasConstant} from`, calibrationSamples);

  const wallet = new Wallet();
  const address = wallet.address;
  console.log("brand-new address:", address);

  const userClient = new SecretNetworkClient({ url: config.lcdUrl, chainId: config.chainId, wallet, walletAddress: address });
  const permit = await userClient.utils.accessControl.permit.sign(
    address,
    config.chainId,
    "contract-whitelist-smoke-test",
    [config.sscrtContract],
    ["balance"],
    false,
  );
  await onboardUser(address, permit);

  await getProviderClient().tx.broadcast(
    [new MsgExecuteContract({ sender: getProviderAddress(), contract_address: config.sscrtContract, code_hash: codeHash, msg: { transfer: { recipient: address, amount: "1000000" } } })],
    { gasLimit: 200_000, gasPriceInFeeDenom: 0.25 },
  );
  await getProviderClient().tx.bank.send(
    { from_address: getProviderAddress(), to_address: address, amount: [{ denom: "uscrt", amount: "10" }] },
    { gasLimit: 100_000, gasPriceInFeeDenom: 0.25 },
  );
  console.log("funded with sSCRT + a little uscrt");

  // Negative case first: a call to a contract that is NOT whitelisted must be rejected before
  // any simulate/gas work happens, not silently allowed through.
  const notWhitelisted = "secret1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzuwphdh";
  const rogueMsg = new MsgExecuteContract({ sender: address, contract_address: notWhitelisted, code_hash: codeHash, msg: { increase_allowance: { spender: RECIPIENT, amount: "1" } } });
  try {
    await requestQuote({ address, messages: [rogueMsg] });
    throw new Error("FAILED: quoting a call to a non-whitelisted contract should have been rejected");
  } catch (err) {
    if (err instanceof QuoteError && err.code === "contract_not_allowed") {
      console.log("OK: non-whitelisted contract correctly rejected —", err.message);
    } else {
      throw err;
    }
  }

  // Positive case: native MsgSend + whitelisted MsgExecuteContract call in the same bundle.
  const pubkeyBase64 = Buffer.from((await wallet.getAccounts())[0].pubkey).toString("base64");
  const nativeMsg = new MsgSend({ from_address: address, to_address: RECIPIENT, amount: [{ denom: "uscrt", amount: "1" }] });
  const contractMsg = new MsgExecuteContract({ sender: address, contract_address: config.sscrtContract, code_hash: codeHash, msg: { increase_allowance: { spender: RECIPIENT, amount: "500" } } });

  const quote = await requestQuote({ address, messages: [nativeMsg, contractMsg], pubkeyBase64 });
  console.log("quote issued: gasLimit", quote.gasLimit, "sSCRT payment", quote.sscrtPaymentAmount);

  const paymentMsg = new MsgExecuteContract({ sender: address, contract_address: config.sscrtContract, code_hash: codeHash, msg: { transfer: { recipient: getProviderAddress(), amount: quote.sscrtPaymentAmount } } });
  const signedBytes = await userClient.tx.signTx([nativeMsg, contractMsg, paymentMsg], {
    gasLimit: quote.gasLimit,
    feeDenom: "uscrt",
    feeGranter: getProviderAddress(),
    explicitSignerData: { accountNumber: quote.accountNumber, sequence: quote.sequence, chainId: config.chainId },
  });

  const result = await submitQuote(quote.quoteId, signedBytes);
  console.log("submit result:", result);
  if (result.code !== 0) throw new Error(`FAILED: bundle with whitelisted contract call landed with code ${result.code}: ${result.rawLog}`);
  // code 0 on a bundle that includes the increase_allowance call is itself the proof it executed
  // — a SNIP-20 execute failure inside the bundle would show up as a non-zero code here.

  console.log(`OK: bundle with a whitelisted contract call sponsored successfully, provider reimbursed ${result.sscrtReceived} sSCRT`);
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
