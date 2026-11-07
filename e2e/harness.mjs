/**
 * Shared plumbing for the browser end-to-end tests (ARCHITECTURE.md「テスト」).
 *
 * Starts `node dist/server/main.js --no-open --port 0` against a throwaway
 * `AC_HOME`, waits for its `listening` line (which carries the one-time launch
 * URL), and stops it afterwards. The real HOME is never touched: every path
 * the engine resolves is under the fake one.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function makeHome(prefix = "ac-e2e-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFile(home, rel, content) {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A source of truth with a skill, an MCP server, an agent and a command. */
export function seedMachine(home) {
  writeFile(
    home,
    ".agents-manager/manifest.json",
    `${JSON.stringify(
      {
        version: 3,
        targets: {
          claude: { enabled: true },
          "copilot-cli": { enabled: true },
          vscode: { enabled: false },
          vs2026: { enabled: false },
          opencode: { enabled: false },
        },
        skills: { linkMode: "copy", exclude: [] },
        mcp: { exclude: [] },
        agents: { exclude: [] },
        commands: { exclude: [] },
      },
      null,
      2,
    )}\n`,
  );
  writeFile(home, ".agents/skills/demo-skill/SKILL.md", "---\nname: demo-skill\ndescription: A demo skill for the e2e run\n---\n\n# demo-skill\n");
  writeFile(home, ".agents/skills/second-skill/SKILL.md", "---\nname: second-skill\ndescription: Another skill\n---\n\n# second-skill\n");
  writeFile(
    home,
    ".agents-manager/mcp/servers.json",
    `${JSON.stringify({ servers: { docs: { transport: "stdio", command: "npx", args: ["-y", "docs-server"] } } }, null, 2)}\n`,
  );
  writeFile(home, ".agents-manager/agents/code-reviewer.md", "---\nname: code-reviewer\ndescription: Reviews code\n---\n\nReview the diff.\n");
  writeFile(home, ".agents-manager/commands/run-tests.md", "---\nname: run-tests\ndescription: Run the tests\ntargets: [claude]\n---\n\nRun the tests.\n");
}

/** Start the server; resolves with `{ port, launchUrl, child, stop() }`. */
export function startServer(home, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO, "dist", "server", "main.js"), "--no-open", "--port", "0", ...extraArgs], {
      cwd: REPO,
      env: { ...process.env, AC_HOME: home, AM_HOME: "" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out} ${err}`)), 15000);
    child.stderr.on("data", (c) => (err += c));
    child.stdout.on("data", (c) => {
      out += c;
      for (const line of out.split("\n")) {
        if (!line.startsWith("{")) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.event === "listening") {
          clearTimeout(timer);
          resolve({
            port: event.port,
            launchUrl: event.launchUrl,
            child,
            output: () => out + err,
            stop: () =>
              new Promise((done) => {
                // A killed process keeps exitCode null and sets signalCode instead.
                if (child.exitCode !== null || child.signalCode !== null) return done();
                child.once("exit", () => done());
                child.kill();
              }),
          });
          return;
        }
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}: ${out} ${err}`));
    });
  });
}

/** Minimal test runner: named checks, counted, with the failure detail kept. */
export function checks(title) {
  const results = [];
  return {
    async check(name, fn) {
      try {
        const detail = await fn();
        results.push({ name, ok: true, detail });
        console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
      } catch (e) {
        results.push({ name, ok: false, detail: String(e?.stack ?? e) });
        console.log(`FAIL  ${name} — ${String(e?.message ?? e)}`);
      }
    },
    finish() {
      const failed = results.filter((r) => !r.ok).length;
      console.log(`\n${title}: ${results.length} checks, ${failed} failed`);
      return failed === 0 ? 0 : 1;
    },
  };
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
