// Regression test for the invariant that /submit's byte comparison exists to hold: a client can
// only have the provider pay for the transaction the provider quoted.
//
// This one costs nothing and touches no funds — it signs transactions with a throwaway key and
// never broadcasts them, so it can be run on every change. That matters, because the failure it
// guards against is silent: the provider pays, the transaction succeeds, and the shortfall only
// shows up later as a balance that does not add up. It was found exactly that way.
//
// Usage: tsx src/scripts/smoke-tx-verify.ts
import { MsgExecuteContract, SecretNetworkClient, Wallet, toBase64, type Msg } from "secretjs";
import { config } from "../config.js";
import { getServerEncryptionUtils } from "../payment.js";
import { verifySignedTx, parseQuotedTx, TxMismatchError, type QuotedTx } from "../txVerify.js";

const GAS_LIMIT = 250_000;
const FEE_USCRT = String(Math.ceil(GAS_LIMIT * config.nativeGasPriceUscrt));
const GRANTER = "secret148n3mfamw5tq5kwd2szswy6dz4lx3frtc780lp";
const RECIPIENT = "secret1ap26qrlp8mcq2pg6r47w43l0y8zkqm8a450s03";
const CODE_HASH = "c8ac20dce1aaf573a27bba8a765b4cd8d3be8d7ed921210b80a0f9563b9315b2";

let failures = 0;

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`  ok   ${name}`),
      (err) => {
        failures++;
        console.error(`  FAIL ${name}: ${(err as Error).message}`);
      },
    );
}

async function expectRejected(name: string, signed: Uint8Array, quoted: QuotedTx, wanted: RegExp) {
  await check(name, () => {
    try {
      verifySignedTx(signed, quoted);
    } catch (err) {
      if (!(err instanceof TxMismatchError)) throw new Error(`wrong error type: ${(err as Error).message}`);
      if (!wanted.test(err.message)) throw new Error(`rejected, but for the wrong reason: ${err.message}`);
      return;
    }
    throw new Error("accepted, but should have been rejected");
  });
}

async function main() {
  const wallet = new Wallet();
  const client = new SecretNetworkClient({
    url: config.lcdUrl,
    chainId: config.chainId,
    wallet,
    walletAddress: wallet.address,
  });

  const transfer = (recipient: string, amount: string) =>
    new MsgExecuteContract({
      sender: wallet.address,
      contract_address: config.sscrtContract,
      code_hash: CODE_HASH,
      msg: { transfer: { recipient, amount } },
    });

  // What the quote would issue: messages the SERVER encrypted, in both forms, from the same
  // instances — which is what keeps the ciphertext in the amino document and the proto body equal.
  const quotedMsgs: Msg[] = [transfer(RECIPIENT, "1000"), transfer(GRANTER, "32745")];
  const amino = await Promise.all(quotedMsgs.map((m) => m.toAmino(getServerEncryptionUtils())));
  const proto = await Promise.all(
    quotedMsgs.map(async (m) => {
      const p = await m.toProto(getServerEncryptionUtils());
      return { typeUrl: p.type_url, bytes: toBase64(p.encode()) };
    }),
  );
  const quoted: QuotedTx = {
    messages: proto,
    gasLimit: GAS_LIMIT,
    feeAmountUscrt: FEE_USCRT,
    feeGranter: GRANTER,
  };

  // How an honest client signs them: as opaque bytes, exactly as handed over.
  const asHandedOver: Msg[] = proto.map((p, i) => ({
    toProto: async () => ({ type_url: p.typeUrl, value: null, encode: () => Buffer.from(p.bytes, "base64") }),
    toAmino: async () => amino[i],
  }));

  const sign = (messages: Msg[], overrides: { gasLimit?: number; feeGranter?: string } = {}) =>
    client.tx.signTx(messages, {
      gasLimit: overrides.gasLimit ?? GAS_LIMIT,
      gasPriceInFeeDenom: config.nativeGasPriceUscrt,
      feeDenom: "uscrt",
      feeGranter: overrides.feeGranter ?? GRANTER,
      explicitSignerData: { accountNumber: 1, sequence: 0, chainId: config.chainId },
    });

  console.log("signing offline with a throwaway key — nothing is broadcast\n");

  await check("the quoted transaction, signed as issued, is accepted", async () => {
    verifySignedTx(await sign(asHandedOver), quoted);
  });

  // The finding that started this: a quote for 32745 signed with a payment of 1.
  await expectRejected(
    "a payment of 1 usSCRT instead of the quoted amount is rejected",
    await sign([asHandedOver[0], transfer(GRANTER, "1")]),
    quoted,
    /not the one that was quoted/,
  );

  await expectRejected(
    "a payment redirected to another address is rejected",
    await sign([asHandedOver[0], transfer(wallet.address, "32745")]),
    quoted,
    /not the one that was quoted/,
  );

  await expectRejected(
    "dropping the payment message is rejected",
    await sign([asHandedOver[0]]),
    quoted,
    /1 message\(s\), quoted 2/,
  );

  // Not a tampered amount — identical plaintext, rebuilt locally. It must still be refused, or
  // every other comparison here can be sidestepped by rebuilding rather than editing.
  await expectRejected(
    "the same payment re-encrypted by the client is rejected",
    await sign([asHandedOver[0], transfer(GRANTER, "32745")]),
    quoted,
    /not the one that was quoted/,
  );

  await expectRejected(
    "a five-fold gas limit is rejected",
    await sign(asHandedOver, { gasLimit: GAS_LIMIT * 5 }),
    quoted,
    /gas limit is/,
  );

  await expectRejected(
    "a fee granter other than the provider is rejected",
    await sign(asHandedOver, { feeGranter: RECIPIENT }),
    quoted,
    /fee granter is/,
  );

  await expectRejected("garbage bytes are rejected", Uint8Array.from([1, 2, 3, 4]), quoted, /not a signed transaction/);

  // The checks above all hand verifySignedTx a correctly shaped record, which is why they passed
  // while the real thing rejected every transaction: quote.ts writes the record into a row and
  // submit.ts reads it back, and the two disagreed about which field held the proto messages.
  // These two cover that seam.
  const storedRow = JSON.stringify({
    messages: amino, // the amino form, which is NOT what verification compares against
    verification: quoted,
    gasLimit: GAS_LIMIT,
    feeAmountUscrt: FEE_USCRT,
    feeGranter: GRANTER,
  });

  await check("a quote read back from storage still accepts the honest transaction", async () => {
    verifySignedTx(await sign(asHandedOver), parseQuotedTx(storedRow));
  });

  await check("a quote stored before this check existed is refused in plain words", () => {
    const legacyRow = JSON.stringify({ messages: amino, gasLimit: GAS_LIMIT, feeAmountUscrt: FEE_USCRT });
    try {
      parseQuotedTx(legacyRow);
    } catch (err) {
      if (!(err instanceof TxMismatchError)) throw new Error(`wrong error type: ${(err as Error).message}`);
      if (!/request a fresh one/.test(err.message)) throw new Error(`unhelpful message: ${err.message}`);
      return;
    }
    throw new Error("accepted a quote with no verification record");
  });

  console.log(failures === 0 ? "\nOK: every case behaved as it should" : `\n${failures} case(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
