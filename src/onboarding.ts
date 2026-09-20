// The one moment a gas provider is involved at all.
//
// A wallet holding only sSCRT cannot pay a fee, and buying gas credits is itself a transaction,
// so it cannot buy its way out. Breaking that deadlock needs somebody else to pay for exactly
// one transaction. That is all this does, and there are two steps:
//
//   onboardUser        keeps the permit, issues nothing, spends nothing. It reads the balance
//                      through that permit and refuses an address that could not pay for credits
//                      anyway. This is the real defence: an attacker has to park a genuine
//                      balance in every address before the provider spends a single uscrt on one.
//
//   issueBootstrapGrant  called by the quote, and only for an address that cannot pay any other
//                      way: enough for one transaction, restricted to the one message type that
//                      transaction contains, expiring in minutes.
//
// There is no third step. An earlier design raised the grant to a full spend limit so the
// provider could keep sponsoring; now the buyer leaves with credits and pays their own fees from
// the vault, so the grant has nothing to become. Whatever it has left over is abandoned rather
// than revoked -- reclaiming it costs another transaction worth more than the remainder, which
// is what the short expiry is for.
//
// The permit is deleted the moment the credits are delivered (creditDelivery.ts). It buys one
// thing, the balance check above, and that need genuinely ends rather than merely going quiet.
import { type MsgGrantAllowanceParams, type Permit } from "secretjs";
import { config } from "./config.js";
import { getProviderClient, getProviderAddress, readClient, getSscrtCodeHash } from "./chain.js";
import { db } from "./db.js";
import { getSettings } from "./settings.js";
import { affordablePurchase, CreditSaleError } from "./creditSale.js";

export class OnboardError extends Error {
  constructor(
    message: string,
    public code: "insufficient_balance",
  ) {
    super(message);
  }
}

/** Measured across every grant this provider has issued: 14907-17633 gas. The limit is charged. */
const GRANT_GAS_LIMIT = 26_000;

/**
 * The bootstrap grant pays for one message and no other kind.
 *
 * `AllowedMsgAllowance` cannot restrict which *contract* is called — the SDK filters by message
 * type only — so this does not pin the grant to the sSCRT transfer specifically. What pins that
 * is txVerify.ts, which compares the signed bytes against the quote. This is the cheap half: a
 * leaked grant cannot be spent on staking, voting or a bank send.
 */
const BOOTSTRAP_ALLOWED_MESSAGES = ["/secret.compute.v1beta1.MsgExecuteContract"];

export interface OnboardResult {
  address: string;
  /** What one purchase of gas credits costs, in sSCRT base units. */
  creditPriceSscrt: string;
  /** What it buys, in uscrt of fee allowance. */
  creditsUscrt: string;
  sscrtBalance: string;
  /** The vault the allowance comes from — what the buyer names as `fee.granter` afterwards. */
  gasVaultAddress: string;
}

export interface GrantRow {
  address: string;
  spend_limit_uscrt: string;
  expires_at: string;
  allowed_messages: string;
  grant_tx_hash: string;
}

/**
 * protobuf's Timestamp is {seconds, nanos}, and `seconds` is a string.
 *
 * Passing a number or a bigint there serialises silently into a different value, which the chain
 * reads back as "expiration is before current block time" rather than as an encoding error. That
 * cost an afternoon once.
 */
