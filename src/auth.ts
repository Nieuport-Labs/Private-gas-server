// Password gate for the dashboard and every admin action.
//
// Bearer tokens in a header, not a session cookie: the public API (/quote, /submit, /status) is
// deliberately CORS-open for browser dApp clients, and a cookie combined with that would be a
// CSRF hole — any page the operator visits could drive the admin API with their session attached.
// A token the page has to read from storage and set explicitly cannot be replayed that way.
//
// Sessions live in memory only, so a restart logs everyone out. That is the right default for a
// single-operator admin panel and needs no storage.
import { config } from "./config.js";
import { verifyPassword, hashPassword, randomToken } from "./crypto.js";

const passwordHash = hashPassword(config.adminPassword);

const sessions = new Map<string, number>(); // token -> expiry epoch ms

export function login(password: string): string | null {
  if (!verifyPassword(password, passwordHash)) return null;
  const token = randomToken();
  sessions.set(token, Date.now() + config.adminSessionTtlSeconds * 1000);
  return token;
}

export function logout(token: string): void {
  sessions.delete(token);
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
