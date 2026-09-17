// The two operator tasks that move real money: wrapping native SCRT into sSCRT, and measuring the
// payment message's gas cost. Shared by the CLI scripts in src/scripts/ and the dashboard's admin
// endpoints, so both behave identically.
//
// Both are deliberately tolerant of a flaky RPC endpoint. Public LCD endpoints intermittently
// answer with an HTML error page instead of JSON, and an earlier version of the calibration
// script threw the whole run away when that happened mid-flight — after paying gas for the
// samples it had already collected. A sample that fails for any reason is now skipped, not fatal.
import { MsgExecuteContract } from "secretjs";
import { getSscrtCodeHash, getProviderAddress, getProviderClient, getProviderBalances } from "./chain.js";
import { config } from "./config.js";
import { buildPaymentMessage, recordPaymentGasCalibration } from "./payment.js";
import { recordGasCalibration } from "./gasCalibration.js";

export type Progress = (message: string) => void;

export type WrapResult = {
  txHash: string;
  before: { uscrt: string; sscrt: string };
  after: { uscrt: string; sscrt: string };
};

export async function wrapScrt(amountUscrt: string, onProgress: Progress = () => {}): Promise<WrapResult> {
  if (!/^\d+$/.test(amountUscrt) || amountUscrt === "0") {
    throw new Error("amount must be a positive whole number of uscrt (1 SCRT = 1000000)");
  }

  const before = await getProviderBalances();
  onProgress(`before: ${before.uscrt} uscrt, ${before.sscrt} sSCRT`);

  const codeHash = await getSscrtCodeHash();
  const tx = await getProviderClient().tx.broadcast(
    [
      new MsgExecuteContract({
        sender: getProviderAddress(),
        contract_address: config.sscrtContract,
        code_hash: codeHash,
        msg: { deposit: {} },
        sent_funds: [{ denom: "uscrt", amount: amountUscrt }],
      }),
    ],
    { gasLimit: 200_000, gasPriceInFeeDenom: config.nativeGasPriceUscrt },
  );
  if (tx.code !== 0) throw new Error(`deposit failed (code ${tx.code}): ${tx.rawLog}`);
  onProgress(`deposit ok: ${tx.transactionHash}`);

  const after = await getProviderBalances();
  onProgress(`after: ${after.uscrt} uscrt, ${after.sscrt} sSCRT`);
  return { txHash: tx.transactionHash, before, after };
}

export type CalibrationResult = {
  constant: number;
  samples: number[];
  attempted: number;
  min: number;
  max: number;
  avg: number;
};

/**
 * Measures the payment message's real gas cost by sending it for real — never by simulate, which
 * cannot handle MsgExecuteContract on Secret at all.
 *
 * The samples are self-transfers from the provider to itself: the same message shape a user's
 * payment has, with the same balance writes and history entry, but no net movement of funds.
 */
export async function calibratePaymentGas(sampleCount: number, onProgress: Progress = () => {}): Promise<CalibrationResult> {
  const codeHash = await getSscrtCodeHash();
  const samples: number[] = [];

  for (let i = 0; i < sampleCount; i++) {
    // The amount varies per sample so the message isn't byte-identical across runs, matching how
    // it is really used (a different quoted fee each time).
    try {
      const msg = buildPaymentMessage(getProviderAddress(), String(1000 + i), codeHash);
      const tx = await getProviderClient().tx.broadcast([msg], {
        gasLimit: 200_000,
        gasPriceInFeeDenom: config.nativeGasPriceUscrt,
      });
      if (tx.code !== 0) {
        onProgress(`sample ${i} failed (code ${tx.code}): ${tx.rawLog}`);
        continue;
      }
      samples.push(Number(tx.gasUsed));
      onProgress(`sample ${i}: gas_used=${tx.gasUsed}`);
    } catch (err) {
      // A flaky endpoint must not discard the samples already paid for.
      onProgress(`sample ${i} errored: ${(err as Error).message}`);
    }
  }

  if (samples.length === 0) throw new Error("no successful samples — calibration failed, nothing recorded");

  const constant = recordPaymentGasCalibration(samples);
  const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  onProgress(`recorded calibration: constant=${constant} from ${samples.length}/${sampleCount} samples`);
  return { constant, samples, attempted: sampleCount, min: Math.min(...samples), max: Math.max(...samples), avg };
}

/** Same measurement, for a whitelisted contract's own call shape. */
export async function calibrateContractGas(
  contractAddress: string,
  execMsg: object,
  sampleCount: number,
  onProgress: Progress = () => {},
): Promise<CalibrationResult> {
  const codeHash = (
    await getProviderClient().query.compute.codeHashByContractAddress({ contract_address: contractAddress })
  ).code_hash;
  if (!codeHash) throw new Error(`could not resolve code hash for ${contractAddress}`);

  const samples: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    try {
      const tx = await getProviderClient().tx.broadcast(
        [
          new MsgExecuteContract({
            sender: getProviderAddress(),
            contract_address: contractAddress,
            code_hash: codeHash,
            msg: execMsg,
          }),
        ],
        { gasLimit: 400_000, gasPriceInFeeDenom: config.nativeGasPriceUscrt },
      );
      if (tx.code !== 0) {
        onProgress(`sample ${i} failed (code ${tx.code}): ${tx.rawLog}`);
        continue;
      }
      samples.push(Number(tx.gasUsed));
      onProgress(`sample ${i}: gas_used=${tx.gasUsed}`);
    } catch (err) {
      onProgress(`sample ${i} errored: ${(err as Error).message}`);
    }
  }

  if (samples.length === 0) throw new Error("no successful samples — calibration failed, nothing recorded");

  const constant = recordGasCalibration(contractAddress, samples);
  const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  onProgress(`recorded calibration for ${contractAddress}: constant=${constant} from ${samples.length}/${sampleCount}`);
  return { constant, samples, attempted: sampleCount, min: Math.min(...samples), max: Math.max(...samples), avg };
}
