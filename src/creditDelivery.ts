// Delivering the credits someone has already paid for.
//
// The purchase cannot be atomic. The buyer signs one transaction paying sSCRT; the credits come
// from SCRT the provider pays into the vault, which only the provider can sign for, and secretjs
// signs for one wallet per transaction. So money moves first and credits follow, seconds later.
//
// That gap cannot be closed with cryptography here, so it is closed operationally: the paid
// purchase is written down before delivery is attempted, retried until it lands, and visible to
// the operator for as long as it has not. The buyer holds an on-chain receipt throughout.
//
// The one thing this must never do is deliver twice. A second purchase for the same grantee does
// not fail -- the vault reads the live remainder and grants the sum -- so a duplicate is not a
// harmless no-op, it is the provider paying again. Hence the split below between a crash before
// the broadcast (safe to retry, and what almost every crash is) and a crash during it (unknown,
// and handed to a human rather than guessed at).
import { db } from "./db.js";
import { buyCreditsFor, GAS_BUY } from "./gasVault.js";
import { config } from "./config.js";
import { deletePermit } from "./onboarding.js";
import { readClient } from "./chain.js";

/** After this many failed attempts a purchase stops retrying and waits for the operator. */
const MAX_ATTEMPTS = 10;
/** A delivery left mid-broadcast for longer than this is no longer assumed to be in flight. */
const IN_FLIGHT_GRACE_SECONDS = 600;

export type PurchaseState = "paid" | "delivering" | "delivered" | "failed" | "needs_review";

