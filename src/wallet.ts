// The provider's signing wallet, as runtime state rather than a startup constant.
//
// It used to be `new Wallet(env.PROVIDER_MNEMONIC)` evaluated at import time, which made the key
// unchangeable without editing container config and left the seed sitting in plaintext in the
// environment (visible to `docker inspect`, to the compose file, to anything that can read the
// process). Here it lives encrypted in the database and is decrypted into memory at boot.
//
// What this does and does not buy, stated honestly: the seed is no longer in the environment or
// in any config file, and a stolen copy of the database is useless on its own. But because the
// server must come back up unattended after a restart, the password that decrypts it comes from
// ADMIN_PASSWORD — so anyone who can read *both* the environment and the database still gets the
// seed. This is defence in depth and much better key hygiene, not a vault.
import { Wallet, SecretNetworkClient } from "secretjs";
import { db } from "./db.js";
import { config } from "./config.js";
import { encryptWithPassword, decryptWithPassword } from "./crypto.js";

const MNEMONIC_KEY = "provider_mnemonic";

type LoadedWallet = { wallet: Wallet; client: SecretNetworkClient; address: string };

let loaded: LoadedWallet | null = null;
let initAttempted = false;

function readStoredMnemonic(): string | null {
  const row = db.prepare(`SELECT value FROM secrets WHERE key = ?`).get(MNEMONIC_KEY) as { value: string } | undefined;
  if (!row) return null;
  return decryptWithPassword(row.value, config.adminPassword);
}

function writeStoredMnemonic(mnemonic: string): void {
  db.prepare(
    `INSERT INTO secrets (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(MNEMONIC_KEY, encryptWithPassword(mnemonic, config.adminPassword));
}

function build(mnemonic: string): LoadedWallet {
  const wallet = new Wallet(mnemonic);
  return {
    wallet,
    address: wallet.address,
    client: new SecretNetworkClient({
      url: config.lcdUrl,
      chainId: config.chainId,
      wallet,
      walletAddress: wallet.address,
    }),
  };
}

/**
 * Called once at startup. Loads the stored wallet if there is one; otherwise, if a mnemonic was
 * supplied via env, adopts it into the encrypted store (the migration path from the old setup,
 * and what keeps devnet working with no configuration).
 *
 * Never throws on "no wallet yet" — a fresh deployment is expected to start empty and have one
 * generated from the dashboard.
 */
export function initWallet(): void {
  initAttempted = true;
  const stored = readStoredMnemonic();
  if (stored) {
    loaded = build(stored);
    return;
  }
  if (config.providerMnemonic) {
    writeStoredMnemonic(config.providerMnemonic);
    loaded = build(config.providerMnemonic);
  }
}

/**
 * The maintenance scripts in src/scripts/ are their own entry points and never call initWallet,
 * so loading is lazy on first use as well. Runs at most once either way.
 */
function ensureInit(): void {
  if (!initAttempted) initWallet();
}

export function isWalletConfigured(): boolean {
  ensureInit();
  return loaded !== null;
}

/** Replaces the wallet, in the store and in memory, atomically from the caller's point of view. */
export function setProviderMnemonic(mnemonic: string): string {
  const next = build(mnemonic.trim()); // validates the mnemonic before anything is persisted
  writeStoredMnemonic(mnemonic.trim());
  loaded = next;
  return next.address;
}

export function generateProviderWallet(): { address: string; mnemonic: string } {
  const wallet = new Wallet();
  const mnemonic = wallet.mnemonic;
  setProviderMnemonic(mnemonic);
  return { address: wallet.address, mnemonic };
}

class WalletNotConfiguredError extends Error {
  readonly code = "wallet_not_configured";
  constructor() {
    super("no provider wallet configured — generate or import one from the dashboard");
  }
}

function requireLoaded(): LoadedWallet {
  ensureInit();
  if (!loaded) throw new WalletNotConfiguredError();
  return loaded;
}

export function getProviderAddress(): string {
  return requireLoaded().address;
}

export function getProviderClient(): SecretNetworkClient {
  return requireLoaded().client;
}

export { WalletNotConfiguredError };
