// The HTTP layer described in the plan under "Architektura serveru" — up to now every piece
// (onboarding, quote, submit) has only been exercised by directly calling these functions from
// the smoke-test scripts. This wires the same functions up to real endpoints for a client
// (dApp/Keplr flow, still out of scope for this phase) to actually call.
import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { providerAddress, getProviderBalances } from "./chain.js";
import { onboardUser } from "./onboarding.js";
import { requestQuote, QuoteError } from "./quote.js";
import { submitQuote, SubmitError } from "./submit.js";
import { decodeMessages, MessageDecodeError, type WireMessage } from "./messageRegistry.js";
import { RateLimiter } from "./rateLimit.js";
import { getLastAutoUnwrap } from "./autoUnwrap.js";
import { db } from "./db.js";
import type { Permit } from "secretjs";

// public/ sits next to both src/ and dist/ at the package root, so resolving relative to this
// module's own location works the same under tsx (src/server.ts) and the compiled build
// (dist/server.js) — no dependency on the process's cwd.
const dashboardHtml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html"), "utf-8");

function getQuoteAddress(quoteId: string): string | null {
  const row = db.prepare(`SELECT address FROM quotes WHERE quote_id = ?`).get(quoteId) as
    | { address: string }
    | undefined;
  return row?.address ?? null;
}

const QUOTE_ERROR_STATUS: Record<QuoteError["code"], number> = {
  no_grant: 404,
  message_type_not_allowed: 400,
  no_permit: 404,
  insufficient_balance: 402,
  no_pubkey: 400,
  simulate_failed: 422,
  contract_not_allowed: 403,
  contract_gas_not_calibrated: 422,
};

const SUBMIT_ERROR_STATUS: Record<SubmitError["code"], number> = {
  not_found: 404,
  expired: 410,
  already_submitted: 409,
  sequence_changed: 409,
  insufficient_balance: 402,
  native_action_would_fail: 422,
};

// Two independent rate limiters shared by /quote and /submit (plan: "per adresa/IP na obou
// endpointech") — a single flooding IP and many requests for one address spread across
// rotating IPs are different attacks, so both are checked on both routes.
const ipLimiter = new RateLimiter(config.rateLimitPerIpPerMinute, 60_000);
const addressLimiter = new RateLimiter(config.rateLimitPerAddressPerMinute, 60_000);
setInterval(
  () => {
    ipLimiter.sweep();
    addressLimiter.sweep();
  },
  5 * 60_000,
).unref();

function checkRateLimit(ip: string, address: string): string | null {
  if (!ipLimiter.allow(ip)) return `rate limit exceeded for this IP (${config.rateLimitPerIpPerMinute}/min)`;
  if (!addressLimiter.allow(address))
    return `rate limit exceeded for this address (${config.rateLimitPerAddressPerMinute}/min)`;
  return null;
}

export function buildServer() {
  const app = Fastify({ logger: true });

  // /status is meant to be read by both this server's own dashboard and eventual dApp clients
  // running in a browser on a different origin — without this, neither could call it directly.
  // No cookies/session auth exist anywhere on this server, so a blanket allow is not a new
  // exposure; it just lets already-public data be fetched cross-origin.
  app.addHook("onSend", (_req, reply, payload, done) => {
    reply.header("Access-Control-Allow-Origin", "*");
    done(null, payload);
  });

  app.get("/health", async () => ({ ok: true, providerAddress }));

  app.get("/", async (_req, reply) => reply.type("text/html").send(dashboardHtml));

  app.get("/status", async (req, reply) => {
    if (!ipLimiter.allow(req.ip)) {
      return reply.status(429).send({ error: "rate_limited", message: "rate limit exceeded for this IP" });
    }
    const balances = await getProviderBalances();
    const lastAutoUnwrap = getLastAutoUnwrap();
    return reply.send({
      providerAddress,
      balances,
      config: {
        feeMarkupPercent: config.feeMarkupPercent,
        autoUnwrap: {
          enabled: config.autoUnwrapEnabled,
          thresholdUscrt: config.autoUnwrapThresholdUscrt,
        },
      },
      lastAutoUnwrap: lastAutoUnwrap && {
        txHash: lastAutoUnwrap.tx_hash,
        sscrtBalanceBefore: lastAutoUnwrap.sscrt_balance_before,
        code: lastAutoUnwrap.code,
        triggeredAt: lastAutoUnwrap.triggered_at,
      },
    });
  });

  app.post<{ Body: { address: string; permit: Permit } }>("/onboard", async (req, reply) => {
    const { address, permit } = req.body ?? ({} as any);
    if (!address || !permit) {
      return reply.status(400).send({ error: "bad_request", message: "address and permit are required" });
    }
    const rateLimited = checkRateLimit(req.ip, address);
    if (rateLimited) return reply.status(429).send({ error: "rate_limited", message: rateLimited });

    try {
      const result = await onboardUser(address, permit);
      return reply.send(result);
    } catch (err: any) {
      req.log.error(err);
      return reply.status(500).send({ error: "onboard_failed", message: err.message });
    }
  });

  app.post<{ Body: { address: string; pubkeyBase64?: string; messages: WireMessage[] } }>(
    "/quote",
    async (req, reply) => {
      const { address, pubkeyBase64, messages } = req.body ?? ({} as any);
      if (!address) return reply.status(400).send({ error: "bad_request", message: "address is required" });
      const rateLimited = checkRateLimit(req.ip, address);
      if (rateLimited) return reply.status(429).send({ error: "rate_limited", message: rateLimited });

      try {
        const decoded = decodeMessages(messages);
        const result = await requestQuote({ address, messages: decoded, pubkeyBase64 });
        return reply.send(result);
      } catch (err) {
        if (err instanceof MessageDecodeError) {
          return reply.status(400).send({ error: "bad_messages", message: err.message });
        }
        if (err instanceof QuoteError) {
          return reply.status(QUOTE_ERROR_STATUS[err.code] ?? 400).send({ error: err.code, message: err.message });
        }
        req.log.error(err);
        return reply.status(500).send({ error: "quote_failed", message: (err as Error).message });
      }
    },
  );

  app.post<{ Body: { quoteId: string; signedTxBytes: string } }>("/submit", async (req, reply) => {
    const { quoteId, signedTxBytes } = req.body ?? ({} as any);
    if (!quoteId || !signedTxBytes) {
      return reply.status(400).send({ error: "bad_request", message: "quoteId and signedTxBytes are required" });
    }

    // /submit's body has no address — look up the quote's owner so the address-scoped limiter
    // still applies (an unknown quoteId just fails the IP check plus submitQuote's own
    // not_found below; that's fine, an attacker gains nothing from probing random ids).
    const owner = getQuoteAddress(quoteId);
    const rateLimited = checkRateLimit(req.ip, owner ?? `unknown:${req.ip}`);
    if (rateLimited) return reply.status(429).send({ error: "rate_limited", message: rateLimited });

    try {
      const bytes = Uint8Array.from(Buffer.from(signedTxBytes, "base64"));
      const result = await submitQuote(quoteId, bytes);
      return reply.send(result);
    } catch (err) {
      if (err instanceof SubmitError) {
        return reply.status(SUBMIT_ERROR_STATUS[err.code] ?? 400).send({ error: err.code, message: err.message });
      }
      req.log.error(err);
      return reply.status(500).send({ error: "submit_failed", message: (err as Error).message });
    }
  });

  return app;
}
