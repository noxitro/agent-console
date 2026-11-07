/**
 * The engine's own thread (server side): a FIFO of jobs to one worker
 * (docs/ARCHITECTURE.md「エンジンのスレッド」).
 *
 * Jobs run strictly one after another — the engine was written for one process
 * at a time, and two writes must never interleave. A **read** that outlives
 * {@link READ_TIMEOUT_MS} gets its worker terminated and replaced: a read
 * changes nothing, so cutting it short costs only the reading. A **write** has
 * no ceiling at all (SPEC §9.5: 書き込み系は書き込み途中で打ち切らない), and that
 * holds for shutting down too: {@link WorkerEngine.close} waits for a running
 * write to finish, stops a running read, and answers every job still queued
 * with a refusal instead of starting it.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { planDigest, runEngine, type AmOutput } from "./engine-runner.js";
import type { EngineJob, EngineReply } from "./engine-worker.js";

export const READ_TIMEOUT_MS = 30_000;

/** Phrase of the answer a job gets when the server is shutting down. */
export const SHUTTING_DOWN = "The agent-console server is shutting down, so this was not run.";

/** What a job resolves to. `stale` = a bound apply whose plan had changed. */
export type JobResult = { kind: "output"; output: AmOutput } | { kind: "stale" };

export type JobSpec =
  | { kind: "run"; args: string[]; writes: boolean }
  | { kind: "bound"; args: string[]; planArgs: string[]; digest: string };

/** The seam `app.ts` and `main.ts` talk to. */
export interface EngineRunner {
  submit(job: JobSpec): Promise<JobResult>;
  /** Is a write running right now? (`/api/shutdown` and the idle timer ask.) */
  isWriting(): boolean;
  /** Stop: let a running write finish, stop a running read, refuse the queue. */
  close(): Promise<void>;
}

export function timeoutMessage(ms: number): string {
  return `The engine did not finish within ${Math.round(ms / 1000)} seconds and was stopped.`;
}

function failure(message: string): JobResult {
  return { kind: "output", output: { stdout: JSON.stringify({ error: { message } }), stderr: `error: ${message}`, code: 2 } };
}

const isWriteJob = (job: JobSpec): boolean => job.kind === "bound" || job.writes;

/** Runs jobs on a worker thread (the built server). */
export class WorkerEngine implements EngineRunner {
  private worker: Worker | null = null;
  private nextId = 1;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private active: { writes: boolean; stop: () => void } | null = null;

  constructor(
    private readonly workerFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "engine-worker.js"),
    private readonly readTimeoutMs = READ_TIMEOUT_MS,
  ) {}

  submit(job: JobSpec): Promise<JobResult> {
    if (this.closed) return Promise.resolve(failure(SHUTTING_DOWN));
    const result = this.tail.then(() => (this.closed ? failure(SHUTTING_DOWN) : this.execute(job)));
    this.tail = result.catch(() => undefined);
    return result;
  }

  isWriting(): boolean {
    return this.active?.writes === true;
  }

  async close(): Promise<void> {
    this.closed = true;
    // A read in flight is stopped now; a write in flight is waited for.
    if (this.active !== null && !this.active.writes) this.active.stop();
    await this.tail;
    const worker = this.worker;
    this.worker = null;
    if (worker !== null) await worker.terminate();
  }

  private ensureWorker(): Worker {
    this.worker ??= new Worker(this.workerFile, { env: process.env });
    return this.worker;
  }

  private execute(job: JobSpec): Promise<JobResult> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    const message: EngineJob =
      job.kind === "bound"
        ? { id, kind: "bound", args: job.args, planArgs: job.planArgs, digest: job.digest }
        : { id, kind: "run", args: job.args };
    const writes = isWriteJob(job);

    return new Promise<JobResult>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      let settled = false;
      const done = (result: JobResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
        this.active = null;
        resolve(result);
      };
      const abandon = (reason: string): void => {
        // The worker is stopped and replaced on the next job.
        worker.off("exit", onExit);
        if (this.worker === worker) this.worker = null;
        void worker.terminate();
        done(failure(reason));
      };
      const onMessage = (reply: EngineReply): void => {
        if (reply.id !== id) return;
        done(reply.kind === "stale" ? { kind: "stale" } : { kind: "output", output: reply.output });
      };
      const onError = (err: Error): void => {
        if (this.worker === worker) this.worker = null;
        done(
          failure(
            writes
              ? `The engine thread failed during a write (${err.message}), so the write may be incomplete. Whatever it had already touched was backed up first, under the source's backups/<timestamp>/ directory. Survey again before trusting what is on screen.`
              : `The engine thread failed: ${err.message}`,
          ),
        );
      };
      const onExit = (): void => {
        if (this.worker === worker) this.worker = null;
        done(
          failure(
            writes
              ? "The engine thread stopped during a write, so the write may be incomplete. Survey again before trusting what is on screen."
              : "The engine thread stopped.",
          ),
        );
      };
      worker.on("message", onMessage);
      worker.once("error", onError);
      worker.once("exit", onExit);
      this.active = { writes, stop: () => abandon(SHUTTING_DOWN) };
      if (!writes) timer = setTimeout(() => abandon(timeoutMessage(this.readTimeoutMs)), this.readTimeoutMs);
      worker.postMessage(message);
    });
  }
}

/**
 * Runs jobs on the calling thread. Used by the unit tests, which run from the
 * TypeScript sources where the worker file does not exist; the semantics (FIFO,
 * the bound check and the apply back-to-back, refusing after close) are the same.
 */
export class InlineEngine implements EngineRunner {
  private closed = false;

  constructor(private readonly engine: (args: readonly string[]) => AmOutput = runEngine) {}

  submit(job: JobSpec): Promise<JobResult> {
    if (this.closed) return Promise.resolve(failure(SHUTTING_DOWN));
    if (job.kind === "bound") {
      const fresh = planDigest(job.planArgs, this.engine(job.planArgs));
      if (fresh !== job.digest) return Promise.resolve({ kind: "stale" });
    }
    return Promise.resolve({ kind: "output", output: this.engine(job.args) });
  }

  isWriting(): boolean {
    return false;
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
