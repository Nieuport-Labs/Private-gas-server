// The gas-vault contract, from the provider's side.
//
// A gas credit is an ordinary `BasicAllowance` fee grant whose granter is a contract rather than
// a wallet: pay SCRT into the vault naming an address, and that address gets an allowance of the
// same size. The provider sells credits, so it is the one paying in — and it pays with its own
// key, in its own transaction, which is the one thing this module does that costs money.
//
// The vault grants exactly what it is sent, 1:1, with no notion of a fee. The markup therefore
// lives here, outside the contract: the buyer is charged in sSCRT (creditSale.ts) and the vault
// is paid the smaller number.
import { config } from "./config.js";
import { getProviderAddress, getProviderClient, readClient } from "./chain.js";
import { getSettings } from "./settings.js";
import { withRetry } from "./retry.js";

/** Execute, plus the revoke and grant the contract dispatches. Measured by the vault's own repo. */
export const GAS_BUY = 400_000;

export class GasVaultError extends Error {}

function vaultAddress(): string {
  const address = getSettings().gasVaultAddress;
  if (!address) {
    throw new GasVaultError(
      "no gas vault contract configured — set it in Settings before selling credits",
    );
  }
  return address;
}

// Queries are encrypted against the code hash, and a migration changes it. A stale one does not
// degrade, it stops every query dead with an error that points nowhere near the cause — so it is
// resolved from the chain, cached only for this process, and dropped on failure so the next call
// retries rather than reusing a rejection.
const codeHashes = new Map<string, Promise<string>>();

function codeHashFor(contractAddress: string): Promise<string> {
  const cached = codeHashes.get(contractAddress);
  if (cached) return cached;

  const pending = withRetry(() =>
    readClient.query.compute.codeHashByContractAddress({ contract_address: contractAddress }),
  )
    .then((response) => {
      if (!response.code_hash) throw new GasVaultError(`${contractAddress} returned no code hash`);
      return response.code_hash;
    })
    .catch((err) => {
      codeHashes.delete(contractAddress);
      throw err;
    });

  codeHashes.set(contractAddress, pending);
  return pending;
}

/** Forget cached code hashes — call after the vault address changes, or after a migration. */
export function forgetVaultCodeHash(): void {
  codeHashes.clear();
}

/**
 * What `x/feegrant` says this address still has from the vault, in uscrt.
 *
 * **`null` means the question could not be asked, which is not the same as zero.** The contract
 * reads the figure through a stargate query the chain allow-lists and reserves the right to
 * change; when it cannot, it says so rather than guessing, and so does this.
 */
export async function queryRemaining(grantee: string): Promise<string | null> {
  const address = vaultAddress();
  const code_hash = await codeHashFor(address);
  const reply = (await withRetry(() =>
    readClient.query.compute.queryContract({
      contract_address: address,
      code_hash,
      query: { remaining: { grantee } },
    }),
  )) as { amount?: string | null };
  return reply?.amount ?? null;
}

/**
 * What the vault holds — which is also the sum of every allowance it has issued and not seen
 * spent. The two cannot drift: a purchase raises both by what was paid, and a spent fee lowers
 * both by what it cost, because the chain charges the fee to the granter.
 */
export async function queryVaultStatus(): Promise<{ address: string; balance: string }> {
  const address = vaultAddress();
  const code_hash = await codeHashFor(address);
  const reply = (await withRetry(() =>
    readClient.query.compute.queryContract({
      contract_address: address,
      code_hash,
      query: { status: {} },
    }),
  )) as { balance?: string };
  return { address, balance: reply?.balance ?? "0" };
}

export interface DeliveryResult {
  txHash: string;
  code: number;
  rawLog: string;
}

/**
 * Buy `amountUscrt` of gas credits for someone else, out of the provider's own native SCRT.
 *
 * Signed by the provider with its own key and its own sequence. That is not a breach of the rule
 * that the provider never signs a user's transaction — nothing of the user's is in here. It is
 * the provider spending its own money on their behalf, which is what they paid for.
 *
 * Topping up an address that already has credits is handled by the contract: a second
 * `MsgGrantAllowance` for an existing pair is rejected and the SDK has no update message, so the
 * vault reads the live remainder and dispatches a revoke followed by a grant for the new total.
 */
export async function buyCreditsFor(grantee: string, amountUscrt: string): Promise<DeliveryResult> {
  if (!/^\d+$/.test(amountUscrt) || amountUscrt === "0") {
    throw new GasVaultError(`not a positive amount of uscrt: ${amountUscrt}`);
  }

  const address = vaultAddress();
  const code_hash = await codeHashFor(address);

  const tx = await getProviderClient().tx.compute.executeContract(
    {
      sender: getProviderAddress(),
      contract_address: address,
      code_hash,
      msg: { grant: { grantee } },
      // The funds arrive before the contract runs, so this pays for the allowance and tops the
      // vault up in the same transaction.
      sent_funds: [{ denom: "uscrt", amount: amountUscrt }],
    },
    { gasLimit: GAS_BUY, gasPriceInFeeDenom: config.nativeGasPriceUscrt, feeDenom: "uscrt" },
  );

  return { txHash: tx.transactionHash, code: tx.code, rawLog: tx.rawLog ?? "" };
}
