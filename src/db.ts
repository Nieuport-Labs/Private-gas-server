// SQLite storage. At the plan's expected scale (~1 tx/minute) this is deliberately not a
// separate database service — see plan "Úložiště".
import Database from "better-sqlite3";
import { config } from "./config.js";

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS grants (
  address TEXT PRIMARY KEY,
  spend_limit_uscrt TEXT NOT NULL,
  expires_at TEXT NOT NULL,      -- RFC3339, mirrors the on-chain allowance's expiration
  allowed_messages TEXT NOT NULL, -- JSON array, mirrors on-chain AllowedMsgAllowance
  grant_tx_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS permits (
  address TEXT PRIMARY KEY,
  permit_json TEXT NOT NULL,      -- the full SNIP-24 Permit object, scope: ["balance"] only
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quotes (
  quote_id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  account_number INTEGER NOT NULL,
  sign_doc_json TEXT NOT NULL,    -- exact unsigned SignDoc handed back to the client
  sscrt_payment_amount TEXT NOT NULL,
  gas_limit INTEGER NOT NULL,
  expires_at TEXT NOT NULL,       -- now + quoteTtlSeconds; enforced again at /submit
  status TEXT NOT NULL DEFAULT 'issued', -- issued | submitted | expired
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tx_outcomes (
  tx_hash TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL,
  address TEXT NOT NULL,
  code INTEGER,                   -- CheckTx/DeliverTx code; 0 = success
  native_fee_spent_uscrt TEXT,    -- what the grant paid, ante-committed regardless of outcome
  sscrt_received TEXT,            -- what the payment message actually delivered, if it landed
  raw_log TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auto_unwraps (
  tx_hash TEXT PRIMARY KEY,
  sscrt_balance_before TEXT NOT NULL, -- also the amount redeemed — auto-unwrap always redeems in full
  code INTEGER,                       -- CheckTx/DeliverTx code; 0 = success
  raw_log TEXT,
  triggered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Gas constants for message shapes that can't be simulated on Secret (MsgExecuteContract of any
-- kind — see gasEstimation.ts). "key" is either the fixed string "sscrt_payment_transfer" (the
-- payment leg every quote includes) or a whitelisted contract address (gasCalibration.ts).
CREATE TABLE IF NOT EXISTS calibration (
  key TEXT PRIMARY KEY,
  gas_constant INTEGER NOT NULL,
  measured_at TEXT NOT NULL DEFAULT (datetime('now')),
  sample_gas_used TEXT NOT NULL -- JSON array of raw samples, kept for audit
);

-- Encrypted at rest (see crypto.ts). Holds the provider's mnemonic under key 'provider_mnemonic'.
-- Encrypted with a key derived from ADMIN_PASSWORD, so a copy of this database file alone does
-- not yield the seed.
CREATE TABLE IF NOT EXISTS secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,            -- salt.iv.tag.ciphertext, all base64
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Operator-tunable settings, editable from the dashboard. Env vars seed the initial values on
-- first boot (see settings.ts); after that this table is the source of truth, so a change made
-- in the UI survives a restart without editing container config.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS deposits (
  address TEXT PRIMARY KEY,
  remaining_uscrt TEXT NOT NULL,   -- how much failure this address can still absorb
  total_paid_uscrt TEXT NOT NULL DEFAULT '0',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Additive migrations. `CREATE TABLE IF NOT EXISTS` above leaves an existing database untouched,
// so a new column has to be added explicitly — and idempotently, since this runs on every boot.
// SQLite has no `ADD COLUMN IF NOT EXISTS`, and a duplicate column is the expected outcome on
// every boot after the first, so that one error is swallowed and nothing else is.
function addColumn(table: string, definition: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  } catch (err) {
    if (!/duplicate column name/i.test((err as Error).message)) throw err;
  }
}

// Which half of the two-stage grant an address is on: `bootstrap` covers exactly its first
// transaction, `full` is the real spend limit. Existing rows default to `full` with the fee
// treated as collected — they were granted under the old rules and must not be billed
// retroactively for something they were never told about.
addColumn("grants", "stage TEXT NOT NULL DEFAULT 'full'");
addColumn("grants", "fee_collected INTEGER NOT NULL DEFAULT 1");
