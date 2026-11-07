/**
 * A failed `apply` must reach the interface with its audit trail attached.
 *
 * `am apply --json` answers a failed run with the actions it *did* carry out,
 * the one that threw, and the `backups/<ts>/` directory holding what they
 * overwrote — all of it beside the error. The GUI's door used to read only the
 * `error` key of such a payload and drop the rest, which left a half-applied
 * machine on screen with nothing to say about what had changed.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { Apply } from "../ui/src/lib/contract.js";
import { EngineError, apply, setTransport } from "../ui/src/lib/engine.js";
import type { AmOutput } from "../ui/src/lib/transport.js";

function respond(payload: unknown, code: number): void {
  setTransport(
    {
      run: (): Promise<AmOutput> =>
        Promise.resolve({ stdout: JSON.stringify(payload), stderr: "error: boom", code }),
    },
    { mode: "fixture", label: "test" },
  );
}

afterEach(() => {
  setTransport(null);
});

const PARTIAL = {
  applied: [
    {
      kind: "link",
      target: "claude",
      assetType: "skill",
      asset: "demo",
      path: "C:/home/.claude/skills/demo",
      detail: "create junction to source skill",
      status: "done",
    },
    {
      kind: "create",
      target: "claude",
      assetType: "agent",
      asset: "code-reviewer",
      path: "C:/home/.claude/agents/code-reviewer.md",
      detail: "not present in target",
      status: "failed",
      error: "Failed to write file",
    },
  ],
  backupDir: "C:/home/.agents-manager/backups/2026-08-18",
  error: { message: "Failed to write file", path: "C:/home/.claude/agents" },
};

describe("apply failures carry the partial report", () => {
  it("attaches the applied entries and the backup directory to the error", async () => {
    respond(PARTIAL, 2);

    const err = await apply().then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(err).toBeInstanceOf(EngineError);
    const engineError = err as EngineError;
    expect(engineError.message).toBe("Failed to write file");
    const partial = engineError.partial as Apply;
    expect(partial).toBeDefined();
    expect(partial.backupDir).toBe(PARTIAL.backupDir);
    expect(partial.applied.map((entry) => entry.status)).toEqual(["done", "failed"]);
    expect(partial.applied[1]?.error).toBe("Failed to write file");
  });

  it("leaves a plain error payload without a report", async () => {
    respond({ error: { message: "Drift detected" } }, 2);

    const err = await apply().then(
      () => null,
      (caught: unknown) => caught,
    );

    expect((err as EngineError).partial).toBeUndefined();
    expect((err as EngineError).message).toBe("Drift detected");
  });

  it("still resolves a successful run", async () => {
    respond({ applied: [], backupDir: "b" }, 0);
    await expect(apply()).resolves.toEqual({ applied: [], backupDir: "b" });
  });
});
