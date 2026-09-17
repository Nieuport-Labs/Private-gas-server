// Proves the server can get a gas estimate for a native-only message WITHOUT holding the
// user's private key — only their address and public key (which a wallet like Keplr always
// exposes, e.g. `keplr.getKey(chainId).pubKey`, and which is otherwise on file on-chain once
// an address has signed anything before).
//
// secretjs's high-level `client.tx.simulate()` requires an attached signer object, but that
// signer only needs to answer `getAccounts()` (address + pubkey) and `signAmino()` — for
// simulate mode the ante handler doesn't cryptographically verify the signature, it only
// needs a correctly shaped one for gas metering (this is standard Cosmos SDK behaviour, not
// secretjs-specific). So a fake signer that returns a zero-filled signature of the right
// length is enough to build a valid unsigned-in-substance tx for the simulate endpoint.
import { SecretNetworkClient, MsgSend } from "secretjs";
import type { AccountData } from "@cosmjs/amino";
import type { AminoSigner } from "secretjs/dist/wallet_amino.js";

const LCD = "http://localhost:1317";
const CHAIN_ID = "secretdev-1";

// Known from earlier steps: the "fresh" address that never held native SCRT until the test
// setup funded it a little. Its pubkey is on file (it has transacted before), fetched below
// via account query rather than hardcoded, to mirror how the server would do it for any
// address that already has one.
const FRESH_ADDRESS = "secret10qw3ax3rljryu2s7qxcnq43295j4pftmj8vmsc";
const RECIPIENT = "secret1ap26qrlp8mcq2pg6r47w43l0y8zkqm8a450s03";

class GasEstimationSigner implements AminoSigner {
  constructor(private account: AccountData) {}
  async getAccounts(): Promise<readonly AccountData[]> {
    return [this.account];
  }
  async signAmino(signerAddress: string, signDoc: any) {
    return {
      signed: signDoc,
      signature: {
        pub_key: { type: "tendermint/PubKeySecp256k1", value: Buffer.from(this.account.pubkey).toString("base64") },
        // Correctly-shaped (64-byte secp256k1) but meaningless signature. The simulate
        // endpoint only needs the shape for gas metering, not cryptographic validity.
        signature: Buffer.alloc(64).toString("base64"),
      },
    };
  }
}

async function main() {
  const readClient = new SecretNetworkClient({ url: LCD, chainId: CHAIN_ID });
  const accountResp = await readClient.query.auth.account({ address: FRESH_ADDRESS });
  const raw = accountResp.account as any;
  const pubkeyB64 = raw?.pub_key?.key;
  if (!pubkeyB64) throw new Error("no pubkey on file for this address — pick one that has transacted before");
  console.log("account_number:", raw.account_number, "sequence:", raw.sequence);

  const account: AccountData = {
    address: FRESH_ADDRESS,
    algo: "secp256k1",
    pubkey: Buffer.from(pubkeyB64, "base64"),
  };

  const simClient = new SecretNetworkClient({
    url: LCD,
    chainId: CHAIN_ID,
    wallet: new GasEstimationSigner(account) as any,
    walletAddress: FRESH_ADDRESS,
  });

  const msg = new MsgSend({
    from_address: FRESH_ADDRESS,
    to_address: RECIPIENT,
    amount: [{ denom: "uscrt", amount: "1" }],
  });

  // feeGranter matters here in exactly the way it will in production: this address only has
  // 99uscrt, nowhere near enough to cover its own fee, and simulate runs the full ante chain
  // including the fee check — without a granter this fails on "insufficient funds" before it
  // ever reaches gas metering for the message itself.
  const sim = await simClient.tx.simulate([msg], {
    gasLimit: 200_000,
    feeDenom: "uscrt",
    feeGranter: RECIPIENT, // RECIPIENT ("a") is the provider account that granted fresh's allowance
    explicitSignerData: {
      accountNumber: Number(raw.account_number),
      sequence: Number(raw.sequence),
      chainId: CHAIN_ID,
    },
  });

  console.log("simulate raw result:", JSON.stringify(sim, null, 2));
  const gasUsed = (sim as any).gasInfo?.gasUsed ?? (sim as any).gas_info?.gas_used;
  if (!gasUsed) throw new Error("FAILED: no gas_used in simulate response");
  console.log(`OK: simulated native MsgSend without the user's private key, gas_used=${gasUsed}`);
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
