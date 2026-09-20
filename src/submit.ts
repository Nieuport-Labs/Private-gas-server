// The /submit step described in the plan: the client has already had the quoted transaction
// signed (by its own secretjs+Keplr wallet — the server never touches the private key) and
// hands back the fully signed, protobuf-encoded tx bytes. This module re-verifies everything
// that could have gone stale since the quote was issued, then — and only then — broadcasts.
//
// Why re-verify at all if the client already has a quote: the plan's whole sequence-lock
// argument depends on this check happening as close to broadcast as possible. A quote issued
// 40 seconds ago, right at its TTL, could be stale by the time the signed bytes come back —
// re-checking here, not trusting the quote blindly, is what actually closes that race.
import { readClient } from "./chain.js";
import { db } from "./db.js";
import { getAccount, getSscrtCodeHash } from "./chain.js";
import { getStoredPermit, getStoredGrant, markFeeCollected, ensureFullGrant } from "./onboarding.js";
import { simulateNativeMessages } from "./gasEstimation.js";
import { getCachedNativeMessages, clearCachedNativeMessages } from "./quote.js";
import { config } from "./config.js";
import { verifySignedTx, parseQuotedTx, TxMismatchError } from "./txVerify.js";
import { readRequiredSscrt } from "./tokenOutflow.js";
import { creditDeposit, debitDeposit } from "./deposits.js";

