// Onboarding: the one moment a gas provider is involved at all.
//
// A wallet holding only sSCRT cannot pay a fee, and buying gas credits is itself a transaction,
// so it cannot buy its way out. Breaking that deadlock needs somebody else to pay for exactly one
// transaction. That is all this does.
//
//   1. `onboardUser` — keeps the permit, issues nothing, spends nothing. It reads the balance
//      through that permit and refuses an address that could not pay for credits anyway. This is
//      the real defence: an attacker has to park a genuine balance in every address before the
//      provider spends a single uscrt on one.
//   2. `issueBootstrapGrant` — called by the first quote: enough for one sponsored transaction,
//      restricted to the one message type that transaction contains, and expiring in minutes. It
//      cannot be sized to that quote's exact fee, because issuing the grant is also what creates
//      the grantee's account.
//
// There is no third stage any more. The old design raised the grant to a full spend limit so the
// provider could keep sponsoring; now the buyer leaves with credits and pays their own fees from
// the vault, so the bootstrap grant has nothing left to become. Whatever it has left over is
// abandoned rather than revoked — reclaiming it would cost another transaction worth more than
// the remainder, which is why the expiry is short.
//
// The permit is deleted the moment the credits are delivered (see creditDelivery.ts). It bought
// one thing, the balance check above, and that need genuinely ends rather than merely going
// quiet.
import { type MsgGrantAllowanceParams } from "secretjs";
import { config } from "./config.js";
import { getProviderClient, getProviderAddress, readClient, getSscrtCodeHash } from "./chain.js";
import { db } from "./db.js";
import type { Permit } from "secretjs";
import { getSettings } from "./settings.js";
import { defaultPurchase } from "./creditSale.js";

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

/**
 * The bootstrap grant pays for one message and no other kind.
 *
 * `AllowedMsgAllowance` cannot restrict which *contract* is called — the SDK filters by message
 * type only — so this does not pin the grant to the sSCRT transfer specifically. What pins that
 * is txVerify.ts, which compares the signed bytes against the quote. This narrowing is the cheap
 * half: it means a leaked grant cannot be spent on staking, voting or a bank send.
 */
const BOOTSTRAP_ALLOWED_MESSAGES = ["/secret.compute.v1beta1.MsgExecuteContract"];

export interface OnboardResult {
  address: string;
  /** What one purchase of gas credits costs, in sSCRT base units. */
  creditPriceSscrt: string;
  /** What it buys, in uscrt of fee allowance. */
  creditsUscrt: string;
  sscrtBalance: string;
  /** The vault the allowance comes from — what the buyer sets as `fee.granter` afterwards. */
  gasVaultAddress: string;
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

function allowanceParams(
  address: string,
  spendLimitUscrt: string,
  expiresAt: Date,
  allowedMessages: string[],
): MsgGrantAllowanceParams {
  return {
    granter: getProviderAddress(),
    grantee: address,
    allowance: {
      allowance: {
        spend_limit: [{ denom: "uscrt", amount: spendLimitUscrt }],
        expiration: toProtoTimestamp(expiresAt) as any,
      },
      allowed_messages: allowedMessages,
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
    JSON.stringify(BOOTSTRAP_ALLOWED_MESSAGES),
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
  const sale = defaultPurchase();
  const balance = BigInt(await readBalanceWithPermit(permit));

  if (balance < BigInt(sale.priceSscrt)) {
    throw new OnboardError(
      `sSCRT balance too low to buy gas credits: have ${balance}, need ${sale.priceSscrt} ` +
        `for ${sale.creditsUscrt} uscrt of credits`,
      "insufficient_balance",
    );
  }

  db.prepare(
    `INSERT INTO permits (address, permit_json) VALUES (?, ?)
     ON CONFLICT(address) DO UPDATE SET permit_json = excluded.permit_json`,
  ).run(address, JSON.stringify(permit));

  return {
    address,
    creditPriceSscrt: sale.priceSscrt,
    creditsUscrt: sale.creditsUscrt,
    sscrtBalance: balance.toString(),
    gasVaultAddress: settings.gasVaultAddress,
  };
}

/**
 * Stage 2. A grant covering exactly one transaction — this one. If the buyer never pays, that is
 * the whole loss (~0.0026 SCRT), and the address is spent: `getStoredGrant` finding a row is what
 * stops a second grant going to an address that has not used its first.
 */
export async function issueBootstrapGrant(address: string, feeUscrt: string): Promise<void> {
  const expiresAt = new Date(Date.now() + getSettings().bootstrapGrantExpirySeconds * 1000);
  try {
    const tx = await getProviderClient().tx.feegrant.grantAllowance(
      allowanceParams(address, feeUscrt, expiresAt, BOOTSTRAP_ALLOWED_MESSAGES),
      {
        gasLimit: GRANT_GAS_LIMIT,
        gasPriceInFeeDenom: config.nativeGasPriceUscrt,
        feeDenom: "uscrt",
      },
    );
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

async function readBalanceWithPermit(permit: Permit): Promise<string> {
  const codeHash = await getSscrtCodeHash();
  const result = (await readClient.query.compute.queryContract({
    contract_address: config.sscrtContract,
    code_hash: codeHash,
    query: { with_permit: { permit, query: { balance: {} } } },
  })) as { balance?: { amount?: string } };
  return result?.balance?.amount ?? "0";
}

/**
 * Forget an address's permit.
 *
 * Called once the credits are delivered, because that is when the reason for holding it ends.
 * This is a promise, not a proof — SNIP-24 has no expiry, so the signature itself stays valid
 * until the holder revokes it on the contract. Anyone who wants that guaranteed rather than
 * undertaken should revoke; the app offers a button for it.
 */
export function deletePermit(address: string): void {
  db.prepare(`DELETE FROM permits WHERE address = ?`).run(address);
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
