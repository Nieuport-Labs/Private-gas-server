// The two operator tasks that move real money: wrapping native SCRT into sSCRT, and measuring the
// payment message's gas cost. Shared by the CLI scripts in src/scripts/ and the dashboard's admin
// endpoints, so both behave identically.
//
// Both are built around a flaky RPC endpoint, because the public ones are. A real run lost 9 of
// 10 samples to HTML error pages served in place of JSON. So a failed sample is retried, and a
// sample that stays broken is skipped rather than killing the run — but a run that collects too
// few samples fails outright instead of recording a constant nobody should trust.
import { MsgExecuteContract } from "secretjs";
import { getSscrtCodeHash, getProviderAddress, getProviderClient, getProviderBalances } from "./chain.js";
import { config } from "./config.js";
import { buildPaymentMessage, recordPaymentGasCalibration } from "./payment.js";
import { recordGasCalibration } from "./gasCalibration.js";
import { isTransient } from "./retry.js";

// A constant recorded from one or two lucky samples is worse than no constant: it looks
// authoritative, and if that sample was an outlier every quote under-quotes gas, so users'
// transactions run out of gas with the fee already charged. Below this many successes the run
// fails loudly and writes nothing. Asking for fewer samples than this lowers the bar accordingly,
// so a deliberate single-sample spot check still works.
const MIN_SUCCESSFUL_SAMPLES = 3;

// A sample that dies on a flaky endpoint is worth another go — each attempt is an independent
// transaction, so this is not a retried broadcast, just a fresh one.
const SAMPLE_ATTEMPTS = 3;

const SAMPLE_SPACING_MS = 2000;

export type Progress = (message: string) => void;

/**
 * Names the actual cause instead of guessing. An earlier version always blamed the RPC endpoint,
 * which sent the operator hunting for a better provider when the real problem was an unfunded
 * wallet — the failures said "account not found" the whole time.
 */
function explainFailure(succeeded: number, attempted: number, required: number, failures: unknown[]): string {
  const head = `only ${succeeded}/${attempted} samples succeeded, need at least ${required} — nothing recorded.`;
  const last = failures[failures.length - 1] as Error | undefined;
  if (!last) return head;
  if (failures.every((f) => isTransient(f))) {
    return `${head} Every sample failed on the RPC endpoint (${last.message}). It is rate limiting or down — wait and retry, or point LCD_URL at a different one.`;
  }
  return `${head} Cause: ${last.message}`;
}

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
  const failures: unknown[] = [];

  for (let i = 0; i < sampleCount; i++) {
    // Pace the run. Each sample costs several requests (sequence lookup, broadcast, result poll),
    // and firing them back to back is what tips a public endpoint into rate limiting — which then
    // fails the samples that follow. Blocks take ~6s anyway, so this barely lengthens the run.
    if (i > 0) await new Promise((r) => setTimeout(r, SAMPLE_SPACING_MS));

    // The amount varies per sample so the message isn't byte-identical across runs, matching how
    // it is really used (a different quoted fee each time).
    for (let attempt = 0; attempt < SAMPLE_ATTEMPTS; attempt++) {
      try {
        const msg = buildPaymentMessage(getProviderAddress(), String(1000 + i), codeHash);
        const tx = await getProviderClient().tx.broadcast([msg], {
          gasLimit: 200_000,
          gasPriceInFeeDenom: config.nativeGasPriceUscrt,
        });
        if (tx.code !== 0) {
          failures.push(new Error(`chain rejected the transaction (code ${tx.code}): ${tx.rawLog}`));
          onProgress(`sample ${i} failed (code ${tx.code}): ${tx.rawLog}`);
          break; // a chain-level rejection will repeat; retrying only burns more gas
        }
        samples.push(Number(tx.gasUsed));
        onProgress(`sample ${i}: gas_used=${tx.gasUsed}`);
        break;
      } catch (err) {
        const retryable = isTransient(err) && attempt < SAMPLE_ATTEMPTS - 1;
        if (!retryable) failures.push(err);
        onProgress(`sample ${i} errored${retryable ? ", retrying" : ""}: ${(err as Error).message}`);
        if (!retryable) break;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  const required = Math.min(MIN_SUCCESSFUL_SAMPLES, sampleCount);
  if (samples.length < required) {
    throw new Error(explainFailure(samples.length, sampleCount, required, failures));
  }

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
  const failures: unknown[] = [];
  for (let i = 0; i < sampleCount; i++) {
    for (let attempt = 0; attempt < SAMPLE_ATTEMPTS; attempt++) {
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
          failures.push(new Error(`chain rejected the transaction (code ${tx.code}): ${tx.rawLog}`));
          onProgress(`sample ${i} failed (code ${tx.code}): ${tx.rawLog}`);
          break;
        }
        samples.push(Number(tx.gasUsed));
        onProgress(`sample ${i}: gas_used=${tx.gasUsed}`);
        break;
      } catch (err) {
        const retryable = isTransient(err) && attempt < SAMPLE_ATTEMPTS - 1;
        if (!retryable) failures.push(err);
        onProgress(`sample ${i} errored${retryable ? ", retrying" : ""}: ${(err as Error).message}`);
        if (!retryable) break;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  const requiredC = Math.min(MIN_SUCCESSFUL_SAMPLES, sampleCount);
  if (samples.length < requiredC) {
    throw new Error(explainFailure(samples.length, sampleCount, requiredC, failures));
  }

  const constant = recordGasCalibration(contractAddress, samples);
  const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  onProgress(`recorded calibration for ${contractAddress}: constant=${constant} from ${samples.length}/${sampleCount}`);
  return { constant, samples, attempted: sampleCount, min: Math.min(...samples), max: Math.max(...samples), avg };
}