export interface PurchaseRow {
  quote_id: string;
  address: string;
  sscrt_paid: string;
  credits_uscrt: string;
  payment_tx_hash: string;
  delivery_tx_hash: string | null;
  state: PurchaseState;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Write down that the money arrived, before anything is spent answering for it. */
export function recordPurchase(params: {
  quoteId: string;
  address: string;
  sscrtPaid: string;
  creditsUscrt: string;
  paymentTxHash: string;
}): void {
  db.prepare(
    `INSERT INTO credit_purchases (quote_id, address, sscrt_paid, credits_uscrt, payment_tx_hash)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(quote_id) DO NOTHING`,
  ).run(params.quoteId, params.address, params.sscrtPaid, params.creditsUscrt, params.paymentTxHash);
}

export function getPurchase(quoteId: string): PurchaseRow | undefined {
  return db.prepare(`SELECT * FROM credit_purchases WHERE quote_id = ?`).get(quoteId) as
    | PurchaseRow
    | undefined;
}

/** Everything not yet delivered, newest first -- what the dashboard shows and the sweep works on. */
export function outstandingPurchases(): PurchaseRow[] {
  return db
    .prepare(`SELECT * FROM credit_purchases WHERE state != 'delivered' ORDER BY created_at DESC`)
    .all() as PurchaseRow[];
}

/**
 * Book the sale and forget the buyer.
 *
 * The delivery transaction's hash is deliberately not kept. It is public, and it names the
 * grantee, so writing it beside the amount would turn the ledger back into the record of who
 * transacts here that dropping the address was meant to end.
 */
function settle(purchase: PurchaseRow): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO sales_ledger (sscrt_received, credits_sold_uscrt, native_fee_spent_uscrt)
       VALUES (?, ?, ?)`,
    ).run(purchase.sscrt_paid, purchase.credits_uscrt, deliveryFeeUscrt());
    db.prepare(`DELETE FROM credit_purchases WHERE quote_id = ?`).run(purchase.quote_id);
  })();
  // The permit existed for one reason: to check this buyer could pay before the provider spent
  // anything on them. They have paid. Keeping it would leave the server able to read their
  // balance for as long as the row survived, for no remaining purpose.
  deletePermit(purchase.address);
}

/** What one delivery costs the provider. Cosmos charges the limit, not the usage. */
function deliveryFeeUscrt(): string {
  return String(Math.ceil(GAS_BUY * config.nativeGasPriceUscrt));
}

function setState(
  quoteId: string,
  state: PurchaseState,
  patch: { last_error?: string; delivery_tx_hash?: string } = {},
): void {
  db.prepare(
    `UPDATE credit_purchases
        SET state = ?,
            last_error = ?,
            delivery_tx_hash = COALESCE(?, delivery_tx_hash),
            updated_at = datetime('now')
      WHERE quote_id = ?`,
  ).run(state, patch.last_error ?? null, patch.delivery_tx_hash ?? null, quoteId);
}

/**
 * Deliver one purchase, if it is still waiting.
 *
 * The claim is a conditional update, so two callers racing -- the /submit path and the periodic
 * sweep, say -- cannot both take the same row. Returns false when there was nothing to do.
 */
export async function deliverPurchase(quoteId: string): Promise<boolean> {
  const claimed = db
    .prepare(
      `UPDATE credit_purchases
          SET state = 'delivering', attempts = attempts + 1, updated_at = datetime('now')
        WHERE quote_id = ? AND state IN ('paid', 'failed')`,
    )
    .run(quoteId);
  if (claimed.changes === 0) return false;

  const purchase = getPurchase(quoteId);
  if (!purchase) return false;

  try {
    const result = await buyCreditsFor(purchase.address, purchase.credits_uscrt);
    if (result.code !== 0) {
      throw new Error(`the vault rejected the purchase (code ${result.code}): ${result.rawLog}`);
    }
    settle(purchase);
    return true;
  } catch (err) {
    const message = (err as Error).message;

    // A broadcast that threw may still have reached a block -- the same failure mode /submit
    // handles. If a hash is recoverable from the error, settle it by asking the chain rather than
    // assuming either way, because assuming "it failed" here means paying twice.
    const hash = /([0-9A-Fa-f]{64})/.exec(message)?.[1];
    if (hash) {
      const found = await readClient.query.getTx(hash).catch(() => null);
      if (found && found.code === 0) {
        settle(purchase);
        return true;
      }
      if (!found) {
        setState(quoteId, "needs_review", {
          last_error:
            `broadcast as ${hash} but not found on chain — confirm before retrying, ` +
            "because a second delivery grants a second time",
          delivery_tx_hash: hash,
        });
        return false;
      }
    }

    setState(quoteId, purchase.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "paid", {
      last_error: message,
    });
    return false;
  }
}

/**
 * Work through everything outstanding. Called after a payment lands, periodically, and at boot.
 *
 * Sequential, not parallel: every delivery is a transaction from the provider's own account, and
 * two in flight at once race its sequence number.
 */
export async function deliverPending(): Promise<{ delivered: number; remaining: number }> {
  releaseStalledDeliveries();

  const waiting = db
    .prepare(`SELECT quote_id FROM credit_purchases WHERE state = 'paid' ORDER BY created_at`)
    .all() as { quote_id: string }[];

  let delivered = 0;
  for (const { quote_id } of waiting) {
    if (await deliverPurchase(quote_id)) delivered += 1;
  }

  const remaining = (
    db.prepare(`SELECT COUNT(*) AS n FROM credit_purchases WHERE state != 'delivered'`).get() as {
      n: number;
    }
  ).n;

  return { delivered, remaining };
}

/**
 * A row still marked `delivering` after a restart was interrupted somewhere, and where matters.
 *
 * Almost always the process died before the broadcast went out, in which case retrying is both
 * safe and necessary. But "almost always" is not a basis for spending money, and nothing in the
 * row says which side of the broadcast it stopped on. So these are handed to the operator rather
 * than retried -- a stuck purchase is visible and fixable, a double grant is neither.
 */
function releaseStalledDeliveries(): void {
  db.prepare(
    `UPDATE credit_purchases
        SET state = 'needs_review',
            last_error = 'interrupted mid-delivery; confirm on chain whether the credits arrived before retrying',
            updated_at = datetime('now')
      WHERE state = 'delivering'
        AND updated_at < datetime('now', ?)`,
  ).run(`-${IN_FLIGHT_GRACE_SECONDS} seconds`);
}

/** Operator override: put a reviewed purchase back in the queue. */
export function requeuePurchase(quoteId: string): boolean {
  return (
    db
      .prepare(
        `UPDATE credit_purchases SET state = 'paid', last_error = NULL, attempts = 0,
                updated_at = datetime('now')
          WHERE quote_id = ? AND state IN ('failed', 'needs_review')`,
      )
      .run(quoteId).changes > 0
  );
}

/** Operator override: a purchase confirmed delivered by hand, or written off. */
export function closePurchase(quoteId: string): boolean {
  const purchase = getPurchase(quoteId);
  if (!purchase) return false;
  settle(purchase);
  return true;
}
