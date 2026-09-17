// The /quote step described in the plan: server computes everything a client's own
// secretjs+Keplr wallet needs to build and sign one transaction — [native action message(s),
// sSCRT payment message] — with fee.granter set to the provider. The server never holds or
// touches the user's private key; it hands back terms, the client signs, /submit takes it
// from there (not yet implemented).
import { randomUUID } from "node:crypto";
import { MsgExecuteContract, type Msg } from "secretjs";
import { config } from "./config.js";
import { db } from "./db.js";
import { getAccount, getSscrtCodeHash, providerAddress } from "./chain.js";
import { getStoredGrant, getStoredPermit } from "./onboarding.js";
import { simulateNativeMessages } from "./gasEstimation.js";
import { getPaymentGasConstant, buildPaymentMessage, getServerEncryptionUtils } from "./payment.js";
import { getGasConstant } from "./gasCalibration.js";
import { MSG_EXECUTE_CONTRACT_TYPE_URL } from "./messageRegistry.js";
import { readClient } from "./chain.js";

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
      | "contract_gas_not_calibrated",
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
  gasLimit: number;
  feeAmountUscrt: string;
  feeGranter: string;
  sscrtPaymentAmount: string;
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
  if (!grant) throw new QuoteError(`no active grant for ${req.address} — run onboarding first`, "no_grant");

  const allowedTypes: string[] = JSON.parse(grant.allowed_messages);
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
      if (!config.allowedContractAddresses.includes(contractMsg.contractAddress)) {
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

  const account = await getAccount(req.address);
  const pubkeyBase64 = account.pubkeyBase64 ?? req.pubkeyBase64;
  if (!pubkeyBase64) {
    throw new QuoteError(
      "no pubkey on file and none supplied — this looks like this address's first-ever transaction; " +
        "the client must include pubkeyBase64 (e.g. from Keplr's getKey())",
      "no_pubkey",
    );
  }

  const permit = getStoredPermit(req.address);
  if (!permit) throw new QuoteError(`no stored balance permit for ${req.address} — run onboarding first`, "no_permit");

  const codeHash = await getSscrtCodeHash();
  const balanceResult: any = await readClient.query.compute.queryContract({
    contract_address: config.sscrtContract,
    code_hash: codeHash,
    query: { with_permit: { permit, query: { balance: {} } } },
  });
  const balance = BigInt(balanceResult?.balance?.amount ?? "0");

  // Gas: the simulatable part is simulated for real (see gasEstimation.ts); the SNIP-20 payment
  // and any whitelisted-contract calls can't be simulated at all on Secret, so each is priced
  // from its own periodically re-measured constant instead.
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
  const gasLimit = Math.ceil((nativeGas + contractGas + paymentGas) * GAS_BUFFER);
  const feeAmountUscrt = String(Math.ceil(gasLimit * config.nativeGasPriceUscrt));

  // sSCRT is pegged 1:1 to SCRT, so the native fee amount converts directly — no oracle,
  // no exchange-rate lookup. A token that wasn't 1:1 would need that step here instead.
  const paymentMarkup = 1 + config.feeMarkupPercent / 100;
  const sscrtPaymentAmount = String(Math.ceil(Number(feeAmountUscrt) * paymentMarkup));

  if (balance < BigInt(sscrtPaymentAmount)) {
    throw new QuoteError(
      `insufficient sSCRT balance: have ${balance}, need ${sscrtPaymentAmount}`,
      "insufficient_balance",
    );
  }

  const paymentMsg = buildPaymentMessage(req.address, sscrtPaymentAmount, codeHash);
  // MsgExecuteContract (payment + any whitelisted-contract calls) needs encryption utils passed
  // to toAmino(); native messages (MsgSend/MsgDelegate/MsgVote/...) ignore the argument.
  const aminoMessages = await Promise.all([
    ...req.messages.map((m) =>
      m instanceof MsgExecuteContract ? m.toAmino(getServerEncryptionUtils()) : m.toAmino(),
    ),
    paymentMsg.toAmino(getServerEncryptionUtils()),
  ]);

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
    JSON.stringify({ messages: aminoMessages, gasLimit, feeAmountUscrt, feeGranter: providerAddress }),
    sscrtPaymentAmount,
    gasLimit,
    expiresAt.toISOString(),
  );

  nativeMessageCache.set(quoteId, { messages: simulatableMessages, pubkeyBase64 });

  return {
    quoteId,
    messages: aminoMessages,
    gasLimit,
    feeAmountUscrt,
    feeGranter: providerAddress,
    sscrtPaymentAmount,
    accountNumber: account.accountNumber,
    sequence: account.sequence,
    expiresAt: expiresAt.toISOString(),
  };
}
