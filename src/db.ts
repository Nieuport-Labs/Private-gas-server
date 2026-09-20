// SQLite storage. At roughly a transaction a minute this is deliberately not a database service.
//
// Seven tables, and the shortness is the point. Earlier designs needed a per-address deposit
// ledger, a record of every sponsored transaction and a two-stage grant; none of those exist any
// more, so none of them are here. What a table costs is not disk, it is the standing question of
// what is in it and why -- and for the three that held user data, the answer had stopped being
// "because it is needed".
//
// dataPurge.ts clears the old ones out of a database that predates this file.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

// A missing directory is not a reason to refuse to start. better-sqlite3 will create the file
// but not the path to it, and in a container the path is usually a mount that exists -- until
// somebody runs the image without one and gets a stack trace instead of a server.
mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
-- The one-transaction allowance a cold address gets so it can sign its first purchase. It
-- expires in minutes and is never raised: there is no second stage any more, because after the
-- purchase the buyer pays from the vault and the provider is out of the picture.
CREATE TABLE IF NOT EXISTS grants (
  address TEXT PRIMARY KEY,
  spend_limit_uscrt TEXT NOT NULL,
  expires_at TEXT NOT NULL,       -- RFC3339, mirrors the on-chain allowance's expiration
  allowed_messages TEXT NOT NULL, -- JSON array, mirrors on-chain AllowedMsgAllowance
  grant_tx_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The buyer's SNIP-24 permit, held for exactly as long as the purchase it is needed for.
-- Deleted the moment the credits land: it buys one thing, knowing the payment will not bounce
-- before the provider spends its own gas, and that need ends.
CREATE TABLE IF NOT EXISTS permits (
  address TEXT PRIMARY KEY,
  permit_json TEXT NOT NULL,      -- scope: ["balance"] only
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A quote lives for its TTL and a little past it, so /submit can say "this expired" rather than
-- "no such quote". pruneExpired drops it after that.
CREATE TABLE IF NOT EXISTS quotes (
  quote_id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  account_number INTEGER NOT NULL,
  sign_doc_json TEXT NOT NULL,    -- the exact bytes quoted, which /submit compares against
  sscrt_payment_amount TEXT NOT NULL,
  gas_limit INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued', -- issued | submitted | expired | rejected | dropped
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A purchase that is paid for and not yet delivered.
--
-- Delivery is a second transaction, signed by the provider, because the SCRT paid into the vault
-- has to come from the provider and secretjs signs for one wallet. So there is a window where
-- the money is in and the credits are not, and this closes it: durable before anything is spent,
-- retried until it lands, visible to the operator while it has not.
--
-- The only place a buyer's address survives the payment, and it is deleted on delivery. What
-- remains is the amount, in sales_ledger, with nobody's name on it.
CREATE TABLE IF NOT EXISTS credit_purchases (
  quote_id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  sscrt_paid TEXT NOT NULL,
  credits_uscrt TEXT NOT NULL,
  payment_tx_hash TEXT NOT NULL,
  delivery_tx_hash TEXT,
  state TEXT NOT NULL DEFAULT 'paid', -- paid | delivering | delivered | failed | needs_review
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What the provider earned and spent, with no record of who from. The totals were all the
-- accounting ever needed; the addresses beside them were an index of who transacts here that the
-- chain does not hand out nearly so conveniently.
CREATE TABLE IF NOT EXISTS sales_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sscrt_received TEXT NOT NULL,
  credits_sold_uscrt TEXT NOT NULL,
  native_fee_spent_uscrt TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The provider redeeming its own accumulated sSCRT back into the native SCRT it pays with.
CREATE TABLE IF NOT EXISTS auto_unwraps (
  tx_hash TEXT PRIMARY KEY,
  sscrt_balance_before TEXT NOT NULL, -- also the amount redeemed; it always redeems in full
  code INTEGER,
  raw_log TEXT,
  triggered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Gas for a contract call cannot be simulated on Secret at all, so the payment message's cost is
-- a measured constant under the key "sscrt_payment_transfer".
CREATE TABLE IF NOT EXISTS calibration (
  key TEXT PRIMARY KEY,
  gas_constant INTEGER NOT NULL,
  measured_at TEXT NOT NULL DEFAULT (datetime('now')),
  sample_gas_used TEXT NOT NULL   -- JSON array of raw samples, kept so the figure is auditable
);

-- The provider's mnemonic, encrypted with a key derived from the admin password (crypto.ts), so
-- a copy of this file alone does not yield the seed.
CREATE TABLE IF NOT EXISTS secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,            -- salt.iv.tag.ciphertext, all base64
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Operator settings, editable from the dashboard. Env vars seed the initial values on first
-- boot; after that this is the source of truth, so a change made in the UI survives a restart
-- without editing container config.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/** True when a table exists — a database from an earlier design has some this one never creates. */
export function tableExists(name: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
    undefined
  );
}
