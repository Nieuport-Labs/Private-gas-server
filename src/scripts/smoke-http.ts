// Proves the Fastify HTTP layer itself, not just the underlying functions: the other smoke tests
// call onboardUser/requestPurchaseQuote/submitQuote directly in-process. This one talks to a
// running server (`npm run dev` or `npm start`) over real HTTP, exactly the way the browser app
// does, including base64-encoded signed tx bytes and polling for delivery.
//
// Usage: start the server first (`npm run dev`), then run this against it.
import { MsgExecuteContract, SecretNetworkClient, Wallet } from "secretjs";
import { config } from "../config.js";
import { getSscrtCodeHash, getProviderAddress, getProviderClient } from "../chain.js";
import { getSettings } from "../settings.js";
import { quotedMessages } from "./quotedSigning.js";

const BASE_URL = process.env.PROVIDER_URL ?? "http://localhost:8787";

async function main() {
  const health = await fetch(`${BASE_URL}/health`).then((r) => r.json());
  console.log("server health:", health);

  const wallet = new Wallet();
  const address = wallet.address;
  console.log("brand-new address:", address);

  const userClient = new SecretNetworkClient({
    url: config.lcdUrl,
    chainId: config.chainId,
    wallet,
    walletAddress: address,
  });
  const permit = await userClient.utils.accessControl.permit.sign(
    address,
    config.chainId,
    "http-smoke-test",
    [config.sscrtContract],
    ["balance"],
    false,
  );

  const codeHash = await getSscrtCodeHash();
  await getProviderClient().tx.broadcast(
    [
      new MsgExecuteContract({
        sender: getProviderAddress(),
        contract_address: config.sscrtContract,
        code_hash: codeHash,
        msg: {
          transfer: {
            recipient: address,
            amount: (BigInt(getSettings().creditPurchaseUscrt) * 2n).toString(),
          },
        },
      }),
    ],
    { gasLimit: 200_000, gasPriceInFeeDenom: config.nativeGasPriceUscrt },
  );
  console.log("funded with sSCRT and zero native SCRT");

  const onboardResp = await postJson("/onboard", { address, permit });
  console.log("POST /onboard:", onboardResp);

  const pubkeyBase64 = Buffer.from((await wallet.getAccounts())[0].pubkey).toString("base64");

  const quote = await postJson("/purchase/quote", { address, pubkeyBase64 });
  console.log("POST /purchase/quote:", quote);
  if (quote.error) throw new Error(`quote failed: ${quote.error}: ${quote.message}`);

  // The client signs the server's bytes as they are. Rebuilding the message locally would
  // re-encrypt with a fresh nonce and be rejected by txVerify -- which is the intended behaviour,
  // so a test that did it would be testing the wrong thing.
  const signedBytes = await userClient.tx.signTx(quotedMessages(quote), {
    gasLimit: quote.gasLimit,
    gasPriceInFeeDenom: Number(quote.feeAmountUscrt) / quote.gasLimit,
    feeDenom: "uscrt",
    feeGranter: quote.feeGranter,
    explicitSignerData: {
      accountNumber: quote.accountNumber,
      sequence: quote.sequence,
      chainId: config.chainId,
    },
  });

  const submitResp = await postJson("/submit", {
    quoteId: quote.quoteId,
    signedTxBytes: Buffer.from(signedBytes).toString("base64"),
  });
  console.log("POST /submit:", submitResp);
  if (submitResp.error) throw new Error(`submit failed: ${submitResp.error}: ${submitResp.message}`);
  if (submitResp.code !== 0) throw new Error(`FAILED: tx landed with non-zero code ${submitResp.code}`);

  // Delivery is a second transaction, so the client polls rather than assuming.
  const delivery = await fetch(`${BASE_URL}/purchase/${quote.quoteId}`).then((r) => r.json());
  console.log(`GET /purchase/${quote.quoteId}:`, delivery);
  if (delivery.state !== "delivered") {
    throw new Error(`FAILED: credits not delivered (state ${delivery.state}: ${delivery.lastError ?? "no error given"})`);
  }

  console.log(
    `OK: HTTP onboard -> purchase/quote -> submit -> delivery passed. Provider received ` +
      `${submitResp.sscrtReceived} sSCRT, buyer received ${submitResp.creditsUscrt} uscrt of credits.`,
  );

  async function postJson(path: string, body: unknown): Promise<any> {
    const resp = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return resp.json();
  }
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
