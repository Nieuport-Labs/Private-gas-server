// Checks that the bytes a client hands to /submit are the transaction the provider quoted.
//
// Until this existed, nothing connected the two. submitQuote re-checked the sequence, the sSCRT
// balance and the native action, but then broadcast whatever bytes arrived — so a client could
// take a quote, sign a different transaction against it, and have the provider pay for it. A
// real run proved it: a quote for a 32745 usSCRT payment was signed with a payment of 1 usSCRT,
// went through, and cost the provider 26196 uscrt of gas for one millionth of a SCRT.
//
// The obvious defence — read the payment message and check the amount — is not available. The
// message body is encrypted, and it is encrypted by the *client's* wallet against a seed the
// server does not have. So this does not read anything. It compares.
//
// The quote already hands the client a payment message the server encrypted itself, so the
// server knows those bytes exactly. Requiring the signed transaction to carry them verbatim
// settles amount, recipient and contract in one comparison, without decrypting anything. The
// nonce makes re-encryption produce different bytes, so "verbatim" also means the client cannot
// rebuild an identical-looking message: it has to sign the one it was given.
//
// The fee and gas limit are plaintext in AuthInfo, so those are compared directly — that is what
// stops a client signing a fivefold gas limit and draining the grant at the quoted price.
import { TxRaw, TxBody, AuthInfo } from "secretjs/dist/protobuf/cosmos/tx/v1beta1/tx.js";
import { toBase64 } from "secretjs";

export interface QuotedMessage {
  typeUrl: string;
  /** base64 of the encoded protobuf message body, exactly as the quote issued it */
  bytes: string;
}

export interface QuotedTx {
  messages: QuotedMessage[];
  gasLimit: number;
  feeAmountUscrt: string;
  feeGranter: string;
}

/**
 * Pulls the verification record out of a stored quote.
 *
 * It exists so that one place owns the shape. The first version of this check passed the whole
 * stored object through an `as QuotedTx` cast, whose `messages` field holds the *amino* messages
 * — a different shape with different field names. The cast made that invisible to the compiler,
 * and the result rejected every transaction, honest ones included, complaining that the quoted
 * message type was `undefined`.
 */
export function parseQuotedTx(signDocJson: string): QuotedTx {
  let parsed: { verification?: QuotedTx };
  try {
    parsed = JSON.parse(signDocJson);
  } catch (err) {
    throw new TxMismatchError(`the stored quote is unreadable: ${(err as Error).message}`);
  }
  const v = parsed.verification;
  if (!v || !Array.isArray(v.messages) || typeof v.gasLimit !== "number") {
    // Only reachable for a quote issued before this check existed. They live 45 seconds, so the
    // remedy is simply to ask for another one.
    throw new TxMismatchError("this quote was issued before submission checks existed — request a fresh one");
  }
  return v;
}

export class TxMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TxMismatchError";
  }
}

export function verifySignedTx(signedTxBytes: Uint8Array, quoted: QuotedTx): void {
  let body: ReturnType<typeof TxBody.decode>;
  let authInfo: ReturnType<typeof AuthInfo.decode>;
  try {
    const raw = TxRaw.decode(signedTxBytes);
    body = TxBody.decode(raw.body_bytes);
    authInfo = AuthInfo.decode(raw.auth_info_bytes);
  } catch (err) {
    throw new TxMismatchError(`the submitted bytes are not a signed transaction: ${(err as Error).message}`);
  }

  const fee = authInfo.fee;
  if (!fee) throw new TxMismatchError("the signed transaction carries no fee");

  // Without this the provider pays whatever limit the client chose, at a price the client also
  // chose, while owing only the quoted payment.
  if (String(fee.gas_limit) !== String(quoted.gasLimit)) {
    throw new TxMismatchError(`gas limit is ${fee.gas_limit}, quoted ${quoted.gasLimit}`);
  }
  if (fee.amount.length !== 1 || fee.amount[0].denom !== "uscrt" || fee.amount[0].amount !== quoted.feeAmountUscrt) {
    const got = fee.amount.map((c) => `${c.amount}${c.denom}`).join(",") || "nothing";
    throw new TxMismatchError(`fee is ${got}, quoted ${quoted.feeAmountUscrt}uscrt`);
  }

  // The granter is the whole reason the provider is exposed here at all; a payer would shift who
  // the chain charges, so anything but the quoted granter and an empty payer is refused.
  if (fee.granter !== quoted.feeGranter) {
    throw new TxMismatchError(`fee granter is "${fee.granter}", quoted "${quoted.feeGranter}"`);
  }
  if (fee.payer) throw new TxMismatchError(`fee payer is set to "${fee.payer}", it must be empty`);

  if (body.messages.length !== quoted.messages.length) {
    throw new TxMismatchError(
      `transaction has ${body.messages.length} message(s), quoted ${quoted.messages.length} — ` +
        "the payment message is part of the quote and cannot be dropped or added to",
    );
  }

  for (let i = 0; i < quoted.messages.length; i++) {
    const signed = body.messages[i];
    const expected = quoted.messages[i];
    if (signed.type_url !== expected.typeUrl) {
      throw new TxMismatchError(`message ${i} is ${signed.type_url}, quoted ${expected.typeUrl}`);
    }
    if (toBase64(signed.value) !== expected.bytes) {
      throw new TxMismatchError(
        `message ${i} is not the one that was quoted — sign the messages the quote returned, ` +
          "re-encrypting them produces different bytes and is rejected",
      );
    }
  }
}
