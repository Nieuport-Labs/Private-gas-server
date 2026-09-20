// The /quote step described in the plan: server computes everything a client's own
// secretjs+Keplr wallet needs to build and sign one transaction — [native action message(s),
// sSCRT payment message] — with fee.granter set to the provider. The server never holds or
// touches the user's private key; it hands back terms, the client signs, /submit takes it
// from there (not yet implemented).
import { randomUUID } from "node:crypto";
import { MsgExecuteContract, toBase64, type Msg } from "secretjs";
import { config } from "./config.js";
import { db } from "./db.js";
import { getAccount, getSscrtCodeHash, getProviderAddress } from "./chain.js";
import { getStoredGrant, getStoredPermit, issueBootstrapGrant, ensureFullGrant } from "./onboarding.js";
import { simulateNativeMessages } from "./gasEstimation.js";
import { getPaymentGasConstant, buildPaymentMessage, getServerEncryptionUtils } from "./payment.js";
import { getGasConstant } from "./gasCalibration.js";
import { MSG_EXECUTE_CONTRACT_TYPE_URL } from "./messageRegistry.js";
import { readClient } from "./chain.js";
import { getSettings } from "./settings.js";
import type { QuotedTx } from "./txVerify.js";
import { sscrtOutflow } from "./tokenOutflow.js";
import { getDeposit, topUpNeeded } from "./deposits.js";

export class QuoteError extends Error {
  constructor(
    message: string,
    public code:
      | "no_grant"
      | "message_type_not_allowed"
      | "no_permit"
      | "insufficient_balance"
      | "no_pubkey"
      | "simulate_failed"
      | "contract_not_allowed"
      | "contract_gas_not_calibrated"
      | "deposit_required"
      | "deposit_already_funded",
  ) {
    super(message);
  }
}

export interface QuoteRequest {
  address: string;
  messages: Msg[];
  /** required only for an address that has never signed anything on-chain before — the
   * server has no other way to learn its pubkey. Base64, secp256k1 compressed. */
  pubkeyBase64?: string;
}

export interface QuoteResult {
  quoteId: string;
  messages: unknown[]; // amino-JSON shape, ready for the client's own secretjs wallet to sign
  /** The same messages as encoded protobuf, base64. The client must sign THESE — /submit compares
   * them byte for byte, which is what ties the signed transaction to this quote. */
  protoMessages: { typeUrl: string; bytes: string }[];
  gasLimit: number;
  feeAmountUscrt: string;
  feeGranter: string;
  /** Total the user pays in sSCRT: the gas fee plus markup, plus the onboarding fee if this is
   * the address's first quote. */
  sscrtPaymentAmount: string;
  /** Collected on top of the gas payment to bring the security deposit back to full. The whole
   * deposit on a first quote, zero while it is intact, and the shortfall after a failure. */
  depositTopUpSscrt: string;
  /** What the deposit will hold once this transaction lands. */
  depositAfterSscrt: string;
  accountNumber: number;
  sequence: number;
  expiresAt: string;
}

const GAS_BUFFER = 1.2; // plan: "buffer (~20 %)"

// /submit needs to re-simulate the native part right before broadcast (plan: third
// pre-broadcast check, alongside sequence + balance). Msg instances don't round-trip through
// SQLite, and at this process's scale (single process, quotes live tens of seconds) there's no
// need to make them — an in-memory cache keyed by quoteId is enough. If the process restarted
// between quote and submit the entry is simply gone; submit.ts treats that as "skip this one
// check", not as a failure, since sequence+balance still hold.
const nativeMessageCache = new Map<string, { messages: Msg[]; pubkeyBase64: string }>();

export function getCachedNativeMessages(quoteId: string) {
  return nativeMessageCache.get(quoteId);
}

export function clearCachedNativeMessages(quoteId: string) {
  nativeMessageCache.delete(quoteId);
}

