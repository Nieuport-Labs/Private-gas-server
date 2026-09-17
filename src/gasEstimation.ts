// Simulates a set of NATIVE (plaintext) messages for an address the server does not hold
// the key for — verified end to end in src/scripts/smoke-simulate.ts against the devnet.
//
// Why this exists at all rather than just calling simulate directly: secretjs's tx.simulate
// requires an attached signer object to shape the AuthInfo/SignerInfo correctly. Simulate mode
// does not cryptographically verify the signature (confirmed empirically — a garbage 64-byte
// signature of the right length passes ante's SigVerification during simulate), so a signer
// that only knows the address+pubkey, never the private key, is sufficient here.
//
// This must NEVER be used for anything containing MsgExecuteContract: Secret's simulate
// endpoint cannot handle encrypted messages at all (confirmed in the earlier chain-level
// phase — "length of pubkey is incorrect", since simulate has no tx pubkey to encrypt
// against). The SNIP-20 payment message's gas cost is estimated separately, by calibration
// (see payment.ts), not by simulate.
import { SecretNetworkClient, type Msg } from "secretjs";
import type { AccountData } from "@cosmjs/amino";
import type { AminoSigner } from "secretjs/dist/wallet_amino.js";
import { config } from "./config.js";
import { getProviderAddress } from "./chain.js";

class GasEstimationSigner implements AminoSigner {
  constructor(private account: AccountData) {}
  async getAccounts(): Promise<readonly AccountData[]> {
    return [this.account];
  }
  async signAmino(_signerAddress: string, signDoc: any) {
    return {
      signed: signDoc,
      signature: {
        pub_key: {
          type: "tendermint/PubKeySecp256k1",
          value: Buffer.from(this.account.pubkey).toString("base64"),
        },
        signature: Buffer.alloc(64).toString("base64"),
      },
    };
  }
}

export interface SimulateNativeParams {
  address: string;
  pubkeyBase64: string;
  accountNumber: number;
  sequence: number;
  messages: Msg[];
}

export async function simulateNativeMessages(params: SimulateNativeParams): Promise<number> {
  const account: AccountData = {
    address: params.address,
    algo: "secp256k1",
    pubkey: Buffer.from(params.pubkeyBase64, "base64"),
  };

  const simClient = new SecretNetworkClient({
    url: config.lcdUrl,
    chainId: config.chainId,
    wallet: new GasEstimationSigner(account) as any,
    walletAddress: params.address,
  });

  const sim = await simClient.tx.simulate(params.messages, {
    gasLimit: 300_000,
    feeDenom: "uscrt",
    feeGranter: getProviderAddress(),
    explicitSignerData: {
      accountNumber: params.accountNumber,
      sequence: params.sequence,
      chainId: config.chainId,
    },
  });

  const gasUsed = Number((sim as any).gasInfo?.gasUsed ?? (sim as any).gas_info?.gas_used ?? 0);
  if (!gasUsed) {
    throw new Error("simulate returned no gas_used — cannot quote this action");
  }
  return gasUsed;
}
