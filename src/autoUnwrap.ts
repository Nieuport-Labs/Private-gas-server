// Closes the hot-wallet loop from the plan's "Hot/cold split": the provider spends native uscrt
// on feegrants and gets sSCRT back as payment, which otherwise just accumulates forever instead
// of refilling the native reserve it's actually spending. Once the provider's own sSCRT balance
// reaches a configured threshold, redeem the whole thing back to native uscrt in one shot.
//
// This is the provider signing and broadcasting its OWN transaction with its OWN key/sequence —
// unlike a user's action+payment bundle, this never touches a user's signature at all, so it
// doesn't run into the "provider never signs a user's transaction" rule from the plan.
import { MsgExecuteContract } from "secretjs";
import { config } from "./config.js";
import { db } from "./db.js";
import { getProviderBalances, getSscrtCodeHash, getProviderAddress, getProviderClient } from "./chain.js";
import { getSettings } from "./settings.js";

export interface AutoUnwrapRow {
  tx_hash: string;
  sscrt_balance_before: string;
  code: number | null;
  raw_log: string | null;
  triggered_at: string;
}

export function getLastAutoUnwrap(): AutoUnwrapRow | null {
  return (db.prepare(`SELECT * FROM auto_unwraps ORDER BY triggered_at DESC LIMIT 1`).get() as
    | AutoUnwrapRow
    | undefined) ?? null;
}

// Guards against an overlapping run if a redeem broadcast takes longer than the check interval.
let inProgress = false;

export async function checkAndUnwrapIfNeeded(): Promise<void> {
  const settings = getSettings();
  if (!settings.autoUnwrapEnabled || inProgress) return;

  inProgress = true;
  try {
    const { sscrt } = await getProviderBalances();
    if (BigInt(sscrt) < BigInt(settings.autoUnwrapThresholdUscrt)) return;

    const codeHash = await getSscrtCodeHash();
    const tx = await getProviderClient().tx.broadcast(
      [
        new MsgExecuteContract({
          sender: getProviderAddress(),
          contract_address: config.sscrtContract,
          code_hash: codeHash,
          msg: { redeem: { amount: sscrt, denom: "uscrt" } },
        }),
      ],
      { gasLimit: 200_000, gasPriceInFeeDenom: config.nativeGasPriceUscrt },
    );

    db.prepare(
      `INSERT INTO auto_unwraps (tx_hash, sscrt_balance_before, code, raw_log) VALUES (?, ?, ?, ?)`,
    ).run(tx.transactionHash, sscrt, tx.code, tx.rawLog ?? "");
  } finally {
    inProgress = false;
  }
}

export function startAutoUnwrapJob(): void {
  setInterval(() => {
    checkAndUnwrapIfNeeded().catch((err) => console.error("auto-unwrap check failed:", err));
  }, config.autoUnwrapCheckIntervalSeconds * 1000).unref();
}
