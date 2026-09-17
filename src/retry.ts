// Retry for transient RPC failures.
//
// Public LCD endpoints answer a meaningful fraction of requests with an HTML error page instead
// of JSON — a real calibration run lost 9 of 10 samples that way. Most of those pages turned out
// to be "429 Too Many Requests": the endpoint rate-limits, and does it in HTML, so it reaches the
// caller as a JSON parse error rather than anything resembling a 429.
//
// Only ever wrap reads. A retried query costs nothing but a round trip; a retried broadcast could
// put the same transaction on chain twice, so nothing here is used for one.
// Rate limiting deserves a much longer backoff than an ordinary blip: retrying after a few
// hundred milliseconds only spends more of a budget that is already gone.
//
// It cannot be identified by its own words, though. The endpoint serves "429 Too Many Requests"
// as an HTML page, and by the time that reaches here it is a JSON parse error whose text has been
// truncated to `"<html><bod"...` — the status code never appears. So an HTML page where JSON was
// expected is treated as rate limiting, which in this setting it nearly always is. Waiting a few
// seconds on the rarer genuine 502 costs nothing.
const RATE_LIMITED = ["429", "Too Many Requests", "invalid json response body", "Unexpected token '<'"];

const TRANSIENT = [
  "invalid json response body", // an HTML error page where JSON was expected
  "Unexpected token '<'",
  "429",
  "Too Many Requests",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "socket hang up",
  "network timeout",
  "fetch failed",
  "502",
  "503",
  "504",
];

export function isTransient(err: unknown): boolean {
  const message = (err as Error)?.message ?? String(err);
  return TRANSIENT.some((m) => message.includes(m));
}

export function isRateLimited(err: unknown): boolean {
  const message = (err as Error)?.message ?? String(err);
  return RATE_LIMITED.some((m) => message.includes(m));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs an idempotent read, retrying transient transport failures with a short backoff. Anything
 * that isn't transient — a real chain error, a bad argument — is rethrown immediately, since
 * retrying it would only delay the same answer.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 400): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransient(err) || attempt === attempts - 1) throw err;
      const delay = isRateLimited(err) ? 3000 * (attempt + 1) : baseDelayMs * 2 ** attempt;
      await sleep(delay);
    }
  }
  throw lastError;
}
