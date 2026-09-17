// Rate limiting for /quote and /submit (plan: "Bezpečnost" — both endpoints cost the server its
// own RPC round-trips against the chain, the same resource-exhaustion concern as a public
// simulate endpoint, just against this server's own infra instead). A simple in-memory
// fixed-window counter is enough at this project's scale (single process, ~1 tx/minute expected
// — see plan "Architektura serveru"); a shared/distributed limiter would only matter with
// multiple server processes, which this phase explicitly doesn't have.
interface Window {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  private windows = new Map<string, Window>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  // Returns true if the request is allowed (and counts it), false if the key is over its limit
  // for the current window.
  allow(key: string): boolean {
    const now = Date.now();
    const w = this.windows.get(key);
    if (!w || now - w.windowStart >= this.windowMs) {
      this.windows.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (w.count >= this.limit) return false;
    w.count++;
    return true;
  }

  // Prevents the map from growing forever under many distinct keys (rotating IPs, one-shot
  // addresses) — call periodically, not on every request.
  sweep(): void {
    const now = Date.now();
    for (const [key, w] of this.windows) {
      if (now - w.windowStart >= this.windowMs) this.windows.delete(key);
    }
  }
}
