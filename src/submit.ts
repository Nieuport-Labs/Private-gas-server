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
import { getStoredPermit } from "./onboarding.js";
import { simulateNativeMessages } from "./gasEstimation.js";
import { getCachedNativeMessages, clearCachedNativeMessages } from "./quote.js";
import { config } from "./config.js";

export class SubmitError extends Error {
  constructor(
    message: string,
    public code:
      | "not_found"
      | "expired"
      | "already_submitted"
      | "sequence_changed"
      | "insufficient_balance"
      | "native_action_would_fail",
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
    if (balance < BigInt(quote.sscrt_payment_amount)) {
      markQuote(quoteId, "expired");
      clearCachedNativeMessages(quoteId);
      throw new SubmitError(
        `sSCRT balance dropped below the quoted payment (have ${balance}, need ${quote.sscrt_payment_amount})`,
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

  const tx = await readClient.tx.broadcastSignedTx(signedTxBytes, {
    gasLimit: quote.gas_limit,
    broadcastCheckIntervalMs: 3000,
  });

  const nativeFeeSpentUscrt = String(Math.ceil(quote.gas_limit * config.nativeGasPriceUscrt)); // ante-committed regardless of message outcome
  const sscrtReceived = tx.code === 0 ? quote.sscrt_payment_amount : "0";

  db.prepare(
    `INSERT INTO tx_outcomes (tx_hash, quote_id, address, code, native_fee_spent_uscrt, sscrt_received, raw_log)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(tx.transactionHash, quoteId, quote.address, tx.code, nativeFeeSpentUscrt, sscrtReceived, tx.rawLog ?? "");

  return {
    txHash: tx.transactionHash,
    code: tx.code,
    rawLog: tx.rawLog ?? "",
    nativeFeeSpentUscrt,
    sscrtReceived,
  };
}

function markQuote(quoteId: string, status: string) {
  db.prepare(`UPDATE quotes SET status = ? WHERE quote_id = ?`).run(status, quoteId);
}
