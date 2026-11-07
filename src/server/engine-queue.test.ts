/**
 * The engine thread's ceilings (SPEC §9.5, carried over from the Tauri shell):
 * a **read** that outlives the ceiling is stopped and reported, and the next
 * job runs on a fresh thread; a **write** is never stopped, however short the
 * ceiling. The engine block runs against the built worker
 * (`dist/server/engine-worker.js`), so `npm run build` must come first: in CI a
 * missing build fails this file outright; locally the block is skipped and says
 * so. The shutdown block uses a stand-in worker and needs no build.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { planDigest } from "./engine-runner.js";
import { SHUTTING_DOWN, timeoutMessage, WorkerEngine } from "./engine-queue.js";

const workerFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dist",
  "server",
  "engine-worker.js",
);
const built = fs.existsSync(workerFile);
if (!built) {
  const message = `engine-queue.test: ${workerFile} is missing; run \`npm run build\` first.`;
  // Silently skipping in CI would let a regression of the ceilings through.
  if (process.env["CI"] !== undefined && process.env["CI"] !== "") throw new Error(message);
  console.warn(`${message} Skipping the engine block.`);
}

/**
 * A stand-in worker: `slow-write` / `slow-read` take a while, anything else
 * answers at once. Counts how many threads were started, via a file.
 */
const STAND_IN = `
import { parentPort } from "node:worker_threads";
import * as fs from "node:fs";
fs.appendFileSync(process.env.AC_TEST_SPAWNS, "spawn\\n");
parentPort.on("message", (job) => {
  const slow = job.args[0] === "slow-write" || job.args[0] === "slow-read";
  setTimeout(() => {
    parentPort.postMessage({ id: job.id, kind: "output", output: { stdout: JSON.stringify({ ran: job.args[0] }), stderr: "", code: 0 } });
  }, slow ? 600 : 0);
});
`;

describe("WorkerEngine.close (shutting down)", () => {
  let dir: string;
  let file: string;
  let spawns: string;
  const savedSpawns = process.env["AC_TEST_SPAWNS"];

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-standin-"));
    file = path.join(dir, "stand-in.mjs");
    spawns = path.join(dir, "spawns.log");
    fs.writeFileSync(file, STAND_IN);
    process.env["AC_TEST_SPAWNS"] = spawns;
  });

  afterAll(() => {
    if (savedSpawns === undefined) delete process.env["AC_TEST_SPAWNS"];
    else process.env["AC_TEST_SPAWNS"] = savedSpawns;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const spawnCount = (): number => (fs.existsSync(spawns) ? fs.readFileSync(spawns, "utf8").split("\n").filter(Boolean).length : 0);
  const ran = (r: Awaited<ReturnType<WorkerEngine["submit"]>>): unknown =>
    r.kind === "output" ? (JSON.parse(r.output.stdout) as { ran?: string; error?: { message: string } }) : r;

  it("lets a running write finish, refuses the queue, and starts no new thread", async () => {
    fs.rmSync(spawns, { force: true });
    const engine = new WorkerEngine(file, 30_000);
    const write = engine.submit({ kind: "run", args: ["slow-write"], writes: true });
    const queued = engine.submit({ kind: "run", args: ["inventory"], writes: false });
    await new Promise((r) => setTimeout(r, 100));
    expect(engine.isWriting()).toBe(true);
    const closing = engine.close();
    expect(ran(await write)).toEqual({ ran: "slow-write" });
    expect(ran(await queued)).toEqual({ error: { message: SHUTTING_DOWN } });
    await closing;
    expect(ran(await engine.submit({ kind: "run", args: ["inventory"], writes: false }))).toEqual({ error: { message: SHUTTING_DOWN } });
    expect(spawnCount()).toBe(1);
    expect(engine.isWriting()).toBe(false);
  });

  it("stops a running read at once instead of waiting for it", async () => {
    const engine = new WorkerEngine(file, 30_000);
    const read = engine.submit({ kind: "run", args: ["slow-read"], writes: false });
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    await engine.close();
    expect(Date.now() - started).toBeLessThan(500);
    expect(ran(await read)).toEqual({ error: { message: SHUTTING_DOWN } });
  });
});

let home: string;
const saved = process.env["AC_HOME"];

