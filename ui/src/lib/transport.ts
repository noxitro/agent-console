/**
 * The one seam between the GUI and whatever is answering for the engine.
 *
 * A transport takes the argv of an `am` command and returns exactly what the
 * engine produced: stdout, stderr, exit code. Nothing above this line knows
 * whether that came from the agent-console server (`POST /api/run`) or from the
 * in-memory fixture — which is what lets the interface be built, and its states
 * exercised, without a running agent-console server.
 *
 * Kept in its own module so `engine.ts` and `fixtures.ts` can both depend on the
 * shape without depending on each other.
 */

/** Raw result of one engine invocation. */
export interface AmOutput {
  stdout: string;
  stderr: string;
  /** Process exit code; `null` if the process was killed by a signal. */
  code: number | null;
}

export interface EngineTransport {
  run(args: string[]): Promise<AmOutput>;
}
