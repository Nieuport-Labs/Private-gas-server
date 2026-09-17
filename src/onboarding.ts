// Onboarding: the one-time setup per user, described in the plan under "1. Onboarding".
//
// Two independent things happen here, and only the first requires the provider to spend
// its own gas:
//   1. MsgGrantAllowance — an AllowedMsgAllowance wrapping a BasicAllowance, scoped to a
//      fixed set of message types with a spend limit and expiry. This is what step 0
//      verified end to end: it creates the grantee's x/auth account as a side effect, even
//      for an address that has never held a single uscrt.
//   2. Storing the user's SNIP-24 "balance" permit, which the smoke test proved lets the
//      server read the private sSCRT balance without ever holding a viewing key.
//
// Neither step requires the user to have signed anything for (1) — the provider signs the
// grant with its own key/sequence. The permit in (2) IS signed by the user, off-chain, no
// gas, and handed to the server directly (not broadcast).
import type { MsgGrantAllowanceParams } from "secretjs";
import { config } from "./config.js";
import { providerClient, providerAddress } from "./chain.js";
import { db } from "./db.js";
import type { Permit } from "secretjs";

export interface OnboardResult {
  grantTxHash: string;
  grantedTo: string;
  spendLimitUscrt: string;
  expiresAt: string;
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

export async function onboardUser(address: string, permit: Permit): Promise<OnboardResult> {
  const expiresAt = new Date(Date.now() + config.grantExpirySeconds * 1000);

  const params: MsgGrantAllowanceParams = {
    granter: providerAddress,
    grantee: address,
    allowance: {
      allowance: {
        spend_limit: [{ denom: "uscrt", amount: config.grantSpendLimitUscrt }],
        expiration: toProtoTimestamp(expiresAt) as any,
      },
      allowed_messages: config.allowedMessageTypes,
    },
  };

  const tx = await providerClient.tx.feegrant.grantAllowance(params, {
    gasLimit: 150_000,
    gasPriceInFeeDenom: config.nativeGasPriceUscrt,
    feeDenom: "uscrt",
  });

  if (tx.code !== 0) {
    throw new Error(`grant tx failed (code ${tx.code}): ${tx.rawLog}`);
  }

  db.prepare(
    `INSERT INTO grants (address, spend_limit_uscrt, expires_at, allowed_messages, grant_tx_hash)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET
       spend_limit_uscrt = excluded.spend_limit_uscrt,
       expires_at = excluded.expires_at,
       allowed_messages = excluded.allowed_messages,
       grant_tx_hash = excluded.grant_tx_hash`,
  ).run(
    address,
    config.grantSpendLimitUscrt,
    expiresAt.toISOString(),
    JSON.stringify(config.allowedMessageTypes),
    tx.transactionHash,
  );

  db.prepare(
    `INSERT INTO permits (address, permit_json) VALUES (?, ?)
     ON CONFLICT(address) DO UPDATE SET permit_json = excluded.permit_json`,
  ).run(address, JSON.stringify(permit));

  return {
    grantTxHash: tx.transactionHash,
    grantedTo: address,
    spendLimitUscrt: config.grantSpendLimitUscrt,
    expiresAt: expiresAt.toISOString(),
  };
}

export function getStoredPermit(address: string): Permit | null {
  const row = db.prepare(`SELECT permit_json FROM permits WHERE address = ?`).get(address) as
    | { permit_json: string }
    | undefined;
  return row ? JSON.parse(row.permit_json) : null;
}

export function getStoredGrant(address: string) {
  return db.prepare(`SELECT * FROM grants WHERE address = ?`).get(address) as
    | {
        address: string;
        spend_limit_uscrt: string;
        expires_at: string;
        allowed_messages: string;
        grant_tx_hash: string;
      }
    | undefined;
}
