// The HTTP layer described in the plan under "Architektura serveru" — up to now every piece
// (onboarding, quote, submit) has only been exercised by directly calling these functions from
// the smoke-test scripts. This wires the same functions up to real endpoints for a client
// (dApp/Keplr flow, still out of scope for this phase) to actually call.
import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { getProviderBalances } from "./chain.js";
import {
  getProviderAddress,
  isWalletConfigured,
  setProviderMnemonic,
  generateProviderWallet,
  WalletNotConfiguredError,
} from "./wallet.js";
import { getSettings, updateSettings, SettingsError } from "./settings.js";
import { login, logout, logoutAll, issueSession, isValidSession, tokenFromHeader, sweepSessions } from "./auth.js";
import { isSetUp, setup, changePassword, PasswordTooShortError } from "./secretStore.js";
import { wrapScrt, calibratePaymentGas } from "./maintenance.js";
import { startJob, getJob, JobInProgressError } from "./jobs.js";
import { getGasConstant } from "./gasCalibration.js";
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
    sweepSessions();
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

  // The user-facing API is meant to be called by dApp clients running in a browser on a
  // different origin, so it stays CORS-open. /admin/* deliberately does not: those routes are
  // authenticated, and letting an arbitrary page read their responses is exactly the exposure
  // the token auth in auth.ts exists to prevent.
  app.addHook("onSend", (req, reply, payload, done) => {
    if (!req.url.startsWith("/admin")) reply.header("Access-Control-Allow-Origin", "*");
    done(null, payload);
  });

  // Rejects every /admin/* request without a valid session, before any handler runs.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/admin") || req.url === "/admin/login") return;
    // First-run setup is the one admin route that cannot require a session — there is no password
    // to authenticate against yet. It closes permanently the moment one exists.
    if (req.url === "/admin/setup" && !isSetUp()) return;
    if (!isValidSession(tokenFromHeader(req.headers.authorization))) {
      return reply.status(401).send({ error: "unauthorized", message: "log in first" });
    }
  });

  app.get("/health", async () => ({
    ok: true,
    walletConfigured: isWalletConfigured(),
    providerAddress: isWalletConfigured() ? getProviderAddress() : null,
  }));

  app.get("/", async (_req, reply) => reply.type("text/html").send(dashboardHtml));

  // Public: a dApp client needs the fee markup to show a user what a sponsored transaction will
  // cost, and the provider address to build the payment leg. The provider's own balances and
  // operational history are not part of that, so they are only included for a logged-in operator
  // — the dashboard gets them from the same endpoint once it has a session.
  app.get("/status", async (req, reply) => {
    if (!ipLimiter.allow(req.ip)) {
      return reply.status(429).send({ error: "rate_limited", message: "rate limit exceeded for this IP" });
    }

    const settings = getSettings();
    const walletConfigured = isWalletConfigured();
    const publicPart = {
      setupRequired: !isSetUp(),
      providerAddress: walletConfigured ? getProviderAddress() : null,
      walletConfigured,
      chainId: config.chainId,
      sscrtContract: config.sscrtContract,
      config: {
        feeMarkupPercent: settings.feeMarkupPercent,
        autoUnwrap: {
          enabled: settings.autoUnwrapEnabled,
          thresholdUscrt: settings.autoUnwrapThresholdUscrt,
        },
      },
    };

    if (!isValidSession(tokenFromHeader(req.headers.authorization))) {
      return reply.send({ ...publicPart, authenticated: false });
    }

    const lastAutoUnwrap = getLastAutoUnwrap();
    let paymentGasConstant: number | null = null;
    try {
      paymentGasConstant = getGasConstant("sscrt_payment_transfer");
    } catch {
      // Not calibrated yet — the dashboard shows this as an action the operator still has to take.
    }
    return reply.send({
      ...publicPart,
      authenticated: true,
      balances: walletConfigured ? await getProviderBalances() : null,
      settings,
      paymentGasConstant,
      job: getJob(),
      lastAutoUnwrap: lastAutoUnwrap && {
        txHash: lastAutoUnwrap.tx_hash,
        sscrtBalanceBefore: lastAutoUnwrap.sscrt_balance_before,
        code: lastAutoUnwrap.code,
        triggeredAt: lastAutoUnwrap.triggered_at,
      },
    });
  });

  app.post<{ Body: { password: string } }>("/admin/setup", async (req, reply) => {
    if (isSetUp()) {
      return reply.status(409).send({ error: "already_set_up", message: "an admin password is already set" });
    }
    if (!ipLimiter.allow(req.ip)) {
      return reply.status(429).send({ error: "rate_limited", message: "too many attempts, wait a minute" });
    }
    try {
      setup(req.body?.password ?? "");
    } catch (err) {
      if (err instanceof PasswordTooShortError) {
        return reply.status(400).send({ error: err.code, message: err.message });
      }
      throw err;
    }
    // Signed in immediately — making the operator retype the password they just chose adds
    // nothing, and setup already proves they control the instance.
    return reply.send({ token: issueSession(), expiresInSeconds: config.adminSessionTtlSeconds });
  });

  app.post<{ Body: { currentPassword: string; newPassword: string } }>("/admin/password", async (req, reply) => {
    const { currentPassword, newPassword } = req.body ?? ({} as any);
    if (!currentPassword || !newPassword) {
      return reply.status(400).send({ error: "bad_request", message: "currentPassword and newPassword are required" });
    }
    try {
      changePassword(currentPassword, newPassword);
    } catch (err) {
      if (err instanceof PasswordTooShortError) {
        return reply.status(400).send({ error: err.code, message: err.message });
      }
      return reply.status(400).send({ error: "password_change_failed", message: (err as Error).message });
    }
    logoutAll(); // old tokens must not outlive the password that created them
    return reply.send({ ok: true });
  });

  app.post<{ Body: { password: string } }>("/admin/login", async (req, reply) => {
    // Rate-limited by IP like everything else, so the password can't be brute-forced quickly.
    if (!ipLimiter.allow(req.ip)) {
      return reply.status(429).send({ error: "rate_limited", message: "too many attempts, wait a minute" });
    }
    const token = login(req.body?.password ?? "");
    if (!token) return reply.status(401).send({ error: "bad_password", message: "wrong password" });
    return reply.send({ token, expiresInSeconds: config.adminSessionTtlSeconds });
  });

  app.post("/admin/logout", async (req, reply) => {
    const token = tokenFromHeader(req.headers.authorization);
    if (token) logout(token);
    return reply.send({ ok: true });
  });

  // Generating returns the mnemonic exactly once, in this response and never again — there is no
  // endpoint that reads it back out. If the operator loses it, the remedy is to move the funds
  // out using it while they still have it, not to ask the server.
  app.post("/admin/wallet/generate", async (_req, reply) => {
    const { address, mnemonic } = generateProviderWallet();
    return reply.send({ address, mnemonic });
  });

  app.post<{ Body: { mnemonic: string } }>("/admin/wallet/import", async (req, reply) => {
    const mnemonic = req.body?.mnemonic?.trim();
    if (!mnemonic) return reply.status(400).send({ error: "bad_request", message: "mnemonic is required" });
    try {
      return reply.send({ address: setProviderMnemonic(mnemonic) });
    } catch (err) {
      return reply.status(400).send({ error: "bad_mnemonic", message: (err as Error).message });
    }
  });

  app.post<{ Body: { amountUscrt: string } }>("/admin/wrap", async (req, reply) => {
    const amountUscrt = String(req.body?.amountUscrt ?? "").trim();
    if (!/^\d+$/.test(amountUscrt) || amountUscrt === "0") {
      return reply.status(400).send({ error: "bad_request", message: "amountUscrt must be a positive whole number" });
    }
    try {
      return reply.send({ job: startJob("wrap", (onProgress) => wrapScrt(amountUscrt, onProgress)) });
    } catch (err) {
      if (err instanceof JobInProgressError) return reply.status(409).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.post<{ Body: { samples?: number } }>("/admin/calibrate", async (req, reply) => {
    const samples = Number(req.body?.samples ?? 10);
    if (!Number.isInteger(samples) || samples < 1 || samples > 50) {
      return reply.status(400).send({ error: "bad_request", message: "samples must be a whole number between 1 and 50" });
    }
    try {
      return reply.send({ job: startJob("calibrate", (onProgress) => calibratePaymentGas(samples, onProgress)) });
    } catch (err) {
      if (err instanceof JobInProgressError) return reply.status(409).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.post<{ Body: Record<string, unknown> }>("/admin/settings", async (req, reply) => {
    try {
      return reply.send({ settings: updateSettings(req.body as never) });
    } catch (err) {
      if (err instanceof SettingsError) return reply.status(400).send({ error: "bad_settings", message: err.message });
      throw err;
    }
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
      if (err instanceof WalletNotConfiguredError) {
        return reply.status(503).send({ error: err.code, message: err.message });
      }
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
        if (err instanceof WalletNotConfiguredError) {
          return reply.status(503).send({ error: err.code, message: err.message });
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
      if (err instanceof WalletNotConfiguredError) {
        return reply.status(503).send({ error: err.code, message: err.message });
      }
      req.log.error(err);
      return reply.status(500).send({ error: "submit_failed", message: (err as Error).message });
    }
  });

  return app;
}
