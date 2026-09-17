// Proves the Fastify HTTP layer itself, not just the underlying functions: every other smoke
// test in this directory calls onboardUser/requestQuote/submitQuote directly in-process. This
// one talks to a running server (`npm run dev` or `npm start`) over real HTTP, exactly the way
// an eventual dApp client would, including the wire format for messages (messageRegistry.ts)
// and base64-encoded signed tx bytes.
//
// Usage: start the server first (`npm run dev`), then run this against it.
import { MsgSend, MsgExecuteContract, SecretNetworkClient, Wallet } from "secretjs";
import { config } from "../config.js";
import { getSscrtCodeHash, getProviderAddress, getProviderClient } from "../chain.js";

const BASE_URL = process.env.PROVIDER_URL ?? "http://localhost:8787";
const RECIPIENT = "secret1ap26qrlp8mcq2pg6r47w43l0y8zkqm8a450s03";

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
        msg: { transfer: { recipient: address, amount: "1000000" } },
      }),
    ],
    { gasLimit: 200_000, gasPriceInFeeDenom: 0.25 },
  );
  await getProviderClient().tx.bank.send(
    { from_address: getProviderAddress(), to_address: address, amount: [{ denom: "uscrt", amount: "10" }] },
    { gasLimit: 100_000, gasPriceInFeeDenom: 0.25 },
  );
  console.log("funded with sSCRT + a little uscrt");

  const onboardResp = await postJson("/onboard", { address, permit });
  console.log("POST /onboard:", onboardResp);

  const pubkeyBase64 = Buffer.from((await wallet.getAccounts())[0].pubkey).toString("base64");
  const nativeMsgParams = { from_address: address, to_address: RECIPIENT, amount: [{ denom: "uscrt", amount: "1" }] };

  const quote = await postJson("/quote", {
    address,
    pubkeyBase64,
    messages: [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: nativeMsgParams }],
  });
  console.log("POST /quote:", quote);
  if (quote.error) throw new Error(`quote failed: ${quote.error}: ${quote.message}`);

  // Stand-in for the client's own wallet signing exactly what the quote specified.
  const nativeMsg = new MsgSend(nativeMsgParams);
  const paymentMsg = new MsgExecuteContract({
    sender: address,
    contract_address: config.sscrtContract,
    code_hash: codeHash,
    msg: { transfer: { recipient: getProviderAddress(), amount: quote.sscrtPaymentAmount } },
  });
  const signedBytes = await userClient.tx.signTx([nativeMsg, paymentMsg], {
    gasLimit: quote.gasLimit,
    feeDenom: "uscrt",
    feeGranter: getProviderAddress(),
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

  console.log(`OK: full HTTP onboard -> quote -> submit loop passed, provider reimbursed ${submitResp.sscrtReceived} sSCRT`);

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
