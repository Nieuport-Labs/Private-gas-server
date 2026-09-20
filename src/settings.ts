// Operator-tunable settings, stored in SQLite so the dashboard can change them without editing
// container config and without a restart.
//
// Env vars are the initial values only: whatever config.ts resolved at boot is what a key falls
// back to until it is set here. That keeps existing deployments and the devnet behaving exactly
// as before, while making the same knobs editable at runtime.
//
// Read straight from SQLite on every access rather than cached — at this scale that costs
// microseconds in-process, and it means a change takes effect immediately everywhere, with no
// cache to invalidate.
import { db } from "./db.js";
import { config } from "./config.js";

export type Settings = {
  feeMarkupPercent: number;
  autoUnwrapEnabled: boolean;
  autoUnwrapThresholdUscrt: string;
  allowedContractAddresses: string[];
  grantSpendLimitUscrt: string;
  grantExpirySeconds: number;
  /** Ceiling for the first, single-transaction grant an address gets before it has paid anything.
   * This is the most a never-paying address can cost the provider in sponsored gas. */
  bootstrapGrantUscrt: string;
  /** One-off, non-refundable, collected in the first sponsored transaction and topped back up in
   * later ones. Only ever drawn on when a transaction fails. */
  securityDepositUscrt: string;
};

const readStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
const writeStmt = db.prepare(
  `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
);

function raw(key: string): string | null {
  return (readStmt.get(key) as { value: string } | undefined)?.value ?? null;
}

export function getSettings(): Settings {
  const stored = {
    feeMarkupPercent: raw("fee_markup_percent"),
    autoUnwrapEnabled: raw("auto_unwrap_enabled"),
    autoUnwrapThresholdUscrt: raw("auto_unwrap_threshold_uscrt"),
    allowedContractAddresses: raw("allowed_contract_addresses"),
    grantSpendLimitUscrt: raw("grant_spend_limit_uscrt"),
    grantExpirySeconds: raw("grant_expiry_seconds"),
    bootstrapGrantUscrt: raw("bootstrap_grant_uscrt"),
    securityDepositUscrt: raw("security_deposit_uscrt"),
  };

  return {
    feeMarkupPercent: stored.feeMarkupPercent !== null ? Number(stored.feeMarkupPercent) : config.feeMarkupPercent,
    autoUnwrapEnabled: stored.autoUnwrapEnabled !== null ? stored.autoUnwrapEnabled === "true" : config.autoUnwrapEnabled,
    autoUnwrapThresholdUscrt: stored.autoUnwrapThresholdUscrt ?? config.autoUnwrapThresholdUscrt,
    allowedContractAddresses:
      stored.allowedContractAddresses !== null
        ? stored.allowedContractAddresses.split(",").map((s) => s.trim()).filter(Boolean)
        : config.allowedContractAddresses,
    grantSpendLimitUscrt: stored.grantSpendLimitUscrt ?? config.grantSpendLimitUscrt,
    grantExpirySeconds: stored.grantExpirySeconds !== null ? Number(stored.grantExpirySeconds) : config.grantExpirySeconds,
    bootstrapGrantUscrt: stored.bootstrapGrantUscrt ?? config.bootstrapGrantUscrt,
    securityDepositUscrt: stored.securityDepositUscrt ?? config.securityDepositUscrt,
  };
}

export class SettingsError extends Error {}

/**
 * Validates before writing anything — a rejected patch leaves every key untouched, so a typo in
 * one field can't half-apply a settings change on a server handling real money.
 */
export function updateSettings(patch: Partial<Settings>): Settings {
  const writes: [string, string][] = [];

  if (patch.feeMarkupPercent !== undefined) {
    const v = Number(patch.feeMarkupPercent);
    if (!Number.isFinite(v) || v < 0 || v > 1000) throw new SettingsError("feeMarkupPercent must be between 0 and 1000");
    writes.push(["fee_markup_percent", String(v)]);
  }
  if (patch.autoUnwrapEnabled !== undefined) {
    writes.push(["auto_unwrap_enabled", patch.autoUnwrapEnabled ? "true" : "false"]);
  }
  if (patch.autoUnwrapThresholdUscrt !== undefined) {
    const v = String(patch.autoUnwrapThresholdUscrt);
    if (!/^\d+$/.test(v)) throw new SettingsError("autoUnwrapThresholdUscrt must be a whole number of uscrt");
    writes.push(["auto_unwrap_threshold_uscrt", v]);
  }
  if (patch.allowedContractAddresses !== undefined) {
    const list = patch.allowedContractAddresses.map((s) => s.trim()).filter(Boolean);
    const bad = list.find((a) => !/^secret1[a-z0-9]{38,}$/.test(a));
    if (bad) throw new SettingsError(`not a valid Secret contract address: ${bad}`);
    writes.push(["allowed_contract_addresses", list.join(",")]);
  }
  if (patch.grantSpendLimitUscrt !== undefined) {
    const v = String(patch.grantSpendLimitUscrt);
    if (!/^\d+$/.test(v) || v === "0") throw new SettingsError("grantSpendLimitUscrt must be a positive whole number of uscrt");
    writes.push(["grant_spend_limit_uscrt", v]);
  }
  if (patch.bootstrapGrantUscrt !== undefined) {
    const v = String(patch.bootstrapGrantUscrt);
    if (!/^\d+$/.test(v) || v === "0") {
      throw new SettingsError("bootstrapGrantUscrt must be a positive whole number of uscrt");
    }
    // It has to cover one real transaction or no first quote can ever be signed, and it should
    // stay well under the full limit, because it is what an address gets before paying anything.
    const full = BigInt(patch.grantSpendLimitUscrt !== undefined ? String(patch.grantSpendLimitUscrt) : getSettings().grantSpendLimitUscrt);
    if (BigInt(v) > full) throw new SettingsError("bootstrapGrantUscrt cannot exceed the full grant spend limit");
    writes.push(["bootstrap_grant_uscrt", v]);
  }
  if (patch.securityDepositUscrt !== undefined) {
    const v = String(patch.securityDepositUscrt);
    if (!/^\d+$/.test(v) || v === "0") {
      throw new SettingsError("securityDepositUscrt must be a positive whole number of uscrt");
    }
    writes.push(["security_deposit_uscrt", v]);
  }
  if (patch.grantExpirySeconds !== undefined) {
    const v = Number(patch.grantExpirySeconds);
    if (!Number.isInteger(v) || v <= 0) throw new SettingsError("grantExpirySeconds must be a positive whole number of seconds");
    writes.push(["grant_expiry_seconds", String(v)]);
  }

  db.transaction(() => {
    for (const [k, v] of writes) writeStmt.run(k, v);
  })();

  return getSettings();
}
