// Onboarding, in two stages, and why it is two.
//
// A fee grant is what lets an address with no SCRT transact at all, and issuing one costs the
// provider a transaction. Handing them out on request is therefore something anyone can make the
// provider pay for, once per address they invent — the one exposure in this design that scales
// without limit.
//
// The answer is a non-refundable security deposit (see deposits.ts), collected before an address
// can do anything else. But the user cannot pay it up front: sending sSCRT needs gas, and having
// no gas is why they are here. So the deposit rides inside the first sponsored transaction, and
// the grant has to be split:
//
//   1. `onboardUser` — keeps the permit, issues nothing, spends nothing. It reads the address's
//      balance through that permit and refuses an address that could not pay the deposit anyway.
//      This is the real defence: an attacker has to park a genuine balance in every address
//      before the provider spends a single uscrt on it.
//   2. `issueBootstrapGrant` — called by the first quote, capped at `bootstrapGrantUscrt`: enough
//      for one sponsored transaction and no more. It cannot be sized to that quote's exact fee,
//      because issuing the grant is also what creates the grantee's account, and the simulation
//      the fee is derived from cannot run against an account that does not exist yet.
//   3. `ensureFullGrant` — once the deposit has landed, replaces the grant with one at the full
//      spend limit.
//
// Step 3 is a replacement, not an increase. A second MsgGrantAllowance for an existing pair is
// rejected with "fee allowance already exists", and the SDK has no update message — but a revoke
// and a grant in a single transaction work, which keeps it atomic and leaves no moment where the
// user holds no grant at all.
import { MsgGrantAllowance, MsgRevokeAllowance, type MsgGrantAllowanceParams } from "secretjs";
import { config } from "./config.js";
import { getProviderClient, getProviderAddress, readClient, getSscrtCodeHash } from "./chain.js";
import { db } from "./db.js";
import type { Permit } from "secretjs";
import { getSettings } from "./settings.js";

export class OnboardError extends Error {
  constructor(
    message: string,
    public code: "insufficient_balance",
  ) {
    super(message);
  }
}

// Measured across every grant this provider has issued: 14907-17633 gas. Cosmos charges the
// limit, not the usage.
const GRANT_GAS_LIMIT = 26_000;
// The revoke and the grant together simulate at 17356.
const REGRANT_GAS_LIMIT = 30_000;

export interface OnboardResult {
  address: string;
  /** Collected once, inside the first sponsored transaction, and not refundable. It is not spent
   * on ordinary usage — only a failed transaction draws on it. */
  securityDepositSscrt: string;
  sscrtBalance: string;
  grantSpendLimitUscrt: string;
}

export interface GrantRow {
  address: string;
  spend_limit_uscrt: string;
  expires_at: string;
  allowed_messages: string;
  grant_tx_hash: string;
  stage: "bootstrap" | "full";
  fee_collected: number;
}

