// Password-based encryption for the provider's mnemonic, and password hashing for the admin
// login. Node's own crypto only — no new dependency for something this security-sensitive.
//
// scrypt is used for both. Its cost parameters are deliberately the expensive kind: this runs
// once at boot and once per login, never per request, so there is no throughput reason to weaken
// them.
import { randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from "node:crypto";

// N=2^16 costs roughly 100ms and ~64MB per derivation here. maxmem has to be raised explicitly
// because Node's default (32MB) is below what this N needs, and scryptSync throws rather than
// silently using less.
const SCRYPT_PARAMS = { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LEN, SCRYPT_PARAMS);
}

/**
 * Encrypts with AES-256-GCM under a key derived from `password`. The salt and IV are random per
 * call and stored alongside the ciphertext, so the same secret encrypted twice never produces
 * the same blob.
 */
export function encryptWithPassword(plaintext: string, password: string): string {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(password, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [salt.toString("base64"), iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(
    ".",
  );
}

/** Throws if the password is wrong — GCM's auth tag makes that detection reliable, not a guess. */
export function decryptWithPassword(blob: string, password: string): string {
  const [saltB64, ivB64, tagB64, ciphertextB64] = blob.split(".");
  if (!saltB64 || !ivB64 || !tagB64 || !ciphertextB64) throw new Error("malformed encrypted blob");

  const decipher = createDecipheriv("aes-256-gcm", deriveKey(password, Buffer.from(saltB64, "base64")), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("wrong password (or corrupted data)");
  }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN);
  return `${salt.toString("base64")}.${deriveKey(password, salt).toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltB64, expectedB64] = stored.split(".");
  if (!saltB64 || !expectedB64) return false;
  const expected = Buffer.from(expectedB64, "base64");
  const actual = deriveKey(password, Buffer.from(saltB64, "base64"));
  // Constant-time — a length-safe compare first, since timingSafeEqual throws on mismatched sizes.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}