export async function requestQuote(req: QuoteRequest): Promise<QuoteResult> {
  const grant = getStoredGrant(req.address);
  const permit = getStoredPermit(req.address);
  // The permit, not the grant, is now what says this address has been onboarded. The grant is
  // issued further down, on the first quote, so that nobody can make the provider pay for one
  // without also being billed for it in the same transaction.
  if (!permit) throw new QuoteError(`no stored balance permit for ${req.address} — run onboarding first`, "no_permit");

  // Before the first grant exists there is nothing on chain to read the allowed types from, so
  // they come from the same configuration the grant will be created with.
  const allowedTypes: string[] = grant ? JSON.parse(grant.allowed_messages) : config.allowedMessageTypes;
  // MsgExecuteContract.toProto()/toAmino() require encryption utils and throw without them —
  // its type URL is fixed regardless of contents, so skip the call entirely for it rather than
  // pass a throwaway EncryptionUtils just to read a constant back out.
  const msgTypeUrls = await Promise.all(
    req.messages.map(async (m) => (m instanceof MsgExecuteContract ? MSG_EXECUTE_CONTRACT_TYPE_URL : (await m.toProto()).type_url)),
  );
  for (const url of msgTypeUrls) {
    if (!allowedTypes.includes(url)) {
      throw new QuoteError(`message type ${url} is not covered by this address's grant`, "message_type_not_allowed");
    }
  }

  // MsgExecuteContract as a user action (as opposed to the payment message this function builds
  // itself below) can only target a contract the operator has explicitly whitelisted — see
  // config.ts and messageRegistry.ts for why this exists and its confidentiality trade-off.
  // Split out here because it also can't be simulated (same reason the payment message can't),
  // so its gas has to come from a per-contract calibrated constant instead of simulateNativeMessages.
  const simulatableMessages: Msg[] = [];
  const contractMessages: MsgExecuteContract<object>[] = [];
  for (let i = 0; i < req.messages.length; i++) {
    const msg = req.messages[i];
    if (msgTypeUrls[i] === MSG_EXECUTE_CONTRACT_TYPE_URL) {
      const contractMsg = msg as MsgExecuteContract<object>;
      if (!getSettings().allowedContractAddresses.includes(contractMsg.contractAddress)) {
        throw new QuoteError(
          `contract ${contractMsg.contractAddress} is not whitelisted for sponsored calls`,
          "contract_not_allowed",
        );
      }
      contractMessages.push(contractMsg);
    } else {
      simulatableMessages.push(msg);
    }
  }

  const codeHash = await getSscrtCodeHash();
  const balanceResult: any = await readClient.query.compute.queryContract({
    contract_address: config.sscrtContract,
    code_hash: codeHash,
    query: { with_permit: { permit, query: { balance: {} } } },
  });
  const balance = BigInt(balanceResult?.balance?.amount ?? "0");

  // The parts that need no account are priced first, deliberately. Issuing a grant costs the
  // provider a transaction, so every reason to refuse this quote that can be found for free is
  // found before that happens.
  const paymentGas = getPaymentGasConstant();
  const contractGas = contractMessages.reduce((sum, msg) => {
    try {
      return sum + getGasConstant(msg.contractAddress);
    } catch (err) {
      throw new QuoteError(
        `no calibrated gas constant for whitelisted contract ${msg.contractAddress}: ${(err as Error).message}`,
        "contract_gas_not_calibrated",
      );
    }
  }, 0);

  const settings = getSettings();

  // The deposit has to be in place BEFORE anything the user chose is sponsored, and it has to have
  // arrived in a transaction of its own (see requestDepositQuote). Collecting it inside this one
  // would defeat it entirely: a transaction that fails reverts every message in it, so an address
  // could fail its way through forever — each failure costing the provider a fee and never
  // delivering the deposit meant to cover it.
  const depositTopUp = topUpNeeded(req.address, settings.securityDepositUscrt);
  if (depositTopUp > 0n) {
    throw new QuoteError(
      `a security deposit of ${settings.securityDepositUscrt} is required before a transaction can be sponsored; ` +
        `${depositTopUp} is outstanding — request it from /deposit and submit that transaction first`,
      "deposit_required",
    );
  }
  const depositTopUpSscrt = "0";
  const depositAfter = getDeposit(req.address);

  if (!grant) {
    // Unreachable in practice: the deposit gate above is only satisfied once a deposit transaction
    // has landed, and that is what issues the grant. Kept because "no grant" must never silently
    // mean "no fee granter" in a signed transaction.
    throw new QuoteError(`no active grant for ${req.address} — the deposit transaction issues it`, "no_grant");
  } else if (grant.stage === "bootstrap" && grant.fee_collected) {
    // The raise normally happens right after the first transaction lands. If that attempt failed
    // — a flaky endpoint, a restart — this picks it up rather than leaving the address stuck on a
    // spent bootstrap allowance.
    await ensureFullGrant(req.address);
  }

  // Read after any grant work above: the account may not have existed until it ran.
  const account = await getAccount(req.address);
  const pubkeyBase64 = account.pubkeyBase64 ?? req.pubkeyBase64;
  if (!pubkeyBase64) {
    throw new QuoteError(
      "no pubkey on file and none supplied — this looks like this address's first-ever transaction; " +
        "the client must include pubkeyBase64 (e.g. from Keplr's getKey())",
      "no_pubkey",
    );
  }

  const nativeGas =
    simulatableMessages.length === 0
      ? 0 // an all-contract-calls bundle has nothing left to simulate — simulate() needs at
        // least one message, so skip it rather than call it with an empty array.
      : await simulateNativeMessages({
          address: req.address,
          pubkeyBase64,
          accountNumber: account.accountNumber,
          sequence: account.sequence,
          messages: simulatableMessages,
        }).catch((err) => {
          throw new QuoteError(`simulating the native action failed: ${err.message}`, "simulate_failed");
        });
  const gasLimit = Math.ceil((nativeGas + contractGas + paymentGas) * GAS_BUFFER);
  const feeAmountUscrt = String(Math.ceil(gasLimit * config.nativeGasPriceUscrt));

  // sSCRT is pegged 1:1 to SCRT, so the native fee amount converts directly — no oracle,
  // no exchange-rate lookup. A token that wasn't 1:1 would need that step here instead.
  const paymentMarkup = 1 + settings.feeMarkupPercent / 100;
  const sscrtPaymentAmount = String(Math.ceil(Number(feeAmountUscrt) * paymentMarkup));

  // The deposit exists to absorb this transaction failing, so it has to be able to. With a sane
  // configuration the deposit is orders of magnitude above a single fee, but one set below it
  // would quietly stop covering anything at all.
  if (depositAfter < BigInt(feeAmountUscrt)) {
    throw new QuoteError(
      `the security deposit (${depositAfter}) would not cover this transaction's fee (${feeAmountUscrt}) if it failed`,
      "deposit_required",
    );
  }

  // The action's own sSCRT cost counts too, not just the payment. A bundle that spends more than
  // the user holds fails on chain — and a failed bundle still costs the provider the whole fee,
  // because the fee is taken before any message runs and is not refunded when they revert. There
  // is no way to charge for that afterwards, so the only defence is to not quote it.
  const actionOutflow = sscrtOutflow(contractMessages, config.sscrtContract);
  const requiredSscrt = actionOutflow + BigInt(sscrtPaymentAmount);
  if (balance < requiredSscrt) {
    const breakdown = actionOutflow > 0n ? ` (${actionOutflow} to send + ${sscrtPaymentAmount} in fees)` : "";
    throw new QuoteError(
      `insufficient sSCRT balance: have ${balance}, need ${requiredSscrt}${breakdown}`,
      "insufficient_balance",
    );
  }

  const paymentMsg = buildPaymentMessage(req.address, sscrtPaymentAmount, codeHash);

  // MsgExecuteContract (payment + any whitelisted-contract calls) needs encryption utils passed
  // to toAmino(); native messages (MsgSend/MsgDelegate/MsgVote/...) ignore the argument.
  const allMessages: Msg[] = [...req.messages, paymentMsg];
  const aminoMessages = await Promise.all(
    allMessages.map((m) => (m instanceof MsgExecuteContract ? m.toAmino(getServerEncryptionUtils()) : m.toAmino())),
  );

  // Encoded from the same instances, on purpose. MsgExecuteContract encrypts with a random nonce
  // and caches the result, so asking the same instance for both forms yields one ciphertext in
  // both; building a second instance would produce different bytes, and the amino document the
  // user signs would then describe a different message from the one in the transaction body.
  const protoMessages = await Promise.all(
    allMessages.map(async (m) => {
      const proto = m instanceof MsgExecuteContract ? await m.toProto(getServerEncryptionUtils()) : await m.toProto();
      return { typeUrl: proto.type_url, bytes: toBase64(proto.encode()) };
    }),
  );

  // Typed, not cast: this is exactly what /submit will compare against, and the one bug this
  // check has had so far came from the two sides disagreeing about the shape in silence.
  const verification: QuotedTx = {
    messages: protoMessages,
    gasLimit,
    feeAmountUscrt,
    feeGranter: getProviderAddress(),
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
      messages: aminoMessages,
      verification,
      requiredSscrt: requiredSscrt.toString(),
      depositTopUpSscrt,
      gasLimit,
      feeAmountUscrt,
      feeGranter: getProviderAddress(),
    }),
    sscrtPaymentAmount,
    gasLimit,
    expiresAt.toISOString(),
  );

  nativeMessageCache.set(quoteId, { messages: simulatableMessages, pubkeyBase64 });

  return {
    quoteId,
    messages: aminoMessages,
    protoMessages,
    gasLimit,
    feeAmountUscrt,
    feeGranter: getProviderAddress(),
    sscrtPaymentAmount,
    depositTopUpSscrt,
    depositAfterSscrt: depositAfter.toString(),
    accountNumber: account.accountNumber,
    sequence: account.sequence,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * A quote for the security deposit itself: one transaction that carries nothing else.
 *
 * Separate on purpose, and this is the whole point of the deposit working at all. A Cosmos
 * transaction is atomic, so a deposit bundled with a user's action disappears whenever that action
 * fails — which lets an address fail transaction after transaction, each one costing the provider
 * a fee and none of them ever delivering the cover meant to pay for it.
 *
 * On its own it cannot be sabotaged. Every byte is built here — a transfer of a known amount to
 * the provider's own address — and /submit compares the signed bytes against these, so the only
 * way it fails is a balance that is not there, which is checked before anything is issued.
 *
 * The gas for it is folded into the same transfer rather than added as a second message: both
 * would be transfers to the same address, so one covers both and there is nothing to bundle.
 */
export async function requestDepositQuote(req: {
  address: string;
  pubkeyBase64?: string;
}): Promise<QuoteResult> {
  const permit = getStoredPermit(req.address);
  if (!permit) throw new QuoteError(`no stored balance permit for ${req.address} — run onboarding first`, "no_permit");

  const settings = getSettings();
  const topUp = topUpNeeded(req.address, settings.securityDepositUscrt);
  if (topUp === 0n) {
    throw new QuoteError(`the security deposit for ${req.address} is already funded`, "deposit_already_funded");
  }

  const codeHash = await getSscrtCodeHash();
  const balanceResult: any = await readClient.query.compute.queryContract({
    contract_address: config.sscrtContract,
    code_hash: codeHash,
    query: { with_permit: { permit, query: { balance: {} } } },
  });
  const balance = BigInt(balanceResult?.balance?.amount ?? "0");

  // One SNIP-20 transfer, so the payment constant is exactly the right measurement for it.
  const gasLimit = Math.ceil(getPaymentGasConstant() * GAS_BUFFER);
  const feeAmountUscrt = String(Math.ceil(gasLimit * config.nativeGasPriceUscrt));
  const paymentMarkup = 1 + settings.feeMarkupPercent / 100;
  const gasPart = BigInt(Math.ceil(Number(feeAmountUscrt) * paymentMarkup));
  const total = topUp + gasPart;

  if (balance < total) {
    throw new QuoteError(
      `insufficient sSCRT balance for the security deposit: have ${balance}, need ${total} ` +
        `(${topUp} deposit + ${gasPart} gas)`,
      "insufficient_balance",
    );
  }

  const grant = getStoredGrant(req.address);
  if (!grant) {
    // Also what creates the grantee's account. Nothing before this point has cost the provider
    // anything, which is what keeps an address that never deposits from being worth creating.
    await issueBootstrapGrant(req.address, settings.bootstrapGrantUscrt);
  }

  const account = await getAccount(req.address);
  const pubkeyBase64 = account.pubkeyBase64 ?? req.pubkeyBase64;
  if (!pubkeyBase64) {
    throw new QuoteError(
      "no pubkey on file and none supplied — the client must include pubkeyBase64 (e.g. from Keplr's getKey())",
      "no_pubkey",
    );
  }

  const message = buildPaymentMessage(req.address, total.toString(), codeHash);
  const amino = await message.toAmino(getServerEncryptionUtils());
  const proto = await message.toProto(getServerEncryptionUtils());
  const protoMessages = [{ typeUrl: proto.type_url, bytes: toBase64(proto.encode()) }];

  const verification: QuotedTx = {
    messages: protoMessages,
    gasLimit,
    feeAmountUscrt,
    feeGranter: getProviderAddress(),
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
      requiredSscrt: total.toString(),
      depositTopUpSscrt: topUp.toString(),
      gasLimit,
      feeAmountUscrt,
      feeGranter: getProviderAddress(),
    }),
    total.toString(),
    gasLimit,
    expiresAt.toISOString(),
  );

  return {
    quoteId,
    messages: [amino],
    protoMessages,
    gasLimit,
    feeAmountUscrt,
    feeGranter: getProviderAddress(),
    sscrtPaymentAmount: total.toString(),
    depositTopUpSscrt: topUp.toString(),
    depositAfterSscrt: (getDeposit(req.address) + topUp).toString(),
    accountNumber: account.accountNumber,
    sequence: account.sequence,
    expiresAt: expiresAt.toISOString(),
  };
}
