/**
 * Snapshot tests for the `--json` contract of every command.
 *
 * These drive the real CLI entry point (`main`), not the command functions, so
 * three things are covered at once: the option wiring, the payload shape, and
 * the two invariants that make the output machine-readable at all —
 *
 *   1. stdout carries **exactly one line**, and it parses as JSON;
 *   2. the human-readable rendering is suppressed entirely.
 *
 * Everything path-shaped is redacted before snapshotting: the throwaway HOME is
 * a fresh temp directory on every run, and `apply`'s backup directory is named
 * after the wall clock. Snapshotting them raw would make the tests fail for
 * reasons that have nothing to do with the contract.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { bufferIo } from "../src/commands/context.js";

/* ------------------------------------------------------------------ */
/* Fake HOME                                                           */
/* ------------------------------------------------------------------ */

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env["AM_HOME"];
  // `realpathSync` defeats Windows 8.3 short paths, which would otherwise leak
  // an unredactable spelling of the temp directory into a junction destination.
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "am-json-")));
  process.env["AM_HOME"] = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env["AM_HOME"];
  else process.env["AM_HOME"] = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function write(relative: string, content: string): void {
  const full = path.join(home, ...relative.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

function writeJson(relative: string, value: unknown): void {
  write(relative, `${JSON.stringify(value, null, 2)}\n`);
}

/* ------------------------------------------------------------------ */
/* Redaction                                                           */
/* ------------------------------------------------------------------ */

function redactString(value: string): string {
  const slashed = value.split("\\").join("/");
  const target = home.split("\\").join("/");
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return slashed
    .replace(new RegExp(escaped, "gi"), "<HOME>")
    // `backups/<ISO timestamp>` is generated from the clock (SPEC §5).
    .replace(/backups\/[^/"]+/g, "backups/<TS>");
}

/** Recursively replace the volatile parts of a payload with stable markers. */
function redact(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        key,
        // SPEC §9.3's `modified` is a real file mtime, so it is different on
        // every run of a test that has just written the file.
        key === "modified" && typeof inner === "string" ? "<MTIME>" : redact(inner),
      ]),
    );
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Driver                                                              */
/* ------------------------------------------------------------------ */

interface CliResult {
  code: number;
  payload: unknown;
  errors: string[];
}

/** Run `am <args>` through the real entry point and decode its stdout. */
function runCli(...args: string[]): CliResult {
  const io = bufferIo();
  const code = main(["node", "cli.js", ...args], { io });
  // The contract: one JSON object on stdout and nothing else.
  expect(io.lines).toHaveLength(1);
  const line = io.lines[0] ?? "";
  return { code, payload: redact(JSON.parse(line)), errors: io.errors };
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const SKILL_MD = (name: string, description: string, extra = ""): string =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nInstructions for ${name}.\n`;

const MANIFEST = {
  version: 1,
  targets: {
    claude: { enabled: true },
    "copilot-cli": { enabled: true },
    vscode: { enabled: true },
    vs2026: { enabled: true },
  },
  skills: { linkMode: "junction", exclude: [] },
};

/**
 * A populated source of truth: one skill, three MCP servers (one of them `sse`,
 * which VS Code cannot express — SPEC §4) and one agent. Nothing is distributed
 * yet, so `plan` has work to describe for every target.
 */
function seedSource(): void {
  writeJson(".agents-manager/manifest.json", MANIFEST);
  write(".agents/skills/demo-skill/SKILL.md", SKILL_MD("demo-skill", "A demo skill."));
  write(".agents/skills/demo-skill/reference/notes.md", "nested reference file\n");
  writeJson(".agents-manager/mcp/servers.json", {
    servers: {
      docs: { transport: "http", url: "https://example.invalid/mcp" },
      filesystem: { transport: "stdio", command: "npx", args: ["-y", "server-filesystem", "."] },
      legacy: { transport: "sse", url: "https://example.invalid/sse" },
    },
  });
  write(
    ".agents-manager/agents/code-reviewer.md",
    "---\nname: code-reviewer\ndescription: Reviews changes for correctness.\ntools:\n  - Read\n  - Grep\nmodel: sonnet\n---\n\nYou are a meticulous code reviewer.\n",
  );
}

/**
 * An environment that has never been managed: assets live only inside the
 * targets, and one agent disagrees between Claude Code and Copilot — the
 * cross-target conflict SPEC §5 refuses to resolve on its own.
 */
function seedUnmanagedEnvironment(): void {
  writeJson(".agents-manager/manifest.json", MANIFEST);
  writeJson(".claude.json", {
    numStartups: 42,
    oauthAccount: { emailAddress: "user@example.com" },
    mcpServers: {
      filesystem: { type: "stdio", command: "npx", args: ["-y", "server-filesystem", "."] },
    },
    projects: {},
  });
  write(".claude/skills/extra-skill/SKILL.md", SKILL_MD("extra-skill", "An extra skill."));
  write(
    ".claude/agents/code-reviewer.md",
    "---\nname: code-reviewer\ndescription: Reviews changes for correctness.\ntools: Read, Grep\n---\n\nClaude's version of the reviewer.\n",
  );
  write(
    ".copilot/agents/code-reviewer.agent.md",
    "---\nname: code-reviewer\ndescription: Reviews changes for correctness.\ntools: [\"Read\"]\n---\n\nCopilot's version of the reviewer.\n",
  );
}

/* ------------------------------------------------------------------ */
/* inventory                                                           */
/* ------------------------------------------------------------------ */

describe("am inventory --json", () => {
  it("describes the source and every target", () => {
    seedSource();
    // A physical duplicate inside a target: the one state where "who sees what"
    // is genuinely ambiguous, so the snapshot must show it.
    write(".copilot/skills/demo-skill/SKILL.md", SKILL_MD("demo-skill", "A demo skill."));

    const result = runCli("inventory", "--json");

    expect(result.code).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.payload).toMatchSnapshot();
  });

  it("reports junction destinations once the plan has been applied", () => {
    seedSource();
    expect(main(["node", "cli.js", "apply"], { io: bufferIo() })).toBe(0);

    const result = runCli("inventory", "--json");

    expect(result.code).toBe(0);
    expect(result.payload).toMatchSnapshot();
  });
});

/* ------------------------------------------------------------------ */
/* doctor                                                              */
/* ------------------------------------------------------------------ */

describe("am doctor --json", () => {
  it("emits an empty finding list for a clean environment", () => {
    seedSource();
    expect(main(["node", "cli.js", "apply"], { io: bufferIo() })).toBe(0);

    const result = runCli("doctor", "--json");

    expect(result.code).toBe(0);
    expect(result.payload).toEqual({ findings: [] });
  });

  it("reports findings with their target and asset", () => {
    seedSource();
    // A non-spec frontmatter field (warning, SPEC §3) …
    write(
      ".agents/skills/demo-skill/SKILL.md",
      SKILL_MD("demo-skill", "A demo skill.", "argument-hint: <path>\n"),
    );
    // … and a skill directory in a target with no counterpart in the source.
    write(".copilot/skills/orphan-skill/SKILL.md", SKILL_MD("orphan-skill", "Not in the source."));

    const result = runCli("doctor", "--json");

    expect(result.code).toBe(1);
    expect(result.payload).toMatchSnapshot();
  });
});

/* ------------------------------------------------------------------ */
/* plan                                                                */
/* ------------------------------------------------------------------ */

describe("am plan --json", () => {
  it("lists every action, including the unsupported ones", () => {
    seedSource();

    const result = runCli("plan", "--json");

    expect(result.code).toBe(1);
    expect(result.payload).toMatchSnapshot();
  });

  it("keeps only the unsupported notes at the fixed point", () => {
    seedSource();
    expect(main(["node", "cli.js", "apply"], { io: bufferIo() })).toBe(0);

    const result = runCli("plan", "--json");

    // `unsupported` entries are notes, not differences: they survive the fixed
    // point and still exit 0 (SPEC §4 — vs2026 MCP, VS Code + `sse`).
    expect(result.code).toBe(0);
    const payload = result.payload as { actions: { kind: string }[] };
    expect(payload.actions.every((action) => action.kind === "unsupported")).toBe(true);
    expect(payload.actions.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* apply                                                               */
/* ------------------------------------------------------------------ */

describe("am apply --json", () => {
  it("reports the status of every action and the backup directory", () => {
    seedSource();

    const result = runCli("apply", "--json");

    expect(result.code).toBe(0);
    expect(result.payload).toMatchSnapshot();
  });

  it("reports a dry run as applying nothing", () => {
    seedSource();

    const result = runCli("apply", "--dry-run", "--json");

    // `--dry-run` is `plan` (SPEC §5): the difference is still exit code 1 …
    expect(result.code).toBe(1);
    // … and nothing may be recorded as done.
    const payload = result.payload as { applied: { status: string }[]; backupDir?: string };
    expect(payload.applied.every((entry) => entry.status === "skipped")).toBe(true);
    expect(payload.backupDir).toBeUndefined();
    expect(fs.existsSync(path.join(home, ".claude", "agents"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* import                                                              */
/* ------------------------------------------------------------------ */

describe("am import --json", () => {
  it("lists what was lifted in and how each conflict was resolved", () => {
    seedUnmanagedEnvironment();

    const result = runCli("import", "--json", "--prefer", "claude", "--move");

    expect(result.code).toBe(0);
    expect(result.payload).toMatchSnapshot();
  });
});

/* ------------------------------------------------------------------ */
/* Errors (exit code 2)                                                */
/* ------------------------------------------------------------------ */

describe("--json error reporting", () => {
  it("puts the error object on stdout and the human text on stderr", () => {
    seedUnmanagedEnvironment(); // the agent conflict, left unresolved

    const result = runCli("import", "--json");

    expect(result.code).toBe(2);
    expect(result.payload).toMatchSnapshot();
    // The human channel is untouched: the conflict listing still reaches stderr
    // so a person watching the terminal sees both candidates, and the CLI's own
    // `error:` line follows it.
    const stderr = result.errors.join("\n");
    expect(stderr).toContain('Conflict: agent "code-reviewer"');
    expect(stderr).toContain("--- claude ---");
    expect(stderr).toContain("--- copilot-cli ---");
    expect(stderr).toContain("error: ");
  });

  it("reports a malformed source file as an error with its path", () => {
    writeJson(".agents-manager/manifest.json", MANIFEST);
    write(".agents-manager/mcp/servers.json", "{ this is not json\n");

    const result = runCli("plan", "--json");

    expect(result.code).toBe(2);
    const payload = result.payload as { error: { message: string; path?: string } };
    // The message quotes the parser and therefore the Node version; only its
    // presence is contractual.
    expect(typeof payload.error.message).toBe("string");
    expect(payload.error.message.length).toBeGreaterThan(0);
    expect(payload.error.path).toBe("<HOME>/.agents-manager/mcp/servers.json");
    expect(result.errors.some((line) => line.startsWith("error: "))).toBe(true);
  });
});
