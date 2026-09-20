// Broadcasting the one transaction the provider sponsors: the buyer's payment for gas credits.
//
// The client has had the quoted bytes signed by its own wallet — the server never touches the
// private key. Everything that could have gone stale since the quote was issued is re-checked
// here, as close to the broadcast as possible, because that closeness is the whole argument
// against the race: a quote issued 40 seconds ago could be stale by the time the signed bytes
// come back, and trusting it blindly is what would leave the gap.
import { readClient, getAccount, getSscrtCodeHash } from "./chain.js";
import { db } from "./db.js";
import { getStoredPermit } from "./onboarding.js";
import { quotedCredits } from "./quote.js";
import { config } from "./config.js";
import { verifySignedTx, parseQuotedTx, TxMismatchError } from "./txVerify.js";
import { recordPurchase, deliverPurchase, getPurchase } from "./creditDelivery.js";

export class SubmitError extends Error {
  constructor(
    message: string,
    public code:
      | "not_found"
      | "expired"
      | "already_submitted"
      | "sequence_changed"
      | "insufficient_balance"
      | "signed_tx_mismatch"
      | "not_broadcast",
  ) {
    super(message);
  }
}

interface QuoteRow {
  quote_id: string;
  address: string;
  sequence: number;
  account_number: number;
  sscrt_payment_amount: string;
  gas_limit: number;
  expires_at: string;
  status: string;
  sign_doc_json: string;
}

export interface SubmitResult {
  txHash: string;
  code: number;
  rawLog: string;
  nativeFeeSpentUscrt: string;
  sscrtReceived: string;
  /** What was bought, and whether it has arrived yet. Delivery is a second transaction. */
  creditsUscrt: string;
  delivery: "delivered" | "pending";
}

export async function submitQuote(quoteId: string, signedTxBytes: Uint8Array): Promise<SubmitResult> {
  const quote = db.prepare(`SELECT * FROM quotes WHERE quote_id = ?`).get(quoteId) as QuoteRow | undefined;
  if (!quote) throw new SubmitError(`no such quote: ${quoteId}`, "not_found");
  if (quote.status !== "issued") throw new SubmitError(`quote ${quoteId} already ${quote.status}`, "already_submitted");
  if (new Date(quote.expires_at).getTime() < Date.now()) {
    markQuote(quoteId, "expired");
    throw new SubmitError(`quote ${quoteId} expired at ${quote.expires_at} — request a fresh one`, "expired");
  }

  // Does the signature cover the transaction this quote describes? Everything else re-checks the
  // world; this re-checks the client, and it is the only check that stops a quote being used as a
  // licence to have the provider pay for some other transaction entirely.
  //
  // First, because it needs no chain query: bytes that were never going to be broadcast are
  // refused without spending a round trip on them.
  try {
    verifySignedTx(signedTxBytes, parseQuotedTx(quote.sign_doc_json));
  } catch (err) {
    if (err instanceof TxMismatchError) {
      markQuote(quoteId, "rejected");
      throw new SubmitError(
        `the signed transaction does not match quote ${quoteId}: ${err.message}`,
        "signed_tx_mismatch",
      );
    }
    throw err;
  }

  // The sequence lock. If anything else moved this account forward, the signed bytes were built
  // against a sequence that no longer exists and would fail at ante anyway — refuse here instead
  // of paying for a broadcast to find that out.
  const account = await getAccount(quote.address);
  if (account.sequence !== quote.sequence) {
    markQuote(quoteId, "expired");
    throw new SubmitError(
      `sequence changed since quote was issued (was ${quote.sequence}, now ${account.sequence}) — request a fresh quote`,
      "sequence_changed",
    );
  }

  // Balance re-check through the same permit the quote used. Catches the case sequence-locking
  // cannot: this account's own sequence has not moved, but the balance is short anyway. Cheap
  // here; after the broadcast the ante-level fee is already gone.
  const permit = getStoredPermit(quote.address);
  if (permit) {
    const codeHash = await getSscrtCodeHash();
    const balanceResult = (await readClient.query.compute.queryContract({
      contract_address: config.sscrtContract,
      code_hash: codeHash,
      query: { with_permit: { permit, query: { balance: {} } } },
    })) as { balance?: { amount?: string } };
    const balance = BigInt(balanceResult?.balance?.amount ?? "0");
    if (balance < BigInt(quote.sscrt_payment_amount)) {
      markQuote(quoteId, "expired");
      throw new SubmitError(
        `sSCRT balance no longer covers this purchase (have ${balance}, need ${quote.sscrt_payment_amount})`,
        "insufficient_balance",
      );
    }
  }

  markQuote(quoteId, "submitted");

  const tx = await broadcastAndConfirm(signedTxBytes, quote);

  // Ante-committed regardless of what the message did.
  const nativeFeeSpentUscrt = String(Math.ceil(quote.gas_limit * config.nativeGasPriceUscrt));
  const creditsUscrt = quotedCredits(quote.sign_doc_json) ?? "0";

  if (tx.code !== 0) {
    // The chain took the fee in the ante handler and reverted the rest, so the provider paid for
    // a transaction it was not reimbursed for. Recorded without the address: what accounting
    // needs is the loss, not who caused it, and the bootstrap grant already caps what one address
    // can cost. Rate limiting is what stops this being repeated.
    db.prepare(
      `INSERT INTO sales_ledger (sscrt_received, credits_sold_uscrt, native_fee_spent_uscrt)
       VALUES ('0', '0', ?)`,
    ).run(nativeFeeSpentUscrt);

    return {
      txHash: tx.transactionHash,
      code: tx.code,
      rawLog: tx.rawLog ?? "",
      nativeFeeSpentUscrt,
      sscrtReceived: "0",
      creditsUscrt,
      delivery: "pending",
    };
  }

  // Paid. Write that down before spending anything on it — if the process dies between here and
  // the delivery, the sweep in creditDelivery.ts finishes the job rather than the buyer losing
  // their money to a restart.
  recordPurchase({
    quoteId,
    address: quote.address,
    sscrtPaid: quote.sscrt_payment_amount,
    creditsUscrt,
    paymentTxHash: tx.transactionHash,
  });

  // Best effort, and deliberately not awaited for its success: the buyer's transaction has
  // already landed, and a delivery that needs a retry is not a failure of theirs to report. The
  // row survives either way and the sweep picks it up.
  const delivered = await deliverPurchase(quoteId).catch(() => false);

  return {
    txHash: tx.transactionHash,
    code: tx.code,
    rawLog: tx.rawLog ?? "",
    nativeFeeSpentUscrt,
    sscrtReceived: quote.sscrt_payment_amount,
    creditsUscrt,
    delivery: delivered ? "delivered" : "pending",
  };
}