function toProtoTimestamp(date: Date) {
  const ms = date.getTime();
  return { seconds: String(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1e6 };
}

/**
 * Stage 1. Free on both sides: no transaction, no grant, nothing the caller can make the
 * provider pay for. The balance check is the point.
 */
export async function onboardUser(address: string, permit: Permit): Promise<OnboardResult> {
  const balance = await readBalanceWithPermit(permit);

  // Sized to what this wallet holds, not to a fixed figure it may not reach.
  //
  // Refusing anyone below the full purchase was a real hole in what this is for. Somebody who
  // has only ever been paid privately in sSCRT would have had to go and buy more before they
  // could transact — from an exchange, or from whoever paid them — and either is a public event
  // linking two parties the encrypted transfer had just kept apart.
  let sale;
  try {
    sale = affordablePurchase(balance);
  } catch (err) {
    if (err instanceof CreditSaleError) throw new OnboardError(err.message, "insufficient_balance");
    throw err;
  }

  db.prepare(
    `INSERT INTO permits (address, permit_json) VALUES (?, ?)
     ON CONFLICT(address) DO UPDATE SET permit_json = excluded.permit_json`,
  ).run(address, JSON.stringify(permit));

  return {
    address,
    creditPriceSscrt: sale.priceSscrt,
    creditsUscrt: sale.creditsUscrt,
    sscrtBalance: balance,
    gasVaultAddress: getSettings().gasVaultAddress,
  };
}

/**
 * Stage 2. A grant covering exactly one transaction — this one.
 *
 * If the buyer never pays, that is the whole loss, around 0.0026 SCRT, and the address is spent:
 * `getStoredGrant` finding a row is what stops a second grant going to an address that has not
 * used its first.
 */
export async function issueBootstrapGrant(address: string, feeUscrt: string): Promise<void> {
  const expiresAt = new Date(Date.now() + getSettings().bootstrapGrantExpirySeconds * 1000);
  const params: MsgGrantAllowanceParams = {
    granter: getProviderAddress(),
    grantee: address,
    allowance: {
      allowance: {
        spend_limit: [{ denom: "uscrt", amount: feeUscrt }],
        expiration: toProtoTimestamp(expiresAt) as never,
      },
      allowed_messages: BOOTSTRAP_ALLOWED_MESSAGES,
    },
  };

  try {
    const tx = await getProviderClient().tx.feegrant.grantAllowance(params, {
      gasLimit: GRANT_GAS_LIMIT,
      gasPriceInFeeDenom: config.nativeGasPriceUscrt,
      feeDenom: "uscrt",
    });
    if (tx.code !== 0) throw new Error(`bootstrap grant failed (code ${tx.code}): ${tx.rawLog}`);
    saveGrant(address, feeUscrt, expiresAt, tx.transactionHash);
  } catch (err) {
    // The database and the chain can disagree — restore from a backup, or lose the file, and an
    // address holding a perfectly good grant looks new here. A second grant for the same pair is
    // rejected, and without this every one of those users would be permanently unable to buy.
    //
    // Adopting the existing grant is also the only honest option: it was paid for under whatever
    // rules applied when it was issued, and there is no way to charge for it again now.
    if (!/fee allowance already exists/i.test((err as Error).message)) throw err;
    await adoptExistingGrant(address);
  }
}

function saveGrant(address: string, spendLimitUscrt: string, expiresAt: Date, txHash: string): void {
  db.prepare(
    `INSERT INTO grants (address, spend_limit_uscrt, expires_at, allowed_messages, grant_tx_hash)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET
       spend_limit_uscrt = excluded.spend_limit_uscrt,
       expires_at = excluded.expires_at,
       allowed_messages = excluded.allowed_messages,
       grant_tx_hash = excluded.grant_tx_hash`,
  ).run(address, spendLimitUscrt, expiresAt.toISOString(), JSON.stringify(BOOTSTRAP_ALLOWED_MESSAGES), txHash);
}

/** Records a grant that is on chain but missing from this database. */
async function adoptExistingGrant(address: string): Promise<void> {
  const resp = await fetch(
    `${config.lcdUrl}/cosmos/feegrant/v1beta1/allowance/${getProviderAddress()}/${address}`,
  );
  const body = resp.ok ? ((await resp.json()) as Record<string, never>) : null;
  // AllowedMsgAllowance wraps a BasicAllowance; a bare BasicAllowance has the limit at the top
  // level. Handle both rather than assume the shape whoever granted it happened to use.
  const outer = (body as never as { allowance?: { allowance?: never } })?.allowance?.allowance as
    | { allowance?: unknown; spend_limit?: { denom: string; amount: string }[]; expiration?: string }
    | undefined;
  const inner = (outer?.allowance ?? outer) as
    | { spend_limit?: { denom: string; amount: string }[]; expiration?: string }
    | undefined;
  const limit = inner?.spend_limit?.find((c) => c.denom === "uscrt")?.amount;
  if (!limit) {
    throw new Error(
      `a fee allowance for ${address} exists on chain but could not be read back — refusing to ` +
        "quote against a grant of unknown size",
    );
  }
  saveGrant(
    address,
    limit,
    inner?.expiration ? new Date(inner.expiration) : new Date(Date.now() + 86_400_000),
    "adopted",
  );
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
 * This is a promise, not a proof — SNIP-24 has no expiry, so the signature stays valid until the
 * holder revokes it on the contract. Anyone who wants that guaranteed rather than undertaken
 * should revoke; the app offers a button for it.
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
