// The two chain assumptions the self-service refill rests on. Measured, not reasoned about.
//
// The refill is one transaction with two messages:
//
//   [ sSCRT { redeem }, vault { grant: { grantee: self } } with the redeemed coins as funds ]
//   fee.granter = the vault
//
// which quietly assumes two things:
//
//   1. The second message can spend coins the first produced. Messages run in order against one
//      cached store, so they should be there -- but "should" is not a basis for shipping a refill
//      path that leaves a wallet stranded when it is wrong.
//
//   2. A transaction may revoke and re-grant the allowance that is paying its own fee. The vault
//      tops up by revoke-then-grant (x/feegrant has no update message), and the fee comes out of
//      that same allowance in the ante handler before any message runs. The ordering should work
//      out. The nastier half is the boundary: when the fee takes the allowance to exactly zero,
//      the chain deletes the grant mid-transaction, and the vault then has to tell "no grant"
//      apart from "could not ask" and grant the fresh amount anyway.
//
// If either fails, the refill has to become two transactions and the floor has to be recomputed.
//
// ---------------------------------------------------------------------------------------------
// This spends real money on a real chain, and some of it does not come back.
//
// Credits paid into the vault can only ever leave as the grantee's gas -- there is no withdrawal.
// So the buyer wallet must be one whose key you keep: whatever allowance is left when the run
// finishes is still spendable by that wallet, and is dead money if the key is not.
//
// That is why this does not generate a throwaway. It derives two accounts from USER_MNEMONIC, it
// prints what the run will cost before spending anything, and outside a devnet it refuses to
// start until CONFIRM names the chain.
//
// The same two checks also run from the demo app's dev mode, as the "refill" and "refill boundary"
// scenarios, with Keplr as the buyer and no provider key at all. That is the easier way to get
// the answer; this exists for a devnet and for CI, where there is no browser.
import { MsgExecuteContract, SecretNetworkClient, Wallet } from "secretjs";
import { config } from "../config.js";
import { getSscrtCodeHash, getProviderAddress, getProviderClient, readClient } from "../chain.js";
import { buyCreditsFor, queryRemaining } from "../gasVault.js";
import { getSettings } from "../settings.js";

/** Redeem plus the vault's revoke-and-grant. Generous: this run is measuring, not economising. */
const GAS_TOPUP = 700_000;
/** The provider's own transfer that funds the buyer. */
const GAS_FUND = 200_000;
/** The provider's vault purchase, from gasVault.ts. */
const GAS_VAULT_BUY = 400_000;

async function main() {
  const vaultAddress = getSettings().gasVaultAddress;
  if (!vaultAddress) throw new Error("no gas vault configured — set GAS_VAULT_ADDRESS");

  const userMnemonic = process.env.USER_MNEMONIC;
  if (!userMnemonic) {
    throw new Error(
      "USER_MNEMONIC is required: the buyer wallet has to be one whose key you keep, because " +
        "credits left in the vault at the end are only spendable by it and are lost otherwise.",
    );
  }

  const price = config.nativeGasPriceUscrt;
  const feeUscrt = BigInt(Math.ceil(GAS_TOPUP * price));
  const startingA = feeUscrt * 3n;
  const startingB = feeUscrt;
  const topUpAmount = feeUscrt * 4n;

  const intoVault = startingA + startingB + topUpAmount * 2n;
  const providerGas = BigInt(Math.ceil((GAS_FUND * 2 + GAS_VAULT_BUY * 2) * price));
  const sscrtMoved = topUpAmount * 2n;
  // Each refill burns one fee out of the seeded allowance; the rest stays as spendable credit.
  const strandedUnlessSpent = intoVault - feeUscrt * 2n;

  console.error(`chain:        ${config.chainId} at ${price} uscrt/gas`);
  console.error(`vault:        ${vaultAddress}`);
  console.error("");
  console.error("what this run spends:");
  console.error(`  ${fmt(sscrtMoved)} sSCRT  from the provider to the buyer wallet`);
  console.error(`  ${fmt(intoVault)} SCRT   paid into the vault (${fmt(startingA + startingB)} by the provider, ${fmt(topUpAmount * 2n)} by the buyer)`);
  console.error(`  ${fmt(providerGas)} SCRT   the provider's own gas`);
  console.error("");
  console.error(`  of that, ${fmt(strandedUnlessSpent)} SCRT ends up as gas credits held by the`);
  console.error("  two buyer accounts. It cannot be withdrawn — it is only recoverable by");
  console.error("  spending it as their gas, which needs USER_MNEMONIC.");
  console.error("");

  const devnet = config.chainId.startsWith("secretdev");
  if (!devnet && process.env.CONFIRM !== config.chainId) {
    throw new Error(
      `refusing to spend real funds without confirmation — re-run with CONFIRM=${config.chainId}`,
    );
  }

  await checkRefill({
    label: "1+2: refill pays its own fee out of the credits it is topping up",
    vaultAddress,
    // Comfortably more than the fee, so the grant survives the ante handler and the vault's
    // revoke-and-grant operates on a live allowance.
    startingCreditsUscrt: startingA.toString(),
    topUpAmountUscrt: topUpAmount.toString(),
    feeUscrt,
    mnemonic: userMnemonic,
    hdAccountIndex: 0,
  });

  await checkRefill({
    label: "boundary: the fee drains the allowance to zero and the chain deletes it mid-transaction",
    vaultAddress,
    // Exactly the fee. After the ante handler there is nothing left, so x/feegrant removes the
    // grant and the vault has to grant afresh rather than read a remainder that is not there.
    startingCreditsUscrt: startingB.toString(),
    topUpAmountUscrt: topUpAmount.toString(),
    feeUscrt,
    mnemonic: userMnemonic,
    hdAccountIndex: 1,
  });

  console.error("\nOK: both assumptions hold. The refill can stay a single transaction.");
}