/** Where a purchase has got to, for a client polling after /submit. */
export function purchaseStatus(quoteId: string): {
  quoteId: string;
  state: "delivered" | "paid" | "delivering" | "failed" | "needs_review" | "unknown";
  creditsUscrt: string | null;
  lastError: string | null;
} {
  const purchase = getPurchase(quoteId);
  if (purchase) {
    return {
      quoteId,
      state: purchase.state,
      creditsUscrt: purchase.credits_uscrt,
      lastError: purchase.last_error,
    };
  }

  // No row and a submitted quote means the purchase settled and was cleared — the row is deleted
  // on delivery precisely so the buyer's address does not outlive the need for it.
  const quote = db.prepare(`SELECT status, sign_doc_json FROM quotes WHERE quote_id = ?`).get(quoteId) as
    | { status: string; sign_doc_json: string }
    | undefined;
  if (quote?.status === "submitted") {
    return { quoteId, state: "delivered", creditsUscrt: quotedCredits(quote.sign_doc_json), lastError: null };
  }
  return { quoteId, state: "unknown", creditsUscrt: null, lastError: null };
}

/**
 * Broadcasts, and then makes sure of the answer rather than trusting the absence of one.
 *
 * A transaction can pass CheckTx, be given a hash, sit in one node's mempool and never reach a
 * block — observed repeatedly against a public endpoint, which dropped roughly a fifth of what it
 * accepted. secretjs reports that as "submitted but was not yet found on the chain", which is
 * indistinguishable, from the caller's side, between "late" and "gone".
 *
 * The difference decides whether the buyer was charged, so it is settled by asking the chain. If
 * the transaction is genuinely absent the sequence has not moved, nothing was spent, and the
 * honest answer is to say so and let the client ask for a fresh quote — not to report a failure
 * that might have taken money.
 */
async function broadcastAndConfirm(signedTxBytes: Uint8Array, quote: QuoteRow) {
  try {
    return await readClient.tx.broadcastSignedTx(signedTxBytes, {
      gasLimit: quote.gas_limit,
      broadcastCheckIntervalMs: 3000,
      broadcastTimeoutMs: config.broadcastTimeoutMs,
    });
  } catch (err) {
    // Two different failures arrive here and only one means the transaction is in trouble: the
    // wait timing out, and the endpoint refusing the *query* that was checking on it. The second
    // is common — a public endpoint rate-limits by serving an HTML page where JSON was expected,
    // which surfaces as a parse error naming the transaction it was asking about. Reporting
    // either as a failed transaction is wrong: one already included would be announced as an
    // error while the money moved.
    const hash = /([0-9A-Fa-f]{64})/.exec((err as Error).message)?.[1];
    if (!hash) throw err;

    // Patient on purpose. If the endpoint is rate-limiting, the answer arrives once the window
    // passes, and giving up early would turn a throttled query into a reported loss.
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, attempt < 2 ? 6000 : 12000));
      const found = await readClient.query.getTx(hash).catch(() => null);
      if (found) return found;
    }

    markQuote(quote.quote_id, "dropped");
    throw new SubmitError(
      `the transaction (${hash}) never reached a block — nothing was spent and your balance is untouched. ` +
        "The endpoint accepted it and then dropped it; request a fresh quote and try again.",
      "not_broadcast",
    );
  }
}

function markQuote(quoteId: string, status: string) {
  db.prepare(`UPDATE quotes SET status = ? WHERE quote_id = ?`).run(status, quoteId);
}
