// How much sSCRT a sponsored bundle takes out of the user's balance, counting the action and not
// only the payment.
//
// This exists because of an asymmetry that cannot be closed any other way. The fee is deducted in
// the ante handler, before any message runs; if a message then fails, every state change reverts
// — including the payment — but the fee does not come back. Reordering the bundle does not help,
// because a Cosmos transaction is atomic as a whole: one failing message discards the cached
// state of all of them.
//
// So a transaction that was never going to succeed costs the provider the full fee and returns
// nothing. The only defence is to not broadcast it, and the most common reason such a bundle
// fails is the simplest one: the user is spending more of the token than they hold. The server
// can see that coming, because it already sees the plaintext of calls to whitelisted contracts.
//
// Deliberately narrow. It understands the SNIP-20 entry points that move the sender's own balance
// and nothing else; an unrecognised message contributes zero, which is exactly where the server
// stood before this file existed. It can therefore make the check stricter, never looser.
import type { MsgExecuteContract } from "secretjs";

/** The SNIP-20 entry points that spend the sender's own balance. */
const SPENDING_ENTRY_POINTS = ["transfer", "send", "burn"] as const;

function amountOf(msg: unknown): bigint {
  if (!msg || typeof msg !== "object") return 0n;
  const body = msg as Record<string, { amount?: unknown } | undefined>;
  for (const entryPoint of SPENDING_ENTRY_POINTS) {
    const amount = body[entryPoint]?.amount;
    if (typeof amount === "string" && /^\d+$/.test(amount)) return BigInt(amount);
  }
  return 0n;
}

/**
 * The action's own sSCRT cost, excluding the payment to the provider — add that separately, since
 * the caller knows it and it is not one of these messages.
 */
export function sscrtOutflow(messages: MsgExecuteContract<object>[], sscrtContract: string): bigint {
  let total = 0n;
  for (const message of messages) {
    if (message.contractAddress !== sscrtContract) continue; // another token, another balance
    total += amountOf(message.msg);
  }
  return total;
}

/**
 * The total sSCRT balance a quote requires, as stored with it. Falls back to the payment alone for
 * a quote written before this check existed, which is the behaviour those quotes were issued under.
 */
export function readRequiredSscrt(signDocJson: string, paymentAmount: string): string {
  try {
    const parsed = JSON.parse(signDocJson) as { requiredSscrt?: unknown };
    if (typeof parsed.requiredSscrt === "string" && /^\d+$/.test(parsed.requiredSscrt)) {
      return parsed.requiredSscrt;
    }
  } catch {
    // Unreadable row — the payment alone is the safe floor, and verifySignedTx has already
    // rejected anything whose stored record is malformed.
  }
  return paymentAmount;
}
