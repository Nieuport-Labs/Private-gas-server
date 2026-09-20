// The per-address security deposit.
//
// Users pay for each transaction exactly as before, with the payment message inside the bundle.
// The deposit is not that payment and is never spent on one. It exists for the single case the
// payment cannot cover: a transaction that fails.
//
// When a bundle fails, the chain reverts every state change — including the payment — but the fee
// was already taken in the ante handler and does not come back. The provider is out that fee with
// nothing to show for it, and no check before broadcast can rule this out entirely: a recipient
// the contract refuses sits inside an encrypted message body, invisible until it runs.
//
// So the loss is charged to the deposit instead. The provider is covered, the cost lands on
// whoever chose the transaction, and the deposit is topped back up inside the user's next quote —
// which makes the first payment and every later top-up the same mechanism, not a special case.
//
// The deposit is not refundable and is not held in escrow. It is the provider's money from the
// moment it arrives; this is a counter tracking how much failure it has left to absorb, not a
// balance owed to anyone. That is why auto-unwrap may convert it freely.
import { db } from "./db.js";

export interface DepositRow {
  address: string;
  remaining_uscrt: string;
  total_paid_uscrt: string;
}

export function getDeposit(address: string): bigint {
  const row = db.prepare(`SELECT remaining_uscrt FROM deposits WHERE address = ?`).get(address) as
    | { remaining_uscrt: string }
    | undefined;
  return row ? BigInt(row.remaining_uscrt) : 0n;
}

export function getDepositRow(address: string): DepositRow | undefined {
  return db.prepare(`SELECT * FROM deposits WHERE address = ?`).get(address) as DepositRow | undefined;
}

/**
 * How much this quote should collect to bring the deposit back to full. Zero once it is topped up,
 * and the entire deposit on an address's first quote — one rule, no first-time branch.
 */
export function topUpNeeded(address: string, targetUscrt: string): bigint {
  const target = BigInt(targetUscrt);
  const remaining = getDeposit(address);
  return remaining >= target ? 0n : target - remaining;
}

/** Called only once the transaction carrying the top-up has actually landed. */
export function creditDeposit(address: string, amountUscrt: bigint): void {
  if (amountUscrt <= 0n) return;
  // Read, add, write — in BigInt rather than in SQL. SQLite would have to be told to treat these
  // as integers and hand them back as text, and money is not worth that round trip through a type
  // system that does not care.
  const row = getDepositRow(address);
  const remaining = (row ? BigInt(row.remaining_uscrt) : 0n) + amountUscrt;
  const totalPaid = (row ? BigInt(row.total_paid_uscrt) : 0n) + amountUscrt;
  db.prepare(
    `INSERT INTO deposits (address, remaining_uscrt, total_paid_uscrt, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(address) DO UPDATE SET
       remaining_uscrt = excluded.remaining_uscrt,
       total_paid_uscrt = excluded.total_paid_uscrt,
       updated_at = excluded.updated_at`,
  ).run(address, remaining.toString(), totalPaid.toString());
}

/**
 * Charges a failed transaction's wasted fee to the deposit. Floors at zero rather than going
 * negative: a first transaction can fail before any deposit has been paid, and there is nothing
 * to collect from an address that has given nothing — that case is the provider's known loss, and
 * pretending otherwise with a negative counter would only make the number lie.
 */
export function debitDeposit(address: string, amountUscrt: bigint): bigint {
  const remaining = getDeposit(address);
  const next = remaining > amountUscrt ? remaining - amountUscrt : 0n;
  db.prepare(
    `INSERT INTO deposits (address, remaining_uscrt, total_paid_uscrt, updated_at)
     VALUES (?, ?, '0', datetime('now'))
     ON CONFLICT(address) DO UPDATE SET remaining_uscrt = excluded.remaining_uscrt, updated_at = datetime('now')`,
  ).run(address, next.toString());
  return next;
}
