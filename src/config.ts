// Central config loader. Nothing here reads a secret file from the repo — the provider's
// signing key comes from an environment variable populated by whatever secrets manager is
// in front of the process (see plan: "Bezpečnost" section). Local dev uses a devnet-only
// throwaway mnemonic, never a production key.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

// An env var set to an empty string (`FOO=` in a compose file or .env) is a blank, not a value —
// but it is not undefined, so `??` would happily pass it through. Every required-in-production
// setting goes through this instead, so a blank fails loudly at startup rather than silently
// becoming 0, "" or an empty password.
function envOrUndefined(name: string): string | undefined {
  return process.env[name] || undefined;
}

const MIN_ADMIN_PASSWORD_LENGTH = 12;

function optionalPassword(): string {
  const supplied = envOrUndefined("ADMIN_PASSWORD");
  if (!supplied) {
    // Dev/devnet still bootstraps itself so local work needs no setup step; production starts
    // unconfigured and waits for the dashboard.
    return process.env.NODE_ENV === "production" ? "" : "devnet-admin-password";
  }
  if (supplied.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`);
  }
  return supplied;
}

export const config = {
  chainId: process.env.CHAIN_ID ?? "secretdev-1",
  lcdUrl: process.env.LCD_URL ?? "http://localhost:1317",
  rpcUrl: process.env.RPC_URL ?? "http://localhost:26657",

  // The provider's own signing account. Only ever used for: (a) MsgGrantAllowance /
  // MsgRevokeAllowance (grant lifecycle), never for signing a user's action+payment bundle
  // — that transaction is signed solely by the user, per the plan's core decision.
  //
  // This is no longer the runtime source of the key: wallet.ts keeps the mnemonic encrypted in
  // the database and the dashboard manages it. This env var only seeds that store on first boot
  // (and keeps devnet/CI working with no setup), after which it can be removed.
  providerMnemonic:
    envOrUndefined("PROVIDER_MNEMONIC") ??
    (process.env.NODE_ENV === "production"
      ? // No longer required: a production deployment can start with no wallet at all and have
        // one generated from the dashboard. Endpoints that need to sign fail cleanly until then.
        ""
      : // devnet-only fallback so local dev doesn't require exporting anything; never valid
        // outside a throwaway LocalSecret instance.
        "grant rice replace explain federal release fix clever romance raise often wild taxi quarter soccer fiber love must tape steak together observe swap guitar"),

  // Optional. The admin password is normally set through first-run setup in the dashboard, which
  // keeps it out of container config entirely; this is only a headless bootstrap for CI, the
  // devnet and automated rebuilds (see bootstrap.ts), and is ignored once setup has happened.
  // Empty string counts as absent — `FOO=` in a compose file is a blank, not a password.
  adminPassword: optionalPassword(),

  adminSessionTtlSeconds: Number(process.env.ADMIN_SESSION_TTL_SECONDS ?? 60 * 60 * 12),

  sscrtContract: requiredInProd("SSCRT_CONTRACT", "secret18wy2w4rzg9xxsm2ru8jq8tdq053h39epxvd4rl"),

  // Native gas price this server pays/quotes at. 0.25uscrt is LocalSecret's single-validator
  // devnet default — NOT a mainnet value. Mainnet validators each set their own min_gas_price;
  // there is no single correct constant, and getting this wrong either overcharges every user
  // or gets transactions rejected by nodes with a higher minimum. Must be set explicitly via env
  // for any non-devnet deployment — see DEPLOY.md's pre-launch checklist.
  nativeGasPriceUscrt: Number(
    envOrUndefined("NATIVE_GAS_PRICE_USCRT") ??
      (process.env.NODE_ENV === "production" ? required("NATIVE_GAS_PRICE_USCRT") : 0.25),
  ),

  // Grant scoping (plan: "Bezpečnost" — never an unrestricted grant).
  grantSpendLimitUscrt: process.env.GRANT_SPEND_LIMIT_USCRT ?? "500000",
  grantExpirySeconds: Number(process.env.GRANT_EXPIRY_SECONDS ?? 60 * 60 * 24 * 30), // 30 days
  allowedMessageTypes: (
    process.env.ALLOWED_MESSAGE_TYPES ??
    [
      "/cosmos.staking.v1beta1.MsgDelegate",
      "/cosmos.staking.v1beta1.MsgUndelegate",
      "/cosmos.staking.v1beta1.MsgBeginRedelegate",
      "/cosmos.gov.v1.MsgVote",
      "/cosmos.bank.v1beta1.MsgSend",
      "/secret.compute.v1beta1.MsgExecuteContract",
    ].join(",")
  ).split(","),

  // Quote lifetime — short on purpose (plan: "Quote"). A stale quote must be re-issued, not
  // reused, because the sequence/balance it was built against may no longer hold.
  quoteTtlSeconds: Number(process.env.QUOTE_TTL_SECONDS ?? 45),

  // Rate limiting on /quote and /submit (plan: "Bezpečnost") — both cost the server its own
  // RPC round-trips against the chain. Two independent keys, same limiter shape for both
  // endpoints: per source IP (catches a single flooding client) and per address (catches many
  // requests for one grantee spread across rotating IPs).
  rateLimitPerIpPerMinute: Number(process.env.RATE_LIMIT_PER_IP_PER_MINUTE ?? 60),
  rateLimitPerAddressPerMinute: Number(process.env.RATE_LIMIT_PER_ADDRESS_PER_MINUTE ?? 10),

  // Provider's margin on top of what it actually spends on gas (quote.ts derives a multiplier
  // from this: 1 + feeMarkupPercent / 100). This and the settings below it are initial values
  // only — settings.ts stores the live ones, editable from the dashboard.
  feeMarkupPercent: Number(process.env.FEE_MARKUP_PERCENT ?? 10),

  // Auto-unwrap: once the provider's own sSCRT balance reaches this threshold, redeem the whole
  // balance back to native uscrt (see autoUnwrap.ts) — closes the hot-wallet loop described in
  // the plan's "Hot/cold split": the provider spends native SCRT on grants and gets sSCRT back,
  // which otherwise just accumulates forever instead of refilling the native reserve.
  autoUnwrapEnabled: (process.env.AUTO_UNWRAP_ENABLED ?? "true") === "true",
  autoUnwrapThresholdUscrt: process.env.AUTO_UNWRAP_THRESHOLD_USCRT ?? "100000000", // 100 SCRT
  autoUnwrapCheckIntervalSeconds: Number(process.env.AUTO_UNWRAP_CHECK_INTERVAL_SECONDS ?? 60),

  // Contracts the provider is willing to sponsor a MsgExecuteContract *user action* against
  // (e.g. a DEX swap) — separate from allowedMessageTypes, which only scopes the on-chain grant
  // by message type and can't filter by contract address at all (a Cosmos SDK feegrant
  // limitation, not something this server can work around on-chain). Whole-contract, not
  // per-entry-point: simpler to operate, at the cost of one gas constant needing to cover the
  // most expensive call the operator intends to allow on that contract (see quote.ts and
  // gasCalibration.ts). Empty by default — nothing beyond the built-in sSCRT payment is
  // sponsorable until the operator explicitly whitelists something and calibrates its gas.
  allowedContractAddresses: (process.env.ALLOWED_CONTRACT_ADDRESSES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  dbPath: process.env.DB_PATH ?? "./provider.sqlite3",
  port: Number(process.env.PORT ?? 8787),
};

function requiredInProd(name: string, devnetDefault: string): string {
  return envOrUndefined(name) ?? (process.env.NODE_ENV === "production" ? required(name) : devnetDefault);
}
