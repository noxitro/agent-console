/**
 * The engine's own thread (worker side).
 *
 * `main()` is synchronous and a large `plan` can take tens of seconds, so it
 * must not run on the server's event loop: while it did, `/control/ping`,
 * `/api/shutdown` and the idle timer all went silent, and a second launcher run
 * mistook the busy server for a dead one and started another. The engine
 * therefore runs here, one job at a time, and the server thread only queues
 * jobs and relays answers.
 *
 * A job is either a plain run, or an `apply` bound to a plan digest: the fresh
 * plan and the apply run back-to-back inside this thread, so nothing can slip
 * in between the check and the write.
 */

import { parentPort } from "node:worker_threads";

import { planDigest, runEngine, type AmOutput } from "./engine-runner.js";

export type EngineJob =
  | { id: number; kind: "run"; args: string[] }
  | { id: number; kind: "bound"; args: string[]; planArgs: string[]; digest: string };

export type EngineReply =
  | { id: number; kind: "output"; output: AmOutput }
  | { id: number; kind: "stale" };

parentPort?.on("message", (job: EngineJob) => {
  let reply: EngineReply;
  if (job.kind === "bound") {
    const fresh = planDigest(job.planArgs, runEngine(job.planArgs));
    reply = fresh === job.digest ? { id: job.id, kind: "output", output: runEngine(job.args) } : { id: job.id, kind: "stale" };
  } else {
    reply = { id: job.id, kind: "output", output: runEngine(job.args) };
  }
  parentPort?.postMessage(reply);
});
