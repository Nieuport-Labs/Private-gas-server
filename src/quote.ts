// Quoting a gas credit purchase.
//
// This used to quote whatever the client asked for: a bundle of [the user's action, a payment to
// the provider], sponsored with the provider's fee grant. That design put the server in the path
// of every transaction its users ever made, which is why it needed a contract whitelist, a gas
// constant per contract, a prediction of whether the action would fail, and a security deposit to
// cover it when the prediction was wrong. Every one of those existed to manage the risk of
// sponsoring somebody else's unknown message.
//
// It sponsors one message now, and builds it itself: an sSCRT transfer paying for gas credits.
// The client supplies no messages at all. Afterwards the buyer has credits, pays their own fees
// from the vault, and does not come back — so the server never sees what they do with them.
//
// What survives from the old design is the part that was actually load-bearing: every byte is
// built here, /submit compares the signed transaction against these bytes, and nothing else can
// be smuggled into a transaction the provider is paying for.
import { randomUUID } from "node:crypto";
import { toBase64 } from "secretjs";
import { config } from "./config.js";
import { db } from "./db.js";
import { getAccount, getSscrtCodeHash, getProviderAddress, readClient } from "./chain.js";
import { getStoredGrant, getStoredPermit, issueBootstrapGrant } from "./onboarding.js";
import { getPaymentGasConstant, buildPaymentMessage, getServerEncryptionUtils } from "./payment.js";
import { getSettings } from "./settings.js";
import { priceRequestedCredits, CreditSaleError } from "./creditSale.js";
import { GAS_BUY, queryRemaining } from "./gasVault.js";
import type { QuotedTx } from "./txVerify.js";

export class QuoteError extends Error {
  constructor(
    message: string,
    public code:
      | "no_permit"
      | "insufficient_balance"
      | "no_pubkey"
      | "credits_unavailable"
      | "bad_amount"
      | "margin_too_low",
  ) {
    super(message);
  }
}

const GAS_BUFFER = 1.2;

export interface PurchaseQuoteRequest {
  address: string;
  /** Required for an address that has never signed anything — the server has no other way to
   * learn its pubkey. Base64, secp256k1 compressed. */
  pubkeyBase64?: string;
  /** How much credit to buy, in uscrt. Defaults to the configured purchase size. */
  creditAmountUscrt?: string;
}

export interface QuoteResult {
  quoteId: string;
  /** Amino-JSON, for the client's wallet to display. */
  messages: unknown[];
  /** The same message as encoded protobuf, base64. The client must sign THESE — /submit compares
   * them byte for byte, which is what ties the signed transaction to this quote. */
  protoMessages: { typeUrl: string; bytes: string }[];
  gasLimit: number;
  feeAmountUscrt: string;
  feeGranter: string;
  /** What the buyer pays, in sSCRT base units. */
  sscrtPaymentAmount: string;
  /** What they get, in uscrt of fee allowance from the vault. */
  creditsUscrt: string;
  /** The vault that will hold the allowance — what the buyer sets as `fee.granter` afterwards. */
  gasVaultAddress: string;
  accountNumber: number;
  sequence: number;
  expiresAt: string;
}

/**
 * Build and price the one transaction the provider is willing to pay for.
 *
 * The order of checks is deliberate and unchanged in spirit from the old design: everything that
 * can refuse this quote for free is checked before anything is issued on chain, because issuing
 * the bootstrap grant is the first moment the provider spends its own money.
 */
