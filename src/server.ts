// The HTTP layer described in the plan under "Architektura serveru" — up to now every piece
// (onboarding, quote, submit) has only been exercised by directly calling these functions from
// the smoke-test scripts. This wires the same functions up to real endpoints for a client
// (dApp/Keplr flow, still out of scope for this phase) to actually call.
import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { getProviderBalancesCached } from "./chain.js";
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
import { startJob, getJob, isJobRunning, JobInProgressError } from "./jobs.js";
import { getGasConstant } from "./gasCalibration.js";
import { onboardUser, OnboardError } from "./onboarding.js";
import { requestPurchaseQuote, QuoteError } from "./quote.js";
import { submitQuote, purchaseStatus, SubmitError } from "./submit.js";
import { outstandingPurchases, deliverPending, requeuePurchase, closePurchase } from "./creditDelivery.js";
import { queryVaultStatus, GasVaultError } from "./gasVault.js";
import { defaultPurchase, CreditSaleError } from "./creditSale.js";
import { purgeLegacyData, describeLegacyData } from "./dataPurge.js";
import { getAttestation, attestationAvailable, attestationUnavailableReason } from "./attestation.js";
import { RateLimiter } from "./rateLimit.js";
import { getLastAutoUnwrap } from "./autoUnwrap.js";
import { db } from "./db.js";
import type { Permit } from "secretjs";

// public/ sits next to both src/ and dist/ at the package root, so resolving relative to this
// module's own location works the same under tsx (src/server.ts) and the compiled build
// (dist/server.js) — no dependency on the process's cwd.
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const dashboardHtml = readFileSync(join(publicDir, "index.html"), "utf-8");

/**
 * Addresses do not go in the log.
 *
 * Several errors name the address they are about -- "no stored balance permit for secret1..." --
 * and Fastify writes whatever it is handed. On a host that offers public logs, that turns the
 * log stream into the record of who used this provider that was just deleted from the database.
 * The same leak, through a different pipe.
 *
 * The last four characters survive so two entries can still be told apart while debugging, which
 * is the only thing the full address was ever doing here.
 */
function redactAddresses(text: string): string {
  return text.replace(/secret1[0-9a-z]{38,}/g, (a) => `secret1…${a.slice(-4)}`);
}

/** Log a failure without writing anybody's address into it. */
function logFailure(req: { log: { error: (o: unknown) => void } }, err: unknown): void {
  const e = err as Error;
  req.log.error({ err: redactAddresses(e?.message ?? String(err)), stack: e?.stack });
}

/** Pricing for /status, which has to render even when the operator has priced credits badly. */
function safeDefaultPurchase() {
  try {
    return defaultPurchase();
  } catch {
    return null;
  }
}

function getQuoteAddress(quoteId: string): string | null {
  const row = db.prepare(`SELECT address FROM quotes WHERE quote_id = ?`).get(quoteId) as
    | { address: string }
    | undefined;
  return row?.address ?? null;
}

const QUOTE_ERROR_STATUS: Record<QuoteError["code"], number> = {
  no_permit: 404,
  insufficient_balance: 402,
  no_pubkey: 400,
  credits_unavailable: 503,
  bad_amount: 400,
  // Not the caller's fault and not fixable by retrying: the operator has priced credits below
  // what they cost to sell.
  margin_too_low: 503,
};

