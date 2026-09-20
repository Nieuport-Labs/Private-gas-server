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
// Finding that out here costs a devnet run; finding it out later costs somebody their gas.
import { MsgExecuteContract, SecretNetworkClient, Wallet } from "secretjs";
import { config } from "../config.js";
import { getSscrtCodeHash, getProviderAddress, getProviderClient, readClient } from "../chain.js";
import { buyCreditsFor, queryRemaining } from "../gasVault.js";
import { getSettings } from "../settings.js";

/** Redeem plus the vault's revoke-and-grant. Generous: this run is measuring, not economising. */
const GAS_TOPUP = 700_000;

async function main() {
  const vaultAddress = getSettings().gasVaultAddress;
  if (!vaultAddress) throw new Error("no gas vault configured — set GAS_VAULT_ADDRESS");

  const feeUscrt = BigInt(Math.ceil(GAS_TOPUP * config.nativeGasPriceUscrt));
  console.log(`one refill costs ${feeUscrt} uscrt at ${config.nativeGasPriceUscrt} uscrt/gas`);

  await checkRefill({
    label: "1+2: refill pays its own fee out of the credits it is topping up",
    vaultAddress,
    // Comfortably more than the fee, so the grant survives the ante handler and the vault's
    // revoke-and-grant operates on a live allowance.
    startingCreditsUscrt: (feeUscrt * 3n).toString(),
    feeUscrt,
  });

  await checkRefill({
    label: "boundary: the fee drains the allowance to zero and the chain deletes it mid-transaction",
    vaultAddress,
    // Exactly the fee. After the ante handler there is nothing left, so x/feegrant removes the
    // grant and the vault has to grant afresh rather than read a remainder that is not there.
    startingCreditsUscrt: feeUscrt.toString(),
    feeUscrt,
  });

  console.log("\nOK: both assumptions hold. The refill can stay a single transaction.");
}

async function checkRefill(params: {
  label: string;
  vaultAddress: string;
  startingCreditsUscrt: string;
  feeUscrt: bigint;
}): Promise<void> {
  console.log(`\n--- ${params.label}`);

  const wallet = new Wallet();
  const address = wallet.address;
  const userClient = new SecretNetworkClient({
    url: config.lcdUrl,
    chainId: config.chainId,
    wallet,
    walletAddress: address,
  });

  const codeHash = await getSscrtCodeHash();
  const topUpAmount = (params.feeUscrt * 4n).toString();

  // sSCRT to unwrap, and no native SCRT at all -- native SCRT would let the wallet pay its own
  // fee and the test would pass without proving anything about the grant.
  await getProviderClient().tx.broadcast(
    [
      new MsgExecuteContract({
        sender: getProviderAddress(),
        contract_address: config.sscrtContract,
        code_hash: codeHash,
        msg: { transfer: { recipient: address, amount: topUpAmount } },
      }),
    ],
    { gasLimit: 200_000, gasPriceInFeeDenom: config.nativeGasPriceUscrt },
  );

  const granted = await buyCreditsFor(address, params.startingCreditsUscrt);
  if (granted.code !== 0) throw new Error(`setup failed: could not seed credits: ${granted.rawLog}`);

  const before = await queryRemaining(address);
  console.log(`seeded ${params.startingCreditsUscrt}, vault reports remaining: ${before}`);
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
        msg: { redeem: { amount: topUpAmount, denom: "uscrt" } },
      }),
      new MsgExecuteContract({
        sender: address,
        contract_address: params.vaultAddress,
        code_hash: vaultCodeHash,
        msg: { grant: { grantee: address } },
        sent_funds: [{ denom: "uscrt", amount: topUpAmount }],
      }),
    ],
    {
      gasLimit: GAS_TOPUP,
      gasPriceInFeeDenom: config.nativeGasPriceUscrt,
      feeDenom: "uscrt",
      feeGranter: params.vaultAddress,
    },
  );

  if (tx.code !== 0) {
    throw new Error(
      `FAILED (${params.label}): the refill transaction was rejected with code ${tx.code}: ${tx.rawLog}\n` +
        "The refill cannot be a single transaction on this chain; split it and recompute the floor.",
    );
  }

  const after = await queryRemaining(address);
  if (after === null) throw new Error("FAILED: the vault could not read the allowance after the refill");

  // What the allowance should be: what was there, less the fee the ante handler took, plus what
  // was just paid in. The boundary case lands at exactly `topUpAmount`, because the remainder was
  // zero and the grant was gone.
  const expected = BigInt(before) - params.feeUscrt + BigInt(topUpAmount);
  console.log(`after refill: ${after} (expected ${expected})`);

  if (BigInt(after) !== expected) {
    throw new Error(
      `FAILED (${params.label}): allowance is ${after}, expected ${expected}. The vault's ` +
        "revoke-and-grant did not compose with the fee deduction the way the refill assumes.",
    );
  }

  // The unwrap has to have left nothing behind. A leftover native balance would mean the second
  // message did not spend what the first produced, and the refill would be quietly accumulating
  // SCRT in wallets instead of credits in the vault.
  const leftover = (await readClient.query.bank.balance({ address, denom: "uscrt" })).balance?.amount ?? "0";
  if (leftover !== "0") {
    throw new Error(
      `FAILED (${params.label}): ${leftover} uscrt was left in the wallet — the vault message did ` +
        "not spend everything the redeem produced.",
    );
  }

  console.log("passed");
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
