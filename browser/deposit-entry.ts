// Browser-side helper for the setup wizard's "fund the provider" step.
//
// Bundled and self-hosted (public/vendor/secret-deposit.js) rather than pulled from a CDN at
// runtime: this page also displays the provider's seed phrase once, right after generating it, so
// nothing third-party may execute in its origin.
//
// The transfer itself is signed in the operator's own Keplr, which shows them the destination and
// amount and asks for approval. This file only builds the message.
import { SecretNetworkClient, MsgSend } from "secretjs";

declare global {
  interface Window {
    keplr?: {
      enable(chainId: string): Promise<void>;
      getKey(chainId: string): Promise<{ bech32Address: string; name: string }>;
      getOfflineSignerOnlyAmino(chainId: string): any;
    };
  }
}

export async function connectKeplr(chainId: string): Promise<{ address: string; name: string }> {
  if (!window.keplr) throw new Error("Keplr not found — install the browser extension and reload");
  await window.keplr.enable(chainId);
  const key = await window.keplr.getKey(chainId);
  return { address: key.bech32Address, name: key.name };
}

export async function sendScrt(opts: {
  chainId: string;
  lcdUrl: string;
  from: string;
  to: string;
  amountUscrt: string;
  gasPriceInFeeDenom: number;
}): Promise<{ txHash: string; code: number; rawLog: string }> {
  if (!window.keplr) throw new Error("Keplr not found");
  const wallet = window.keplr.getOfflineSignerOnlyAmino(opts.chainId);
  const client = new SecretNetworkClient({
    url: opts.lcdUrl,
    chainId: opts.chainId,
    wallet,
    walletAddress: opts.from,
  });
  const tx = await client.tx.bank.send(
    {
      from_address: opts.from,
      to_address: opts.to,
      amount: [{ denom: "uscrt", amount: opts.amountUscrt }],
    },
    { gasLimit: 30_000, gasPriceInFeeDenom: opts.gasPriceInFeeDenom },
  );
  return { txHash: tx.transactionHash, code: tx.code, rawLog: tx.rawLog };
}

export { MsgSend };