function fmt(uscrt: bigint): string {
  return (Number(uscrt) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

async function checkRefill(params: {
  label: string;
  vaultAddress: string;
  startingCreditsUscrt: string;
  topUpAmountUscrt: string;
  feeUscrt: bigint;
  mnemonic: string;
  hdAccountIndex: number;
}): Promise<void> {
  console.error(`\n--- ${params.label}`);

  const wallet = new Wallet(params.mnemonic, { hdAccountIndex: params.hdAccountIndex });
  const address = wallet.address;
  const userClient = new SecretNetworkClient({
    url: config.lcdUrl,
    chainId: config.chainId,
    wallet,
    walletAddress: address,
  });
  console.error(`buyer account ${params.hdAccountIndex}: ${address}`);

  // Not "must be empty" but "must not move": the redeem adds native SCRT and the vault message
  // spends it, so a wallet that already holds some is fine. Requiring zero was an unnecessary
  // constraint — that the grant paid is proved by the allowance falling, not by an empty wallet.
  const nativeBefore = (await readClient.query.bank.balance({ address, denom: "uscrt" })).balance?.amount ?? "0";

  const codeHash = await getSscrtCodeHash();

  const funded = await getProviderClient().tx.broadcast(
    [
      new MsgExecuteContract({
        sender: getProviderAddress(),
        contract_address: config.sscrtContract,
        code_hash: codeHash,
        msg: { transfer: { recipient: address, amount: params.topUpAmountUscrt } },
      }),
    ],
    { gasLimit: GAS_FUND, gasPriceInFeeDenom: config.nativeGasPriceUscrt },
  );
  if (funded.code !== 0) throw new Error(`setup failed: could not fund the buyer: ${funded.rawLog}`);

  const granted = await buyCreditsFor(address, params.startingCreditsUscrt);
  if (granted.code !== 0) throw new Error(`setup failed: could not seed credits: ${granted.rawLog}`);

  const before = await queryRemaining(address);
  console.error(`seeded ${params.startingCreditsUscrt}, vault reports remaining: ${before}`);
  if (before === null) throw new Error("FAILED: the vault could not read the allowance it just issued");

  const vaultCodeHash = (
    await readClient.query.compute.codeHashByContractAddress({ contract_address: params.vaultAddress })
  ).code_hash;

  const tx = await userClient.tx.broadcast(
    [
      new MsgExecuteContract({
        sender: address,
        contract_address: config.sscrtContract,
        code_hash: codeHash,
        msg: { redeem: { amount: params.topUpAmountUscrt, denom: "uscrt" } },
      }),
      new MsgExecuteContract({
        sender: address,
        contract_address: params.vaultAddress,
        code_hash: vaultCodeHash,
        msg: { grant: { grantee: address } },
        sent_funds: [{ denom: "uscrt", amount: params.topUpAmountUscrt }],
      }),
    ],
    {
      gasLimit: GAS_TOPUP,
      gasPriceInFeeDenom: config.nativeGasPriceUscrt,
      feeDenom: "uscrt",
      feeGranter: params.vaultAddress,
    },
  );

  console.error(`refill gas_used ${tx.gasUsed} of ${GAS_TOPUP} wanted`);

  if (tx.code !== 0) {
    throw new Error(
      `FAILED (${params.label}): the refill transaction was rejected with code ${tx.code}: ${tx.rawLog}\n` +
        "The refill cannot be a single transaction on this chain; split it and recompute the floor.",
    );
  }

  const after = await queryRemaining(address);
  if (after === null) throw new Error("FAILED: the vault could not read the allowance after the refill");

  // What the allowance should be: what was there, less the fee the ante handler took, plus what
  // was just paid in. The boundary case lands at exactly the top-up, because the remainder was
  // zero and the grant was gone.
  const expected = BigInt(before) - params.feeUscrt + BigInt(params.topUpAmountUscrt);
  console.error(`after refill: ${after} (expected ${expected})`);

  if (BigInt(after) !== expected) {
    throw new Error(
      `FAILED (${params.label}): allowance is ${after}, expected ${expected}. The vault's ` +
        "revoke-and-grant did not compose with the fee deduction the way the refill assumes.",
    );
  }

  // The unwrap must have left nothing behind. A native balance that moved would mean the second
  // message did not spend exactly what the first produced, and the refill would quietly be
  // accumulating SCRT in wallets instead of credits in the vault.
  const nativeAfter = (await readClient.query.bank.balance({ address, denom: "uscrt" })).balance?.amount ?? "0";
  if (nativeAfter !== nativeBefore) {
    throw new Error(
      `FAILED (${params.label}): the native balance moved from ${nativeBefore} to ${nativeAfter} — ` +
        "the vault message did not spend exactly what the redeem produced.",
    );
  }

  console.error(`passed. ${address} now holds ${fmt(BigInt(after))} SCRT of gas credits — spendable, not lost.`);
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
