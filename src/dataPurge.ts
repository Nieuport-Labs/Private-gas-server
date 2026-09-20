// Deleting what this server no longer has a reason to hold.
//
// The move to gas credits removed the *reasons* for most of what is in this database, but not
// the data. What is already here was written under the old design and is more sensitive than
// anything the new one produces:
//
//   - `quotes.sign_doc_json` holds each sponsored bundle in amino, which means the recipient and
//     amount of every transfer that ever went through this server. It is the worst of it.
//   - `permits` holds live SNIP-24 signatures. While a row exists, this server can read that
//     address's private balance at any time, for a purpose that ended.
//   - `tx_outcomes` maps address to transaction hash to timestamp. All three are public on chain;
//     the index tying them together was not, and this server had no business building one.
//   - `deposits` is the ledger of a mechanism that no longer exists.
//
// None of that is removed by shipping new code, which is why this is its own module with its own
// button rather than a side effect of the refactor.
//
// Two operations, deliberately distinct. `purgeLegacyData` is the one-off clear-out, run once
// against an existing database. `pruneExpired` is the ongoing retention that keeps the new design
// from accumulating the same thing again.
import { db, tableExists } from "./db.js";

/**
 * Tables an earlier design created and this one does not.
 *
 * A database that never held them is the normal case now, so every read and delete has to
 * tolerate their absence rather than throw. They are still named here because the ones that do
 * exist are the most sensitive rows on the server.
 */
const LEGACY_TABLES = ["tx_outcomes", "deposits"] as const;

export interface PurgeCounts {
  permits: number;
  quotes: number;
  txOutcomes: number;
  deposits: number;
  grants: number;
  contractCalibrations: number;
  settings: number;
}

/** Counts a table that may not exist. Absent is zero, not an error. */
function countIfPresent(table: string, where = ""): number {
  if (!tableExists(table)) return 0;
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number }).n;
}

/** What a purge would delete, so the operator sees it before pressing the button. */
export function describeLegacyData(): PurgeCounts {
  return {
    permits: countIfPresent("permits"),
    quotes: countIfPresent("quotes"),
    txOutcomes: countIfPresent("tx_outcomes"),
    deposits: countIfPresent("deposits"),
    grants: countIfPresent("grants", `WHERE expires_at < datetime('now')`),
    contractCalibrations: countIfPresent("calibration", `WHERE key != 'sscrt_payment_transfer'`),
    settings: countIfPresent(
      "settings",
      `WHERE key IN ('allowed_contract_addresses', 'security_deposit_uscrt',
                     'grant_spend_limit_uscrt', 'grant_expiry_seconds')`,
    ),
  };
}

/**
 * Clear out everything the new design has no use for.
 *
 * Irreversible, and meant to be. One transaction so a half-purge is not a state this can end in.
 *
 * A live purchase keeps its permit: `credit_purchases` rows are buyers who have paid and not yet
 * been delivered to, and /submit re-checks the balance through that permit. Deleting it mid-flight
 * would break the delivery this is not supposed to touch.
 */
export function purgeLegacyData(): { deleted: PurgeCounts; vacuumed: boolean } {
  const before = describeLegacyData();

  db.transaction(() => {
    db.prepare(
      `DELETE FROM permits
        WHERE address NOT IN (SELECT address FROM credit_purchases WHERE state != 'delivered')`,
    ).run();
    db.prepare(`DELETE FROM quotes`).run();
    // Expired grants are dead on chain too. A live one stays: an address mid-purchase is using
    // it right now.
    db.prepare(`DELETE FROM grants WHERE expires_at < datetime('now')`).run();
    db.prepare(`DELETE FROM calibration WHERE key != 'sscrt_payment_transfer'`).run();
    db.prepare(
      `DELETE FROM settings WHERE key IN ('allowed_contract_addresses', 'security_deposit_uscrt',
                                          'grant_spend_limit_uscrt', 'grant_expiry_seconds')`,
    ).run();
    // Tables this design never creates. Dropped outright rather than emptied — an empty table
    // nobody writes to is a standing question about what used to be in it.
    for (const table of LEGACY_TABLES) {
      if (tableExists(table)) db.exec(`DROP TABLE ${table}`);
    }
  })();

  // Without this the rows are unlinked but their pages stay in the file, readable by anyone who
  // opens it -- and the file is exactly what sits on the host's disk. VACUUM cannot run inside a
  // transaction, hence its position here.
  let vacuumed = true;
  try {
    db.exec(`VACUUM`);
  } catch {
    // A locked database can refuse it. The rows are still gone; the file just has not shrunk, and
    // saying so is better than claiming a scrub that did not happen.
    vacuumed = false;
  }

  return { deleted: before, vacuumed };
}

/**
 * Ongoing retention. Cheap enough to run beside the auto-unwrap sweep.
 *
 * Quotes are kept a little past expiry rather than deleted the moment they lapse, because
 * /submit answers "this quote expired" out of the row and deleting it turns a clear message into
 * "no such quote".
 */
export function pruneExpired(): { quotes: number; grants: number } {
  const quotes = db
    .prepare(`DELETE FROM quotes WHERE expires_at < datetime('now', '-1 hour')`)
    .run().changes;
  const grants = db.prepare(`DELETE FROM grants WHERE expires_at < datetime('now')`).run().changes;
  return { quotes, grants };
}