export async function requestPurchaseQuote(req: PurchaseQuoteRequest): Promise<QuoteResult> {
  const settings = getSettings();
  if (!settings.gasVaultAddress) {
    throw new QuoteError(
      "this provider is not configured with a gas vault, so it cannot sell credits",
      "credits_unavailable",
    );
  }

  // The permit is what says this address has been onboarded, and it is the only reason the server
  // holds anything of theirs. It buys one thing: knowing, before spending its own gas, that the
  // payment will not bounce. A SNIP-20 balance is private, and reading the provider's own balance
  // afterwards answers the question too late to matter.
  const permit = getStoredPermit(req.address);
  if (!permit) {
    throw new QuoteError(`no stored balance permit for ${req.address} — run onboarding first`, "no_permit");
  }

  let sale;
  try {
    sale = priceRequestedCredits(req.creditAmountUscrt);
  } catch (err) {
    if (err instanceof CreditSaleError) throw new QuoteError(err.message, "bad_amount");
    throw err;
  }

  const codeHash = await getSscrtCodeHash();
  const balanceResult = (await readClient.query.compute.queryContract({
    contract_address: config.sscrtContract,
    code_hash: codeHash,
    query: { with_permit: { permit, query: { balance: {} } } },
  })) as { balance?: { amount?: string } };
  const balance = BigInt(balanceResult?.balance?.amount ?? "0");

  // One SNIP-20 transfer, so the calibrated payment constant is exactly the right measurement.
  const gasLimit = Math.ceil(getPaymentGasConstant() * GAS_BUFFER);
  const feeAmountUscrt = String(Math.ceil(gasLimit * config.nativeGasPriceUscrt));

  // What this sale costs the provider: the buyer's transaction, which its grant pays for, plus
  // the delivery transaction it signs afterwards. Both come out of the markup, and a markup that
  // does not cover them turns every sale into a loss — quietly, one purchase at a time. Better to
  // refuse and say why than to discover it in the native balance a week later.
  const deliveryFee = BigInt(Math.ceil(GAS_BUY * config.nativeGasPriceUscrt));
  const providerCost = BigInt(feeAmountUscrt) + deliveryFee;
  const margin = BigInt(sale.priceSscrt) - BigInt(sale.creditsUscrt);
  if (margin < providerCost) {
    throw new QuoteError(
      `a markup of ${sale.markupPercent}% leaves ${margin} uscrt on this sale but it costs the ` +
        `provider ${providerCost} (${feeAmountUscrt} for your transaction, ${deliveryFee} to ` +
        "deliver the credits) — raise the markup or the purchase size",
      "margin_too_low",
    );
  }

  if (balance < BigInt(sale.priceSscrt)) {
    throw new QuoteError(
      `insufficient sSCRT balance: have ${balance}, need ${sale.priceSscrt} for ` +
        `${sale.creditsUscrt} uscrt of gas credits`,
      "insufficient_balance",
    );
  }

  // Who pays for this transaction, and the answer is usually "not the provider".
  //
  // A per-address allowance is the only way an address holding nothing can sign anything at all
  // -- the fee is settled in the ante handler, so it comes from the signer's balance or from a
  // granter, and Cosmos has no grant-to-everybody. But it is only needed by an address that
  // genuinely cannot pay, and this used to issue one to anybody who asked. An address with gas
  // credits already, or with native SCRT, was costing the provider a transaction for nothing.
  const feeGranter = await chooseFeeGranter(req.address, BigInt(feeAmountUscrt), settings.bootstrapGrantUscrt);

  const account = await getAccount(req.address);
  const pubkeyBase64 = account.pubkeyBase64 ?? req.pubkeyBase64;
  if (!pubkeyBase64) {
    throw new QuoteError(
      "no pubkey on file and none supplied — this looks like this address's first-ever " +
        "transaction; the client must include pubkeyBase64 (e.g. from Keplr's getKey())",
      "no_pubkey",
    );
  }

  const message = buildPaymentMessage(req.address, sale.priceSscrt, codeHash);
  // Both forms from the same instance on purpose. MsgExecuteContract encrypts with a random nonce
  // and caches the result, so one instance yields one ciphertext in both; a second instance would
  // produce different bytes, and the document the user signs would then describe a different
  // message from the one in the transaction body.
  const amino = await message.toAmino(getServerEncryptionUtils());
  const proto = await message.toProto(getServerEncryptionUtils());
  const protoMessages = [{ typeUrl: proto.type_url, bytes: toBase64(proto.encode()) }];

  // Typed, not cast: this is exactly what /submit compares against, and the one bug this check
  // has had came from the two sides disagreeing about the shape in silence.
  const verification: QuotedTx = {
    messages: protoMessages,
    gasLimit,
    feeAmountUscrt,
    feeGranter,
  };

  const quoteId = randomUUID();
  const expiresAt = new Date(Date.now() + config.quoteTtlSeconds * 1000);

  db.prepare(
    `INSERT INTO quotes
       (quote_id, address, sequence, account_number, sign_doc_json, sscrt_payment_amount, gas_limit, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    quoteId,
    req.address,
    account.sequence,
    account.accountNumber,
    JSON.stringify({
      messages: [amino],
      verification,
      creditsUscrt: sale.creditsUscrt,
      gasLimit,
      feeAmountUscrt,
      feeGranter,
    }),
    sale.priceSscrt,
    gasLimit,
    expiresAt.toISOString(),
  );

  return {
    quoteId,
    messages: [amino],
    protoMessages,
    gasLimit,
    feeAmountUscrt,
    feeGranter,
    sscrtPaymentAmount: sale.priceSscrt,
    creditsUscrt: sale.creditsUscrt,
    gasVaultAddress: settings.gasVaultAddress,
    accountNumber: account.accountNumber,
    sequence: account.sequence,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Decide who pays the fee for the purchase, and issue an allowance only if nobody else can.
 *
 * Three answers, cheapest to the provider first:
 *
 *   the vault    — the address already has gas credits. Costs the provider nothing.
 *   nobody       — the address holds native SCRT and pays its own way. Also nothing.
 *   the provider — the genuine cold start, and the only case that spends its money.
 *
 * The last one is unavoidable, not a leftover: the fee is settled in the ante handler before any
 * message runs, so it comes from the signer's own balance or from a granter named in the
 * transaction, and `x/feegrant` has no grant-to-everybody. An address holding nothing therefore
 * cannot sign anything until somebody grants to it by name. `Fee.payer` would be the other way
 * round, but a payer who is not the signer has to sign too, and secretjs signs for one wallet.
 *
 * A grant is also what creates the grantee's account, which is why it has to happen before the
 * account number and sequence are read.
 */
async function chooseFeeGranter(
  address: string,
  feeUscrt: bigint,
  bootstrapGrantUscrt: string,
): Promise<string> {
  // A grant already on file is used whatever else is true: it was paid for, it expires on its
  // own, and issuing a second one is what an address that never pays would be farming.
  if (getStoredGrant(address)) return getProviderAddress();

  const credits = await queryRemaining(address).catch(() => null);
  if (credits !== null && BigInt(credits) >= feeUscrt) return getSettings().gasVaultAddress;

  const native = await readClient.query.bank
    .balance({ address, denom: "uscrt" })
    .then((r) => BigInt(r.balance?.amount ?? "0"))
    .catch(() => 0n);
  if (native >= feeUscrt) return "";

  await issueBootstrapGrant(address, bootstrapGrantUscrt);
  return getProviderAddress();
}

/** How much credit a quote promised, read back at /submit. */
export function quotedCredits(signDocJson: string): string | null {
  try {
    const value = (JSON.parse(signDocJson) as Record<string, unknown>).creditsUscrt;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}