const SUBMIT_ERROR_STATUS: Record<SubmitError["code"], number> = {
  not_found: 404,
  expired: 410,
  already_submitted: 409,
  sequence_changed: 409,
  insufficient_balance: 402,
  signed_tx_mismatch: 400,
  // Transient and entirely the endpoint's doing: nothing was spent, and the same request will
  // usually work on a retry.
  not_broadcast: 503,
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

  // Allowing the origin is not enough on its own. A POST carrying a JSON body is not a "simple"
  // request, so the browser sends a preflight OPTIONS first — and Fastify has no route for one,
  // so it answered 404 with no Access-Control-Allow-Headers. The browser then refuses to send the
  // POST at all, and the page sees a bare "Failed to fetch" with no status to explain it. GET
  // /status worked throughout, because a plain GET needs no preflight — which is exactly what
  // made this look like the server being unreachable rather than a missing header.
  //
  // /admin/* is excluded for the same reason it is excluded above: no browser on another origin
  // has any business calling it.
  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "OPTIONS" || req.url.startsWith("/admin")) return;
    return reply
      .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
      .header("Access-Control-Allow-Headers", "content-type")
      .header("Access-Control-Max-Age", "86400")
      .status(204)
      .send();
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

  /**
   * What is actually running here, signed by the hardware rather than asserted by the operator.
   *
   * Public and unauthenticated on purpose: it is meant to be called by a client deciding whether
   * to trust this server at all, which is a decision it has to be able to make before it has
   * any relationship with it.
   *
   * The nonce is required. A quote without one proves that this image ran somewhere at some
   * point, which is not the question -- the question is whether the thing answering right now is
   * that image.
   */
  app.get<{ Querystring: { nonce?: string } }>("/attestation", async (req, reply) => {
    if (!ipLimiter.allow(req.ip)) {
      return reply.status(429).send({ error: "rate_limited", message: "rate limit exceeded for this IP" });
    }
    const nonce = String(req.query?.nonce ?? "").trim();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
      return reply.status(400).send({
        error: "bad_nonce",
        message: "nonce is required: 16-128 characters of [A-Za-z0-9_-], freshly random per request",
      });
    }

    const attestation = await getAttestation(nonce);
    if (!attestation) {
      // Not a failure to hide. A client that wanted a verified server should now refuse to send
      // it anything, and it can only do that if this says so.
      return reply.status(501).send({
        error: "no_attestation",
        message:
          "this provider cannot prove what it is running — treat anything it says about " +
          "deleting your permit as a promise",
        // Why, in the operator's terms. Usually "not in a CVM", but it can also be a broken
        // dependency or an unmounted socket inside a perfectly good one, and those two used to
        // be indistinguishable from here.
        reason: attestationUnavailableReason(),
      });
    }
    return reply.send(attestation);
  });

  app.get("/status", async (req, reply) => {
    // The IP limiter exists to stop anonymous callers making this server do chain queries for
    // free. A signed-in operator is not that: their dashboard polls every 2s while a maintenance
    // job runs, which on its own approaches the anonymous budget — and when it tripped, the 429
    // (which carries no `authenticated` field) read to the dashboard as "logged out", so it wiped
    // the session and then could not log back in, because the polling kept the limiter tripped.
    const authed = isValidSession(tokenFromHeader(req.headers.authorization));
    if (!authed && !ipLimiter.allow(req.ip)) {
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
      // The dashboard's Keplr step signs and broadcasts from the browser, so it needs an endpoint
      // of its own. Serving the one the server already uses keeps the two from disagreeing about
      // balances. It is a public URL either way, so this discloses nothing.
      lcdUrl: config.lcdUrl,
      nativeGasPriceUscrt: config.nativeGasPriceUscrt,
      // What a client needs to know before deciding whether it needs this server at all: where
      // the credits come from, and what they cost. A client with credits already can read the
      // vault directly and never call anything here.
      gasVaultAddress: settings.gasVaultAddress,
      creditsForSale: settings.gasVaultAddress ? safeDefaultPurchase() : null,
      // Whether /attestation will answer. A client that cares should still call it rather than
      // believe this flag, which is the server talking about itself.
      attestable: await attestationAvailable(),
      attestationUnavailableReason: attestationUnavailableReason(),
      config: {
        feeMarkupPercent: settings.feeMarkupPercent,
        autoUnwrap: {
          enabled: settings.autoUnwrapEnabled,
          thresholdUscrt: settings.autoUnwrapThresholdUscrt,
        },
      },
    };

    if (!authed) {
      return reply.send({ ...publicPart, authenticated: false });
    }

    const lastAutoUnwrap = getLastAutoUnwrap();
    let paymentGasConstant: number | null = null;
    try {
      paymentGasConstant = getGasConstant("sscrt_payment_transfer");
    } catch {
      // Not calibrated yet — the dashboard shows this as an action the operator still has to take.
    }

    // The vault's balance is also the sum of every allowance it still owes, so one figure answers
    // whether the credits this provider has sold are backed. Tolerant of a missing or unreachable
    // vault: the dashboard should still load and say what is wrong.
    const vault = settings.gasVaultAddress ? await queryVaultStatus().catch(() => null) : null;
    return reply.send({
      ...publicPart,
      authenticated: true,
      // While a maintenance job runs, the dashboard polls every 2s and the job is competing for
      // the same endpoint's rate limit — the balances shown beside a running job are not worth a
      // chain query, so serve whatever was last read and let the job have the budget.
      balances: walletConfigured ? await getProviderBalancesCached(isJobRunning() ? Infinity : undefined) : null,
      settings,
      paymentGasConstant,
      vault,
      // Everything paid for and not yet delivered. These are the only rows on this server that
      // still carry a buyer's address, and each one disappears the moment its credits land — so a
      // long list here is a problem to fix, not a normal state.
      outstanding: outstandingPurchases(),
      // What the provider has earned and spent, with no record of who from.
      sales: db
        .prepare(
          `SELECT COUNT(*) AS sales,
                  COALESCE(SUM(CAST(sscrt_received AS INTEGER)), 0) AS sscrtReceived,
                  COALESCE(SUM(CAST(credits_sold_uscrt AS INTEGER)), 0) AS creditsSold,
                  COALESCE(SUM(CAST(native_fee_spent_uscrt AS INTEGER)), 0) AS nativeSpent
             FROM sales_ledger`,
        )
        .get() as Record<string, number>,
      legacyData: describeLegacyData(),
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
    const samples = Number(req.body?.samples ?? 3);
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
      // The address cannot cover the one-off fee. 402 rather than 400: nothing about the request
      // is malformed, there is simply not enough money behind it.
      if (err instanceof OnboardError) {
        return reply.status(402).send({ error: err.code, message: err.message });
      }
      if (err instanceof WalletNotConfiguredError) {
        return reply.status(503).send({ error: err.code, message: err.message });
      }
      logFailure(req, err);
      return reply.status(500).send({ error: "onboard_failed", message: err.message });
    }
  });

  // The one transaction this provider sponsors: a payment for gas credits, built here in full.
  //
  // The client supplies no messages. That is the whole difference from the design this replaces,
  // and it is why the contract whitelist, the per-contract gas constants, the outflow prediction
  // and the security deposit are all gone -- every one of them existed to manage the risk of
  // sponsoring a message somebody else wrote.
  app.post<{ Body: { address: string; pubkeyBase64?: string; creditAmountUscrt?: string } }>(
    "/purchase/quote",
    async (req, reply) => {
      const { address, pubkeyBase64, creditAmountUscrt } = req.body ?? ({} as any);
      if (!address) return reply.status(400).send({ error: "bad_request", message: "address is required" });
      const rateLimited = checkRateLimit(req.ip, address);
      if (rateLimited) return reply.status(429).send({ error: "rate_limited", message: rateLimited });

      try {
        return reply.send(await requestPurchaseQuote({ address, pubkeyBase64, creditAmountUscrt }));
      } catch (err) {
        if (err instanceof QuoteError) {
          return reply.status(QUOTE_ERROR_STATUS[err.code] ?? 400).send({ error: err.code, message: err.message });
        }
        if (err instanceof GasVaultError || err instanceof CreditSaleError) {
          return reply.status(503).send({ error: "credits_unavailable", message: err.message });
        }
        if (err instanceof WalletNotConfiguredError) {
          return reply.status(503).send({ error: err.code, message: err.message });
        }
        logFailure(req, err);
        return reply.status(500).send({ error: "quote_failed", message: (err as Error).message });
      }
    },
  );

  // Where a purchase has got to. The credits arrive in a second transaction the provider signs
  // after the payment lands, so there is a real gap for a client to poll across -- see
  // creditDelivery.ts for why it cannot be closed with one signature.
  app.get<{ Params: { quoteId: string } }>("/purchase/:quoteId", async (req, reply) => {
    if (!ipLimiter.allow(req.ip)) {
      return reply.status(429).send({ error: "rate_limited", message: "rate limit exceeded for this IP" });
    }
    return reply.send(purchaseStatus(req.params.quoteId));
  });

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
      logFailure(req, err);
      return reply.status(500).send({ error: "submit_failed", message: (err as Error).message });
    }
  });

  // Delivery queue. A purchase that is paid for and undelivered is money the provider owes, so it
  // is the one thing on this dashboard that needs a button rather than a number.
  app.post("/admin/deliver", async (_req, reply) => reply.send(await deliverPending()));

  app.post<{ Body: { quoteId?: string } }>("/admin/purchase/requeue", async (req, reply) => {
    const quoteId = String(req.body?.quoteId ?? "").trim();
    if (!quoteId) return reply.status(400).send({ error: "bad_request", message: "quoteId is required" });
    if (!requeuePurchase(quoteId)) {
      return reply.status(409).send({
        error: "not_requeueable",
        message: "only a failed or reviewed purchase can be put back in the queue",
      });
    }
    return reply.send(await deliverPending());
  });

  // For a purchase confirmed delivered by hand, or written off. Deliberately separate from a
  // retry: this one says "do not try again", and getting those two the wrong way round either
  // grants twice or never.
  app.post<{ Body: { quoteId?: string } }>("/admin/purchase/close", async (req, reply) => {
    const quoteId = String(req.body?.quoteId ?? "").trim();
    if (!quoteId) return reply.status(400).send({ error: "bad_request", message: "quoteId is required" });
    if (!closePurchase(quoteId)) {
      return reply.status(404).send({ error: "not_found", message: `no outstanding purchase ${quoteId}` });
    }
    return reply.send({ closed: quoteId });
  });

  // Delete what this server no longer has a reason to hold. Read the counts first
  // (/status.legacyData), then this; it cannot be undone and it is not meant to be.
  app.post("/admin/purge", async (_req, reply) => reply.send(purgeLegacyData()));

  return app;
}
