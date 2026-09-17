// Where the admin password and the key that protects the provider's seed live.
//
// The seed is not encrypted under the password directly. A random 32-byte **data key** encrypts
// the seed, and that data key is then stored two ways:
//
//   1. wrapped with a key derived from the admin password (in the database), so the operator can
//      always unlock with what they know, and so changing the password is just a re-wrap rather
//      than re-encrypting — or losing — the seed;
//   2. as a file next to the database (`.unlock.key`, mode 0600), so the server can unlock itself
//      after a restart with nobody present.
//
// What that is worth, precisely: the database on its own — a copy, a backup, a stolen snapshot —
// cannot yield the seed, because the data key is not in it in usable form. Whoever holds the
// whole data directory can decrypt, because that is exactly what the server itself does at boot.
// Unattended restart and "nothing on the disk can decrypt this" are mutually exclusive; this
// setup takes the former, which is what was asked for, and is honest about the latter.
import { writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { db } from "./db.js";
import { config } from "./config.js";
import {
  randomKey,
  hashPassword,
  verifyPassword,
  encryptWithPassword,
  decryptWithPassword,
} from "./crypto.js";

const PASSWORD_HASH_KEY = "admin_password_hash";
const WRAPPED_DATA_KEY = "wrapped_data_key";

const keyfilePath = join(dirname(config.dbPath), ".unlock.key");

let dataKey: Buffer | null = null;

function readMeta(key: string): string | null {
  return (db.prepare(`SELECT value FROM secrets WHERE key = ?`).get(key) as { value: string } | undefined)?.value ?? null;
}

function writeMeta(key: string, value: string): void {
  db.prepare(
    `INSERT INTO secrets (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value);
}

export function isSetUp(): boolean {
  return readMeta(PASSWORD_HASH_KEY) !== null;
}

export function isUnlocked(): boolean {
  return dataKey !== null;
}

export class NotSetUpError extends Error {
  readonly code = "not_set_up";
  constructor() {
    super("no admin password set yet — complete first-run setup");
  }
}

export class LockedError extends Error {
  readonly code = "locked";
  constructor() {
    super("secret store is locked — sign in to unlock");
  }
}

export function getDataKey(): Buffer {
  if (!dataKey) throw new LockedError();
  return dataKey;
}

function persistKeyfile(key: Buffer): void {
  writeFileSync(keyfilePath, key.toString("base64"), { mode: 0o600 });
  try {
    chmodSync(keyfilePath, 0o600); // no-op on Windows; the mode above already covers POSIX
  } catch {
    /* best effort — an unsupported chmod must not stop the server from starting */
  }
}

export class PasswordTooShortError extends Error {
  readonly code = "password_too_short";
  constructor(min: number) {
    super(`password must be at least ${min} characters`);
  }
}

export const MIN_PASSWORD_LENGTH = 12;

/** First-run setup. Refuses to silently replace an existing password. */
export function setup(password: string): void {
  if (isSetUp()) throw new Error("already set up");
  if (password.length < MIN_PASSWORD_LENGTH) throw new PasswordTooShortError(MIN_PASSWORD_LENGTH);

  const key = randomKey();
  db.transaction(() => {
    writeMeta(PASSWORD_HASH_KEY, hashPassword(password));
    writeMeta(WRAPPED_DATA_KEY, encryptWithPassword(key.toString("base64"), password));
  })();
  persistKeyfile(key);
  dataKey = key;
}

export function checkPassword(password: string): boolean {
  const stored = readMeta(PASSWORD_HASH_KEY);
  return stored !== null && verifyPassword(password, stored);
}

/**
 * Rewrites the keyfile if it has gone missing while the key is held in memory (a stray delete, a
 * restored backup that omitted dotfiles). Without this the running server would carry on fine and
 * then come back locked after the next restart, which is the worst time to discover it.
 */
export function ensureKeyfile(): void {
  if (!dataKey || existsSync(keyfilePath)) return;
  persistKeyfile(dataKey);
}

/** Unlocks from the password — the path that still works if the keyfile is lost. */
export function unlockWithPassword(password: string): boolean {
  const wrapped = readMeta(WRAPPED_DATA_KEY);
  if (!wrapped || !checkPassword(password)) return false;
  try {
    const key = Buffer.from(decryptWithPassword(wrapped, password), "base64");
    persistKeyfile(key); // restores the keyfile if it went missing, so the next restart is unattended again
    dataKey = key;
    return true;
  } catch {
    return false;
  }
}

/** Unlocks from the keyfile at boot. Returns false if there is nothing to unlock with. */
export function unlockWithKeyfile(): boolean {
  if (!isSetUp() || !existsSync(keyfilePath)) return false;
  try {
    const key = Buffer.from(readFileSync(keyfilePath, "utf8").trim(), "base64");
    if (key.length !== 32) return false;
    dataKey = key;
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-wraps the same data key under a new password. The seed's own ciphertext is untouched, so a
 * password change cannot orphan the wallet.
 */
export function changePassword(currentPassword: string, newPassword: string): void {
  if (!checkPassword(currentPassword)) throw new Error("current password is wrong");
  if (newPassword.length < MIN_PASSWORD_LENGTH) throw new PasswordTooShortError(MIN_PASSWORD_LENGTH);

  const wrapped = readMeta(WRAPPED_DATA_KEY);
  if (!wrapped) throw new Error("no wrapped data key on record");
  const key = Buffer.from(decryptWithPassword(wrapped, currentPassword), "base64");

  db.transaction(() => {
    writeMeta(PASSWORD_HASH_KEY, hashPassword(newPassword));
    writeMeta(WRAPPED_DATA_KEY, encryptWithPassword(key.toString("base64"), newPassword));
  })();
}

export { keyfilePath };
