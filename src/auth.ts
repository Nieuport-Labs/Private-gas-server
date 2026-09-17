// Password gate for the dashboard and every admin action.
//
// Bearer tokens in a header, not a session cookie: the public API (/quote, /submit, /status) is
// deliberately CORS-open for browser dApp clients, and a cookie combined with that would be a
// CSRF hole — any page the operator visits could drive the admin API with their session attached.
// A token the page has to read from storage and set explicitly cannot be replayed that way.
//
// Sessions live in memory only, so a restart logs everyone out. That is the right default for a
// single-operator admin panel and needs no storage. Note that a restart does *not* lock the
// secret store — the server unlocks itself from the keyfile (see secretStore.ts), so sponsoring
// continues uninterrupted while the operator simply signs in again to look at it.
import { config } from "./config.js";
import { randomToken } from "./crypto.js";
import { checkPassword, unlockWithPassword, isUnlocked, ensureKeyfile } from "./secretStore.js";
import { initWallet } from "./wallet.js";

const sessions = new Map<string, number>(); // token -> expiry epoch ms

export function login(password: string): string | null {
  if (!checkPassword(password)) return null;

  // Normally already unlocked from the keyfile at boot. This covers the case where the keyfile
  // was lost or never written: the password can still unlock the store, and the wallet is loaded
  // as soon as it can be.
  if (!isUnlocked() && unlockWithPassword(password)) initWallet();
  ensureKeyfile();

  const token = randomToken();
  sessions.set(token, Date.now() + config.adminSessionTtlSeconds * 1000);
  return token;
}

export function logout(token: string): void {
  sessions.delete(token);
}

/** Invalidates every session — used after a password change, so old tokens don't outlive it. */
export function logoutAll(): void {
  sessions.clear();
}

export function isValidSession(token: string | undefined): boolean {
  if (!token) return false;
  const expiry = sessions.get(token);
  if (expiry === undefined) return false;
  if (Date.now() > expiry) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function issueSession(): string {
  const token = randomToken();
  sessions.set(token, Date.now() + config.adminSessionTtlSeconds * 1000);
  return token;
}

/** Extracts the token from an `Authorization: Bearer <token>` header. */
export function tokenFromHeader(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim() || undefined;
}

export function sweepSessions(): void {
  const now = Date.now();
  for (const [token, expiry] of sessions) {
    if (now > expiry) sessions.delete(token);
  }
}
