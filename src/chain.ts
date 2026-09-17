// The provider's own signer (used ONLY for grant management — MsgGrantAllowance /
// MsgRevokeAllowance) and a read-only client for chain queries that don't need any key.
//
// Deliberately never used to sign a user's action+payment bundle — per the plan, that
// transaction is signed solely by the user in Keplr; the server only builds the SignDoc,
// validates, and broadcasts already-signed bytes.
import { SecretNetworkClient } from "secretjs";
import { config } from "./config.js";
import { getProviderAddress, getProviderClient } from "./wallet.js";
import { withRetry } from "./retry.js";

export { getProviderAddress, getProviderClient } from "./wallet.js";

// A client with no wallet at all — used for read-only queries (account info, balance via a
// user-supplied permit, simulate). Nothing here can sign anything.
export const readClient = new SecretNetworkClient({
  url: config.lcdUrl,
  chainId: config.chainId,
});

export async function getAccount(address: string): Promise<{
  accountNumber: number;
  sequence: number;
  exists: boolean;
  /** base64 secp256k1 pubkey, present once the address has signed anything before; absent
   * for an address onboarded (via MsgGrantAllowance) but not yet self-signed once. */
  pubkeyBase64: string | null;
}> {
  try {
    const acc = await withRetry(() => readClient.query.auth.account({ address }));
    // The account object here is NOT wrapped in `.value` (that's an Amino/legacy JSON
    // convention some CLI output uses) — the LCD/gRPC-gateway response nests fields directly
    // under `.account`, with the pubkey as `.account.pub_key.key`, not `.public_key.value`.
    const raw = acc.account as any;
    return {
      accountNumber: Number(raw?.account_number ?? 0),
      sequence: Number(raw?.sequence ?? 0),
      exists: true,
      pubkeyBase64: raw?.pub_key?.key ?? null,
    };
  } catch {
    // Matches what step 0 verified manually: a brand-new address with no grant yet has no
    // account at all. Once onboarding runs MsgGrantAllowance, this branch stops firing for
    // that address — the account exists from then on, with a normally-queryable sequence.
    return { accountNumber: 0, sequence: 0, exists: false, pubkeyBase64: null };
  }
}

export async function getSscrtCodeHash(): Promise<string> {
  const resp = await withRetry(() =>
    readClient.query.compute.codeHashByContractAddress({ contract_address: config.sscrtContract }),
  );
  if (!resp.code_hash) throw new Error("could not resolve sSCRT code hash");
  return resp.code_hash;
}

// The provider's own reserves — native uscrt (what it spends on grants) and sSCRT (what it gets
// paid back in). Used by the /status endpoint and by autoUnwrap.ts to decide when to redeem.
// The sSCRT side reads its own private balance the same way it reads anyone else's: a
// self-signed SNIP-24 permit, no viewing key needed (same mechanism proven in smoke-permit.ts).
export async function getProviderBalances(): Promise<{ uscrt: string; sscrt: string }> {
  const providerAddress = getProviderAddress();
  const providerClient = getProviderClient();

  const [nativeBalance, codeHash] = await Promise.all([
    withRetry(() => readClient.query.bank.balance({ address: providerAddress, denom: "uscrt" })),
    getSscrtCodeHash(),
  ]);

  const permit = await providerClient.utils.accessControl.permit.sign(
    providerAddress,
    config.chainId,
    "provider-own-balance-check",
    [config.sscrtContract],
    ["balance"],
    false,
  );
  const sscrtResult: any = await withRetry(() =>
    providerClient.query.compute.queryContract({
      contract_address: config.sscrtContract,
      code_hash: codeHash,
      query: { with_permit: { permit, query: { balance: {} } } },
    }),
  );

  return {
    uscrt: nativeBalance.balance?.amount ?? "0",
    sscrt: sscrtResult?.balance?.amount ?? "0",
  };
}

// /status is polled continuously by the dashboard — every 10s normally, every 2s while a
// maintenance job runs — and each call above costs three chain queries. Unthrottled that is
// enough on its own to exhaust a public endpoint's rate limit, which then breaks the very job
// being watched. Serving a slightly stale figure to a status panel is free by comparison.
//
// Deliberately not used by wrapScrt or autoUnwrap: those read balances to report or decide on a
// real change, where a stale answer would be wrong rather than merely old.
let balanceCache: { at: number; value: { uscrt: string; sscrt: string } } | null = null;
const BALANCE_CACHE_MS = 10_000;

export async function getProviderBalancesCached(): Promise<{ uscrt: string; sscrt: string }> {
  if (balanceCache && Date.now() - balanceCache.at < BALANCE_CACHE_MS) return balanceCache.value;
  const value = await getProviderBalances();
  balanceCache = { at: Date.now(), value };
  return value;
}
