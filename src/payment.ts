// The sSCRT payment message: a fixed-shape SNIP-20 `transfer` to the provider's address.
// Its gas cost cannot come from simulate (contract-execute messages aren't simulatable on
// Secret at all — see gasEstimation.ts), so it is a periodically re-measured constant,
// exactly the kind of number the earlier chain-level phase got burned by treating as static
// (measured +4,986 once, never re-checked, was actually +3,465 — an 800-gas under-quote).
//
// The constant itself lives in gasCalibration.ts's shared table, written by
// scripts/calibrate-payment-gas.ts, and quote.ts reads it fresh on every quote.
import { MsgExecuteContract, EncryptionUtilsImpl } from "secretjs";
import { config } from "./config.js";
import { getProviderAddress } from "./chain.js";
import { getGasConstant, recordGasCalibration } from "./gasCalibration.js";

// A CosmWasm message's body is client-side encrypted before it ever reaches a signature —
// that encryption is about confidentiality of the input to the contract, not about who is
// authorized to send the transaction (that's the Cosmos-level signature, checked separately;
// the contract sees `info.sender` from the tx's actual signer regardless of who encrypted the
// ciphertext). So it's fine for the server to encrypt the payment message itself, using its
// own ephemeral keypair, and hand the user only the resulting bytes to sign — same principle
// the earlier chain-level phase relied on for its own server-constructed fee_deduct message.
// The one consequence: only whoever holds this ephemeral key can later decrypt *this specific
// message's* execution result — acceptable here, since it's a fixed-shape "pay the provider"
// call the user doesn't need to inspect the response of. quote.ts reuses this same instance for
// whitelisted-contract actions (see "Rozšíření: whitelist kontraktů" in the plan) — the server
// already has to see those messages' plaintext to check them against the whitelist, so there's
// no confidentiality left to lose by also being the one that encrypts them.
const serverEncryptionUtils = new EncryptionUtilsImpl(config.lcdUrl);

const PAYMENT_GAS_KEY = "sscrt_payment_transfer";

export function getPaymentGasConstant(): number {
  try {
    return getGasConstant(PAYMENT_GAS_KEY);
  } catch {
    throw new Error(
      "no payment gas calibration on record — run scripts/calibrate-payment-gas.ts before quoting anything",
    );
  }
}

export function recordPaymentGasCalibration(samples: number[]): number {
  return recordGasCalibration(PAYMENT_GAS_KEY, samples);
}

export function getServerEncryptionUtils() {
  return serverEncryptionUtils;
}

export function buildPaymentMessage(payerAddress: string, amountUscrtEquivalent: string, codeHash: string) {
  return new MsgExecuteContract({
    sender: payerAddress,
    contract_address: config.sscrtContract,
    code_hash: codeHash, // passing it explicitly skips an extra round trip secretjs would
    // otherwise make to look it up itself — cheap to cache, see chain.ts's getSscrtCodeHash().
    msg: {
      transfer: {
        recipient: getProviderAddress(),
        amount: amountUscrtEquivalent,
      },
    },
  });
}