export class SubmitError extends Error {
  constructor(
    message: string,
    public code:
      | "not_found"
      | "expired"
      | "already_submitted"
      | "sequence_changed"
      | "insufficient_balance"
      | "native_action_would_fail"
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
}

export async function submitQuote(quoteId: string, signedTxBytes: Uint8Array): Promise<SubmitResult> {
  const quote = db.prepare(`SELECT * FROM quotes WHERE quote_id = ?`).get(quoteId) as QuoteRow | undefined;
  if (!quote) throw new SubmitError(`no such quote: ${quoteId}`, "not_found");
  if (quote.status !== "issued") throw new SubmitError(`quote ${quoteId} already ${quote.status}`, "already_submitted");
  if (new Date(quote.expires_at).getTime() < Date.now()) {
    markQuote(quoteId, "expired");
    clearCachedNativeMessages(quoteId);
    throw new SubmitError(`quote ${quoteId} expired at ${quote.expires_at} — request a fresh one`, "expired");
  }

  // Does the client's signature cover the transaction this quote describes? Everything below
  // re-checks the world; this re-checks the client, and it is the only check that stops a quote
  // being used as a licence to have the provider pay for some other transaction entirely.
  //
  // Deliberately first of the checks: it needs no chain query, so bytes that were never going to
  // be broadcast are refused before spending a single round trip on them.
  try {
    verifySignedTx(signedTxBytes, parseQuotedTx(quote.sign_doc_json));
  } catch (err) {
    if (err instanceof TxMismatchError) {
      markQuote(quoteId, "rejected");
      clearCachedNativeMessages(quoteId);
      throw new SubmitError(
        `the signed transaction does not match quote ${quoteId}: ${err.message}`,
        "signed_tx_mismatch",
      );
    }
    throw err;
  }

  // The sequence-lock: this is the whole reason a race can't drain funds out from under a
  // quote (see plan Context). If anything else moved this account forward, the quote's
  // sequence no longer matches reality and the signed bytes (built against the stale one)
  // would fail ante anyway — reject here instead of wasting a broadcast round-trip on it.
  const account = await getAccount(quote.address);
  if (account.sequence !== quote.sequence) {
    markQuote(quoteId, "expired");
    clearCachedNativeMessages(quoteId);
    throw new SubmitError(
      `sequence changed since quote was issued (was ${quote.sequence}, now ${account.sequence}) — request a fresh quote`,
      "sequence_changed",
    );
  }

  // Balance re-check via the same permit the quote used. Catches the one case sequence-
  // locking can't: this account's OWN sequence hasn't moved, but its permit-visible balance
  // is for some other reason short (e.g. the earlier quote's estimate is now stale because
  // calibration changed underneath it) — cheap to catch here, before broadcasting, rather
  // than as a message-execution failure after the ante-level fee is already spent.
  const permit = getStoredPermit(quote.address);
  if (permit) {
    const codeHash = await getSscrtCodeHash();
    const balanceResult: any = await readClient.query.compute.queryContract({
      contract_address: config.sscrtContract,
      code_hash: codeHash,
      query: { with_permit: { permit, query: { balance: {} } } },
    });
    const balance = BigInt(balanceResult?.balance?.amount ?? "0");
    // The whole bundle's sSCRT cost, action included — the same figure the quote checked. Checking
    // only the payment would let a bundle through that is certain to fail on the action, which
    // costs the provider the fee with nothing to show for it.
    const required = BigInt(readRequiredSscrt(quote.sign_doc_json, quote.sscrt_payment_amount));
    if (balance < required) {
      markQuote(quoteId, "expired");
      clearCachedNativeMessages(quoteId);
      throw new SubmitError(
        `sSCRT balance no longer covers this transaction (have ${balance}, need ${required})`,
        "insufficient_balance",
      );
    }
  }

  // Third pre-broadcast check (plan: "tři různé kontroly místo jedné"): re-simulate the
  // native part of the action right now. Sequence + balance rule out the race this design is
  // built around, but not a plain "this action would fail anyway" — a validator got jailed, a
  // proposal left its voting period, a recipient address became invalid, etc. — since the last
  // check. Catch that here rather than let it burn the ante-committed fee for nothing.
  const cachedNative = getCachedNativeMessages(quoteId);
  if (cachedNative && cachedNative.messages.length > 0) {
    try {
      await simulateNativeMessages({
        address: quote.address,
        pubkeyBase64: cachedNative.pubkeyBase64,
        accountNumber: quote.account_number,
        sequence: quote.sequence,
        messages: cachedNative.messages,
      });
    } catch (err) {
      markQuote(quoteId, "expired");
      clearCachedNativeMessages(quoteId);
      throw new SubmitError(
        `native action would fail if broadcast now: ${(err as Error).message}`,
        "native_action_would_fail",
      );
    }
  }

  markQuote(quoteId, "submitted");
  clearCachedNativeMessages(quoteId);

  const tx = await broadcastAndConfirm(signedTxBytes, quote);

  const nativeFeeSpentUscrt = String(Math.ceil(quote.gas_limit * config.nativeGasPriceUscrt)); // ante-committed regardless of message outcome
  const sscrtReceived = tx.code === 0 ? quote.sscrt_payment_amount : "0";

  db.prepare(
    `INSERT INTO tx_outcomes (tx_hash, quote_id, address, code, native_fee_spent_uscrt, sscrt_received, raw_log)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(tx.transactionHash, quoteId, quote.address, tx.code, nativeFeeSpentUscrt, sscrtReceived, tx.rawLog ?? "");

  const depositTopUp = BigInt(readQuoteField(quote.sign_doc_json, "depositTopUpSscrt") ?? "0");

  if (tx.code === 0) {
    // The top-up was inside the transaction, so it landed with it. Credit it only now — crediting
    // at quote time would book money that a failed or abandoned transaction never delivered.
    creditDeposit(quote.address, depositTopUp);

    // The deposit is paid, so the address graduates from its single-transaction bootstrap grant to
    // the full spend limit. Best-effort on purpose: the user's transaction has already succeeded,
    // and a failure to update our own bookkeeping must not be reported as a failure of theirs.
    // The next quote retries it.
    const grant = getStoredGrant(quote.address);
    if (grant && grant.stage === "bootstrap" && !grant.fee_collected) {
      markFeeCollected(quote.address);
      await ensureFullGrant(quote.address);
    }
  } else {
    // This is the case the deposit exists for. The chain took the fee in the ante handler and then
    // reverted everything, payment included, so the provider paid for a transaction it was never
    // reimbursed for. The loss goes to the address that chose it, and the user's next quote will
    // collect the shortfall back.
    debitDeposit(quote.address, BigInt(nativeFeeSpentUscrt));
  }

  return {
    txHash: tx.transactionHash,
    code: tx.code,
    rawLog: tx.rawLog ?? "",
    nativeFeeSpentUscrt,
    sscrtReceived,
  };
}

/**
 * Broadcasts, and then makes sure of the answer rather than trusting the absence of one.
 *
 * A transaction can pass CheckTx, be given a hash, sit in one node's mempool and never reach a
 * block — observed repeatedly against a public endpoint, which dropped roughly a fifth of what it
 * accepted. secretjs reports that as "submitted but was not yet found on the chain", which is
 * indistinguishable, from the caller's side, between "late" and "gone".
 *
 * The difference decides whether the user was charged, so it is settled by asking the chain. If
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
    // Two different failures arrive here and only one of them means the transaction is in trouble:
    // the wait timing out, and the endpoint refusing the *query* that was checking on it. The
    // second is common — a public endpoint rate-limits by serving an HTML page where JSON was
    // expected, which surfaces as a JSON parse error naming the transaction it was asking about.
    // Reporting either as a failed transaction is wrong: one that has already been included would
    // be announced to the user as an error while their money moved.
    //
    // The hash is in both messages, so both are answered the same way — by asking the chain.
    const hash = /([0-9A-Fa-f]{64})/.exec((err as Error).message)?.[1];
    if (!hash) throw err;

    // Patient on purpose. If the endpoint is rate-limiting, the answer arrives once the window
    // passes, and giving up early would turn a throttled query into a reported loss.
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, attempt < 2 ? 6000 : 12000));
      // A throttled or failed lookup is "not known yet", not "not there" — the loop simply asks
      // again, which is the whole reason it is patient.
      const found = await readClient.query.getTx(hash).catch(() => null);
      if (found) return found;
    }

    markQuote(quote.quote_id, "dropped");
    clearCachedNativeMessages(quote.quote_id);
    throw new SubmitError(
      `the transaction (${hash}) never reached a block — nothing was spent and your balance is untouched. ` +
        "The endpoint accepted it and then dropped it; request a fresh quote and try again.",
      "not_broadcast",
    );
  }
}

/** One field out of the stored quote blob, without pretending to know the rest of its shape. */
function readQuoteField(signDocJson: string, field: string): string | null {
  try {
    const value = (JSON.parse(signDocJson) as Record<string, unknown>)[field];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function markQuote(quoteId: string, status: string) {
  db.prepare(`UPDATE quotes SET status = ? WHERE quote_id = ?`).run(status, quoteId);
}
