// One operator task at a time, with a progress log the dashboard can watch.
//
// Calibration takes about a minute — ten real transactions, each waiting for a block — which is
// too long to hold an HTTP request open with no feedback. So the endpoint starts the work and
// returns immediately, and the dashboard follows along by polling the job state.
//
// Only one job may run at a time, and that is a correctness requirement rather than tidiness:
// these tasks broadcast from the provider's account, and two of them running concurrently would
// race on the same sequence number and lose transactions (the fee is charged even when a
// transaction fails on a stale sequence).
import type { Progress } from "./maintenance.js";

export type JobState = {
  name: string;
  status: "running" | "done" | "failed";
  log: string[];
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  result: unknown;
};

const MAX_LOG_LINES = 200;

let current: JobState | null = null;

export class JobInProgressError extends Error {
  readonly code = "job_in_progress";
  constructor(name: string) {
    super(`"${name}" is still running — wait for it to finish`);
  }
}

export function getJob(): JobState | null {
  return current;
}

export function isJobRunning(): boolean {
  return current?.status === "running";
}

/**
 * Starts a job and returns at once. Rejects if one is already running. The work itself runs
 * detached: its outcome lands in the job state, never as an unhandled rejection.
 */
export function startJob(name: string, work: (onProgress: Progress) => Promise<unknown>): JobState {
  if (current?.status === "running") throw new JobInProgressError(current.name);

  const state: JobState = {
    name,
    status: "running",
    log: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    result: null,
  };
  current = state;

  const onProgress: Progress = (message) => {
    state.log.push(message);
    if (state.log.length > MAX_LOG_LINES) state.log.shift();
  };

  void work(onProgress).then(
    (result) => {
      state.result = result;
      state.status = "done";
      state.finishedAt = new Date().toISOString();
    },
    (err: unknown) => {
      state.error = (err as Error)?.message ?? String(err);
      state.status = "failed";
      state.finishedAt = new Date().toISOString();
    },
  );

  return state;
}