// protobuf's well-known Timestamp is {seconds, nanos}, not a JS Date — secretjs doesn't
// export a Date->Timestamp helper, so this is the whole conversion.
function toProtoTimestamp(date: Date) {
  const ms = date.getTime();
  // secretjs's generated Timestamp type has `seconds: string` (protobufjs int64-as-string),
  // not a bigint/number — passing the wrong type serializes silently into garbage that the
  // chain reads back as "before current block time" rather than throwing at encode time.
  return { seconds: String(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1e6 };
}

function allowanceParams(address: string, spendLimitUscrt: string, expiresAt: Date): MsgGrantAllowanceParams {
  return {
    granter: getProviderAddress(),
    grantee: address,
    allowance: {
      allowance: {
        spend_limit: [{ denom: "uscrt", amount: spendLimitUscrt }],
        expiration: toProtoTimestamp(expiresAt) as any,
      },
      allowed_messages: config.allowedMessageTypes,
    },
  };
}

function saveGrant(
  address: string,
  spendLimitUscrt: string,
  expiresAt: Date,
  txHash: string,
  stage: "bootstrap" | "full",
  feeCollected: boolean,
): void {
  db.prepare(
    `INSERT INTO grants (address, spend_limit_uscrt, expires_at, allowed_messages, grant_tx_hash, stage, fee_collected)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET
       spend_limit_uscrt = excluded.spend_limit_uscrt,
       expires_at = excluded.expires_at,
       allowed_messages = excluded.allowed_messages,
       grant_tx_hash = excluded.grant_tx_hash,
       stage = excluded.stage,
       fee_collected = excluded.fee_collected`,
  ).run(
    address,
    spendLimitUscrt,
    expiresAt.toISOString(),
    JSON.stringify(config.allowedMessageTypes),
    txHash,
    stage,
    feeCollected ? 1 : 0,
  );
}

/**
 * Stage 1. Free on both sides: no transaction, no grant, nothing the caller can make the provider
 * pay for. The balance check is the point — an address that cannot cover the onboarding fee plus
 * a transaction will never pay for the grant it is asking for, so it does not get one.
 */
export async function onboardUser(address: string, permit: Permit): Promise<OnboardResult> {
  const settings = getSettings();
  const deposit = BigInt(settings.securityDepositUscrt);
  const balance = BigInt(await readBalanceWithPermit(permit));

  // A typical sponsored transaction on top of the deposit, so the first quote is not refused
  // straight after onboarding has said yes.
  const headroom = deposit / 10n;
  if (balance < deposit + headroom) {
    throw new OnboardError(
      `sSCRT balance too low to onboard: have ${balance}, need at least ${deposit + headroom} ` +
        `(a one-off security deposit of ${deposit}, collected with your first transaction, plus gas)`,
      "insufficient_balance",
    );
  }

  db.prepare(
    `INSERT INTO permits (address, permit_json) VALUES (?, ?)
     ON CONFLICT(address) DO UPDATE SET permit_json = excluded.permit_json`,
  ).run(address, JSON.stringify(permit));

  return {
    address,
    securityDepositSscrt: settings.securityDepositUscrt,
    sscrtBalance: balance.toString(),
    grantSpendLimitUscrt: settings.grantSpendLimitUscrt,
  };
}

/**
 * Stage 2. A grant covering exactly one transaction — this one. If the user never pays, that is
 * the whole loss, and the address is spent.
 */
export async function issueBootstrapGrant(address: string, feeUscrt: string): Promise<void> {
  const expiresAt = new Date(Date.now() + getSettings().grantExpirySeconds * 1000);
  try {
    const tx = await getProviderClient().tx.feegrant.grantAllowance(allowanceParams(address, feeUscrt, expiresAt), {
      gasLimit: GRANT_GAS_LIMIT,
      gasPriceInFeeDenom: config.nativeGasPriceUscrt,
      feeDenom: "uscrt",
    });
    if (tx.code !== 0) throw new Error(`bootstrap grant failed (code ${tx.code}): ${tx.rawLog}`);
    saveGrant(address, feeUscrt, expiresAt, tx.transactionHash, "bootstrap", false);
  } catch (err) {
    // The database and the chain can disagree: restore this server from a backup, or lose the
    // file, and addresses that already hold a perfectly good grant look new here. Issuing another
    // one is rejected, and without this every one of those users would be permanently unable to
    // get a quote.
    //
    // Adopting the existing grant is also the only honest option: it was paid for under whatever
    // rules applied when it was issued, and there is no way to charge for it again now.
    if (!/fee allowance already exists/i.test((err as Error).message)) throw err;
    await adoptExistingGrant(address);
  }
}

/** Records a grant that is on chain but missing from this database, as already paid for. */
async function adoptExistingGrant(address: string): Promise<void> {
  const resp = await fetch(`${config.lcdUrl}/cosmos/feegrant/v1beta1/allowance/${getProviderAddress()}/${address}`);
  const body = resp.ok ? await resp.json() : null;
  const outer = body?.allowance?.allowance;
  const inner = outer?.allowance ?? outer;
  const limit = inner?.spend_limit?.find((c: { denom: string }) => c.denom === "uscrt")?.amount;
  const expiration = inner?.expiration;
  if (!limit) {
    throw new Error(
      `a fee allowance for ${address} exists on chain but could not be read back — refusing to quote against a grant of unknown size`,
    );
  }
  saveGrant(address, limit, expiration ? new Date(expiration) : new Date(Date.now() + 86_400_000), "adopted", "full", true);
}

/** Records that the security deposit arrived, so the grant may be raised. */
export function markFeeCollected(address: string): void {
  db.prepare(`UPDATE grants SET fee_collected = 1 WHERE address = ?`).run(address);
}

/**
 * Stage 3. Replaces a bootstrap grant with the full spend limit, in one transaction.
 *
 * Safe to call repeatedly and safe to fail: it returns false rather than throwing, because every
 * caller reaches it *after* the user's transaction has already succeeded, and a bookkeeping step
 * must never turn a completed transaction into an error. A failure here simply leaves the address
 * on its bootstrap grant, and the next quote tries again.
 */
export async function ensureFullGrant(address: string): Promise<boolean> {
  const grant = getStoredGrant(address);
  if (!grant || grant.stage === "full" || !grant.fee_collected) return false;

  const settings = getSettings();
  const expiresAt = new Date(Date.now() + settings.grantExpirySeconds * 1000);
  const granter = getProviderAddress();

  try {
    // Revoke and grant in one transaction. Two separate transactions would leave a window in
    // which the address holds no grant at all, and a quote issued in that window would produce a
    // transaction the chain refuses at ante.
    const tx = await getProviderClient().tx.broadcast(
      [
        new MsgRevokeAllowance({ granter, grantee: address }),
        new MsgGrantAllowance(allowanceParams(address, settings.grantSpendLimitUscrt, expiresAt)),
      ],
      { gasLimit: REGRANT_GAS_LIMIT, gasPriceInFeeDenom: config.nativeGasPriceUscrt, feeDenom: "uscrt" },
    );
    if (tx.code !== 0) return false;
    saveGrant(address, settings.grantSpendLimitUscrt, expiresAt, tx.transactionHash, "full", true);
    return true;
  } catch {
    return false;
  }
}

async function readBalanceWithPermit(permit: Permit): Promise<string> {
  const codeHash = await getSscrtCodeHash();
  const result = (await readClient.query.compute.queryContract({
    contract_address: config.sscrtContract,
    code_hash: codeHash,
    query: { with_permit: { permit, query: { balance: {} } } },
  })) as { balance?: { amount?: string } };
  return result?.balance?.amount ?? "0";
}

export function getStoredPermit(address: string): Permit | null {
  const row = db.prepare(`SELECT permit_json FROM permits WHERE address = ?`).get(address) as
    | { permit_json: string }
    | undefined;
  return row ? JSON.parse(row.permit_json) : null;
}

export function getStoredGrant(address: string): GrantRow | undefined {
  return db.prepare(`SELECT * FROM grants WHERE address = ?`).get(address) as GrantRow | undefined;
}