function write(rel: string, content: string): void {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function stdoutOf(result: Awaited<ReturnType<WorkerEngine["submit"]>>): unknown {
  expect(result.kind).toBe("output");
  return result.kind === "output" ? JSON.parse(result.output.stdout) : null;
}

describe.runIf(built)("WorkerEngine (the engine's own thread)", () => {
  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-worker-"));
    process.env["AC_HOME"] = home;
    write(
      ".agents-manager/manifest.json",
      `${JSON.stringify({ version: 1, targets: { claude: { enabled: true } }, skills: { linkMode: "copy", exclude: [] } })}\n`,
    );
    write(".agents/skills/demo/SKILL.md", "---\nname: demo\ndescription: A demo skill\n---\n\n# demo\n");
  });

  afterAll(() => {
    if (saved === undefined) delete process.env["AC_HOME"];
    else process.env["AC_HOME"] = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("runs a read and answers with the engine's JSON contract (positive control)", async () => {
    const engine = new WorkerEngine(workerFile);
    try {
      const out = stdoutOf(await engine.submit({ kind: "run", args: ["inventory"], writes: false }));
      expect(out).toHaveProperty("targets");
    } finally {
      await engine.close();
    }
  });

  it("stops a read that outlives the ceiling, says so, and runs the next job on a fresh thread", async () => {
    // 1 ms is shorter than starting a thread at all, so the read cannot finish in time.
    const engine = new WorkerEngine(workerFile, 1);
    try {
      const first = await engine.submit({ kind: "run", args: ["inventory"], writes: false });
      expect(first.kind === "output" ? first.output.code : null).toBe(2);
      expect(stdoutOf(first)).toEqual({ error: { message: timeoutMessage(1) } });
      expect(timeoutMessage(1)).not.toContain("the write may be incomplete");

      // The same engine, ceiling lifted for the next job's sake: it must not be stuck.
      (engine as unknown as { readTimeoutMs: number }).readTimeoutMs = 30_000;
      const second = stdoutOf(await engine.submit({ kind: "run", args: ["inventory"], writes: false }));
      expect(second).toHaveProperty("targets");
    } finally {
      await engine.close();
    }
  });

  it("never stops a write, however short the ceiling", async () => {
    const engine = new WorkerEngine(workerFile, 1);
    try {
      const out = stdoutOf(await engine.submit({ kind: "run", args: ["disable", "skill", "demo"], writes: true }));
      expect(out).toMatchObject({ changed: true });
      const manifest = JSON.parse(fs.readFileSync(path.join(home, ".agents-manager/manifest.json"), "utf8")) as {
        skills: { exclude: string[] };
      };
      expect(manifest.skills.exclude).toContain("demo");
      const back = stdoutOf(await engine.submit({ kind: "run", args: ["enable", "skill", "demo"], writes: true }));
      expect(back).toMatchObject({ changed: true });
    } finally {
      await engine.close();
    }
  });

  it("runs a bound apply only when the plan still has the shown digest", async () => {
    const engine = new WorkerEngine(workerFile);
    try {
      const stale = await engine.submit({ kind: "bound", args: ["apply", "--yes"], planArgs: ["plan"], digest: "0".repeat(64) });
      expect(stale.kind).toBe("stale");
      expect(fs.existsSync(path.join(home, ".claude", "skills", "demo"))).toBe(false);

      const plan = await engine.submit({ kind: "run", args: ["plan"], writes: false });
      expect(plan.kind).toBe("output");
      const digest = plan.kind === "output" ? planDigest(["plan"], plan.output) : "";
      const applied = await engine.submit({ kind: "bound", args: ["apply", "--yes"], planArgs: ["plan"], digest });
      expect(applied.kind === "output" ? applied.output.code : null).toBe(0);
      expect(fs.existsSync(path.join(home, ".claude", "skills", "demo", "SKILL.md"))).toBe(true);
    } finally {
      await engine.close();
    }
  });

  it("runs jobs strictly one after another (no interleaving)", async () => {
    const engine = new WorkerEngine(workerFile);
    try {
      const order: string[] = [];
      const jobs = ["inventory", "doctor", "plan"].map((command) =>
        engine.submit({ kind: "run", args: [command], writes: false }).then(() => order.push(command)),
      );
      await Promise.all(jobs);
      expect(order).toEqual(["inventory", "doctor", "plan"]);
    } finally {
      await engine.close();
    }
  });
});
