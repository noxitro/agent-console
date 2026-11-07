/**
 * Command-level regression tests for the safety rules that only become
 * observable once `plan` / `apply` / `import` are driven end to end against a
 * disposable HOME:
 *
 *  - SPEC §5: an MCP server the source does not know about is *structurally*
 *    preserved by an apply without `--prune` — env, `tools` allowlists and
 *    unknown fields included — instead of being re-rendered from the lossy
 *    normalized projection.
 *  - SPEC §6.1: `~/.claude.json` is rendered inside the same transaction as the
 *    write, so a concurrent Claude Code update in the plan→write window is not
 *    reverted.
 *  - SPEC §5: `import` reports a cross-target conflict that lives only in `env`
 *    or `headers`.
 *  - SPEC §3: an agent name is validated everywhere it becomes a file name.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { runApply } from "../src/commands/apply.js";
import { collectDiagnostics, runDoctor } from "../src/commands/doctor.js";
import { runImport } from "../src/commands/import.js";
import { applyJson, importJson } from "../src/commands/json.js";
import { runPlan } from "../src/commands/plan.js";
import { bufferIo, type CommandIo } from "../src/commands/context.js";
import { AmError } from "../src/core/model.js";
import { writeSourceAgent, writeSourceServers } from "../src/core/source.js";

let home: string;
let previousHome: string | undefined;

function write(relative: string, content: string): string {
  const full = path.join(home, ...relative.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

function writeJson(relative: string, value: unknown): void {
  write(relative, `${JSON.stringify(value, null, 2)}\n`);
}

function read(relative: string): string {
  return fs.readFileSync(path.join(home, ...relative.split("/")), "utf8");
}

function readJson<T>(relative: string): T {
  return JSON.parse(read(relative)) as T;
}

function exists(relative: string): boolean {
  return fs.existsSync(path.join(home, ...relative.split("/")));
}

/**
 * A preserved extra is still *reported* (as an informational `delete` saying
 * "use --prune to remove"), so the plan exit code stays 1. What must not happen
 * is a `create`/`update` for the config file: that would mean the round trip
 * changed its bytes, i.e. the entry was re-rendered rather than preserved.
 */
function expectNoMcpRewrite(): void {
  const io = bufferIo();
  runPlan({ io });
  expect(io.text()).not.toMatch(/^ {2}(create|update) {6}mcp/m);
}

/** Enable exactly the targets a test cares about, so the plan stays readable. */
function manifest(enabled: readonly string[], exclude: readonly string[] = []): void {
  writeJson(".agents-manager/manifest.json", {
    version: 1,
    targets: {
      claude: { enabled: enabled.includes("claude") },
      "copilot-cli": { enabled: enabled.includes("copilot-cli") },
      vscode: { enabled: enabled.includes("vscode") },
      vs2026: { enabled: enabled.includes("vs2026") },
      opencode: { enabled: enabled.includes("opencode") },
    },
    skills: { linkMode: "junction", exclude: [...exclude] },
  });
}

function sourceServers(servers: Record<string, unknown>): void {
  writeJson(".agents-manager/mcp/servers.json", { servers });
}

beforeEach(() => {
  previousHome = process.env["AM_HOME"];
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "am-reg-")));
  process.env["AM_HOME"] = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env["AM_HOME"];
  else process.env["AM_HOME"] = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Unmanaged MCP servers survive an apply intact (SPEC §5)             */
/* ------------------------------------------------------------------ */

describe("apply preserves MCP servers the source does not manage", () => {
  it("keeps a claude server's env and unknown fields byte-for-byte", () => {
    manifest(["claude"]);
    sourceServers({ managed: { transport: "stdio", command: "npx", args: ["-y", "managed"] } });
    const unmanaged = {
      type: "stdio",
      command: "npx",
      args: ["-y", "some-pkg"],
      env: { PORT: 3000, TOKEN: "abc" },
      timeout: 60000,
      scope: "user",
    };
    writeJson(".claude.json", { numStartups: 1, mcpServers: { unmanaged } });

    expect(runApply({ io: bufferIo() })).toBe(0);

    const doc = readJson<{ mcpServers: Record<string, unknown> }>(".claude.json");
    expect(doc.mcpServers["unmanaged"]).toEqual(unmanaged);
    expect(doc.mcpServers["managed"]).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "managed"],
    });
    // And the file is a fixed point: no further rewrite is planned (SPEC §8).
    expectNoMcpRewrite();
  });

  it("does not widen an unmanaged copilot server's tools allowlist", () => {
    manifest(["copilot-cli"]);
    sourceServers({ managed: { transport: "stdio", command: "npx" } });
    const unmanaged = { type: "local", command: "mytool", tools: ["read_file"], customField: 42 };
    writeJson(".copilot/mcp-config.json", { mcpServers: { unmanaged } });

    expect(runApply({ io: bufferIo() })).toBe(0);

    const doc = readJson<{ mcpServers: Record<string, { tools?: string[] }> }>(
      ".copilot/mcp-config.json",
    );
    expect(doc.mcpServers["unmanaged"]).toEqual(unmanaged);
    expect(doc.mcpServers["managed"]?.tools).toEqual(["*"]);
    expectNoMcpRewrite();
  });

  it("does not delete an sse entry VS Code cannot express (SPEC §4 skip ≠ delete)", () => {
    manifest(["vscode"]);
    sourceServers({ managed: { transport: "stdio", command: "npx" } });
    const streamer = { type: "sse", url: "https://s.test/sse" };
    const mcpJson = "AppData/Roaming/Code/User/mcp.json";
    writeJson(mcpJson, { inputs: [], servers: { streamer } });

    expect(runApply({ io: bufferIo() })).toBe(0);

    const doc = readJson<{ servers: Record<string, unknown> }>(mcpJson);
    expect(doc.servers["streamer"]).toEqual(streamer);
    expect(Object.keys(doc.servers).sort()).toEqual(["managed", "streamer"]);
    expectNoMcpRewrite();
  });

  it("keeps a source-declared sse server that mcp.json already holds", () => {
    manifest(["vscode"]);
    sourceServers({ streamer: { transport: "sse", url: "https://s.test/sse" } });
    const streamer = { type: "sse", url: "https://s.test/sse" };
    const mcpJson = "AppData/Roaming/Code/User/mcp.json";
    writeJson(mcpJson, { servers: { streamer } });

    const io = bufferIo();
    runPlan({ io });
    expect(io.text()).toContain("skipped");

    expect(runApply({ io: bufferIo() })).toBe(0);
    expect(readJson<{ servers: Record<string, unknown> }>(mcpJson).servers["streamer"]).toEqual(
      streamer,
    );
  });

  it("still removes an unmanaged server under --prune --yes", () => {
    manifest(["claude"]);
    sourceServers({});
    writeJson(".claude.json", {
      mcpServers: { unmanaged: { type: "stdio", command: "x", env: { A: 1 } } },
    });

    expect(runApply({ io: bufferIo(), prune: true, yes: true })).toBe(0);
    expect(readJson<{ mcpServers: unknown }>(".claude.json").mcpServers).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
/* Minimal touch on a live state file (SPEC §6.1)                      */
/* ------------------------------------------------------------------ */

describe("an existing config with nothing to deliver", () => {
  it("does not gain an empty mcpServers key", () => {
    manifest(["claude", "copilot-cli", "vscode"]);
    sourceServers({});
    writeJson(".claude.json", { numStartups: 1, oauthAccount: { emailAddress: "u@example.com" } });
    writeJson(".copilot/mcp-config.json", { other: 1 });
    writeJson("AppData/Roaming/Code/User/mcp.json", { inputs: [] });

    const before = read(".claude.json");
    expect(runPlan({ io: bufferIo() })).toBe(0);
    expect(runApply({ io: bufferIo() })).toBe(0);

    expect(read(".claude.json")).toBe(before);
    expect(readJson<Record<string, unknown>>(".copilot/mcp-config.json")).toEqual({ other: 1 });
    expect(readJson<Record<string, unknown>>("AppData/Roaming/Code/User/mcp.json")).toEqual({
      inputs: [],
    });
  });
});

/* ------------------------------------------------------------------ */
/* TOCTOU on ~/.claude.json (SPEC §6.1)                                */
/* ------------------------------------------------------------------ */

describe("~/.claude.json is rendered in the same transaction as the write", () => {
  /**
   * Claude Code rewrites `~/.claude.json` constantly. This drives a write into
   * the gap between planning and the MCP `rename` by hooking the output sink:
   * skill actions are executed before MCP ones, so the hook fires while the run
   * is still in progress — exactly the window a plan-time snapshot would let a
   * concurrent update fall into.
   */
  function ioThatMutatesClaudeJsonOnce(): CommandIo & { fired: boolean } {
    const inner = bufferIo();
    const hook = {
      fired: false,
      out(line = ""): void {
        inner.out(line);
        if (hook.fired || !line.includes("skill")) return;
        hook.fired = true;
        const doc = readJson<Record<string, unknown>>(".claude.json");
        doc["lastSessionId"] = "concurrent-session";
        (doc["oauthAccount"] as Record<string, unknown>)["accessToken"] = "refreshed";
        writeJson(".claude.json", doc);
      },
      err(line: string): void {
        inner.err(line);
      },
    };
    return hook;
  }

  it("does not revert a concurrent update to another top-level key", () => {
    manifest(["claude"]);
    write(".agents/skills/demo/SKILL.md", "---\nname: demo\ndescription: d\n---\n\nbody\n");
    sourceServers({ managed: { transport: "stdio", command: "npx" } });
    writeJson(".claude.json", {
      numStartups: 1,
      oauthAccount: { emailAddress: "u@example.com", accessToken: "stale" },
    });

    const io = ioThatMutatesClaudeJsonOnce();
    expect(runApply({ io })).toBe(0);
    expect(io.fired).toBe(true);

    const doc = readJson<Record<string, unknown>>(".claude.json");
    expect(doc["lastSessionId"]).toBe("concurrent-session");
    expect(doc["oauthAccount"]).toEqual({
      emailAddress: "u@example.com",
      accessToken: "refreshed",
    });
    expect(doc["mcpServers"]).toEqual({ managed: { type: "stdio", command: "npx" } });
    expect(runPlan({ io: bufferIo() })).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* import conflict detection reaches into env / headers (SPEC §5)      */
/* ------------------------------------------------------------------ */

describe("import detects conflicts that live only in env or headers", () => {
  it("refuses when two targets disagree about an env value", () => {
    manifest(["claude", "copilot-cli"]);
    writeJson(".claude.json", {
      mcpServers: { gh: { type: "stdio", command: "npx", env: { TOKEN: "a" } } },
    });
    writeJson(".copilot/mcp-config.json", {
      mcpServers: { gh: { type: "local", command: "npx", env: { TOKEN: "b" }, tools: ["*"] } },
    });

    const io = bufferIo();
    expect(() => runImport({ io })).toThrow(/conflicting definitions/i);
    // The printed candidates must actually show the differing values.
    expect(io.errors.join("\n")).toContain('"TOKEN": "a"');
    expect(io.errors.join("\n")).toContain('"TOKEN": "b"');
  });

  it("refuses when two targets disagree about a header value", () => {
    manifest(["claude", "copilot-cli"]);
    writeJson(".claude.json", {
      mcpServers: { api: { type: "http", url: "https://a.test", headers: { Auth: "old" } } },
    });
    writeJson(".copilot/mcp-config.json", {
      mcpServers: { api: { type: "http", url: "https://a.test", headers: { Auth: "new" } } },
    });

    expect(() => runImport({ io: bufferIo() })).toThrow(/conflicting definitions/i);
  });

  it("obeys --prefer for an env-only conflict", () => {
    manifest(["claude", "copilot-cli"]);
    writeJson(".claude.json", {
      mcpServers: { gh: { type: "stdio", command: "npx", env: { TOKEN: "a" } } },
    });
    writeJson(".copilot/mcp-config.json", {
      mcpServers: { gh: { type: "local", command: "npx", env: { TOKEN: "b" }, tools: ["*"] } },
    });

    expect(runImport({ io: bufferIo(), prefer: "copilot-cli" })).toBe(0);
    const source = readJson<{ servers: Record<string, { env?: Record<string, string> }> }>(
      ".agents-manager/mcp/servers.json",
    );
    expect(source.servers["gh"]?.env).toEqual({ TOKEN: "b" });
  });

  it("re-imports an env change instead of keeping the stale source entry", () => {
    manifest(["claude"]);
    sourceServers({
      gh: { transport: "stdio", command: "npx", env: { TOKEN: "old" }, targets: ["claude"] },
    });
    writeJson(".claude.json", {
      mcpServers: { gh: { type: "stdio", command: "npx", env: { TOKEN: "rotated" } } },
    });

    expect(runImport({ io: bufferIo() })).toBe(0);
    const source = readJson<{ servers: Record<string, { env?: Record<string, string> }> }>(
      ".agents-manager/mcp/servers.json",
    );
    expect(source.servers["gh"]?.env).toEqual({ TOKEN: "rotated" });
  });

  it("keeps the source entry (and its targets) when nothing actually changed", () => {
    manifest(["claude"]);
    sourceServers({
      gh: { transport: "stdio", command: "npx", env: { TOKEN: "same" }, targets: ["claude"] },
    });
    writeJson(".claude.json", {
      mcpServers: { gh: { type: "stdio", command: "npx", env: { TOKEN: "same" } } },
    });

    expect(runImport({ io: bufferIo() })).toBe(0);
    const source = readJson<{ servers: Record<string, { targets?: string[] }> }>(
      ".agents-manager/mcp/servers.json",
    );
    expect(source.servers["gh"]?.targets).toEqual(["claude"]);
  });
});

/* ------------------------------------------------------------------ */
/* Agent names never escape their directory (SPEC §3)                  */
/* ------------------------------------------------------------------ */

describe("agent name validation on every write path", () => {
  it("refuses to apply an agent whose name would traverse out of the directory", () => {
    manifest(["claude", "copilot-cli", "vs2026"]);
    write(
      ".agents-manager/agents/evil.md",
      "---\nname: ../../evil\ndescription: d\n---\n\nbody\n",
    );

    expect(() => runApply({ io: bufferIo() })).toThrow(AmError);
    expect(fs.existsSync(path.join(home, "..", "evil.md"))).toBe(false);
    expect(exists("evil.md")).toBe(false);
  });

  it("refuses to import a target agent whose frontmatter name traverses", () => {
    manifest(["claude"]);
    write(".claude/agents/ok.md", "---\nname: ../../evil\ndescription: d\n---\n\nbody\n");
    // A validly named sibling, to pin that the refusal costs nothing else.
    write(".claude/agents/reviewer.md", "---\nname: reviewer\ndescription: d\n---\n\nbody\n");

    // The name is refused during *collection*, so nothing is written outside
    // the managed directory and the migration still completes for everything
    // else. It used to throw from `writeSourceAgent`, i.e. after
    // `mcp/servers.json` had been written and after `--move` had already
    // relocated skill directories — a half-populated source and exit 2.
    const result = importJson({}, bufferIo());
    expect(result.exitCode).toBe(0);
    expect(result.payload.rejected).toContainEqual({
      assetType: "agent",
      asset: "../../evil",
      from: "claude",
      reason: "name is not lowercase alphanumerics and hyphens (≤64 chars)",
    });
    expect(result.payload.imported).toContainEqual({
      assetType: "agent",
      asset: "reviewer",
      from: "claude",
    });

    expect(fs.existsSync(path.join(home, "..", "evil.md"))).toBe(false);
    expect(exists("evil.md")).toBe(false);
    expect(exists(".agents-manager/evil.md")).toBe(false);
    expect(exists(".agents-manager/agents/reviewer.md")).toBe(true);
  });

  it("still refuses the traversal at the write boundary, as the last line of defence", () => {
    // The collection-phase check above is the *policy*; this is the guard that
    // holds if a future caller reaches the writer another way (SPEC §3).
    manifest(["claude"]);
    expect(() =>
      writeSourceAgent({ name: "../../evil", description: "d", body: "b" }),
    ).toThrow(AmError);
    expect(fs.existsSync(path.join(home, "..", "evil.md"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Excluded skills and stray files are not orphans (SPEC §5)           */
/* ------------------------------------------------------------------ */

describe("prune scope is limited to managed assets", () => {
  it("never deletes a skill that is merely excluded, on either target", () => {
    manifest(["claude", "copilot-cli"], ["excluded"]);
    for (const name of ["kept", "excluded"]) {
      write(`.agents/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: d\n---\n\nb\n`);
    }
    write(".claude/skills/excluded/SKILL.md", "---\nname: excluded\ndescription: d\n---\n\nb\n");
    write(".copilot/skills/excluded/SKILL.md", "---\nname: excluded\ndescription: d\n---\n\nb\n");

    const io = bufferIo();
    runPlan({ io });
    expect(io.text()).not.toContain("delete");

    expect(runApply({ io: bufferIo(), prune: true, yes: true })).toBe(0);
    expect(exists(".claude/skills/excluded/SKILL.md")).toBe(true);
    expect(exists(".copilot/skills/excluded/SKILL.md")).toBe(true);
  });

  it("never deletes a stray file the tool never managed", () => {
    manifest(["claude"]);
    write(".agents/skills/kept/SKILL.md", "---\nname: kept\ndescription: d\n---\n\nb\n");
    write(".claude/skills/notes.txt", "personal notes\n");

    const io = bufferIo();
    runPlan({ io });
    expect(io.text()).not.toContain("delete");

    expect(runApply({ io: bufferIo(), prune: true, yes: true })).toBe(0);
    expect(read(".claude/skills/notes.txt")).toBe("personal notes\n");
  });
});

/* ------------------------------------------------------------------ */
/* import never writes an unreadable source of truth (SPEC §3, §6.3)   */
/* ------------------------------------------------------------------ */

describe("import validates against the normalized schema before writing", () => {
  /**
   * The target dialects are lenient (copilot-cli infers a missing `type`, and a
   * hand-written `~/.claude.json` may omit `command` entirely), while
   * `mcp/servers.json` is read back strictly. Writing a stdio entry with no
   * `command` therefore used to brick the tool: every later command — `plan`,
   * `doctor`, even a second `import` — exits 2 while parsing the source, and no
   * CLI command can edit it back into shape.
   */
  it("leaves a command-less stdio server out and keeps the source readable", () => {
    manifest(["claude"]);
    writeJson(".claude.json", {
      mcpServers: {
        broken: { type: "stdio", args: ["-y", "thing"] },
        good: { type: "stdio", command: "npx", args: ["-y", "thing"] },
      },
    });

    const io = bufferIo();
    expect(runImport({ io })).toBe(0);

    const stored = readJson<{ servers: Record<string, unknown> }>(
      ".agents-manager/mcp/servers.json",
    ).servers;
    expect(Object.keys(stored)).toEqual(["good"]);
    // Rejection is reported, not silent (PRODUCT: 失敗は大きく表示).
    expect(io.errors.join("\n")).toContain('Skipped mcp server "broken"');
    expect(io.errors.join("\n")).toContain("command");

    // The whole point: the tool still works afterwards. `broken` stays in
    // `~/.claude.json` as an unmanaged extra, which `plan` reports as preserved
    // rather than as a pending difference — so this exits 0.
    expect(runPlan({ io: bufferIo() })).toBe(0);
    expect(runDoctor({ io: bufferIo() })).toBe(0);
    expect(runApply({ io: bufferIo() })).toBe(0);
  });

  it("reports the rejection in the --json report", () => {
    manifest(["copilot-cli"]);
    writeJson(".copilot/mcp-config.json", {
      mcpServers: { broken: { type: "local", tools: ["*"] } },
    });

    const result = importJson({}, bufferIo());

    expect(result.exitCode).toBe(0);
    expect(result.payload.imported).toEqual([]);
    expect(result.payload.rejected).toHaveLength(1);
    expect(result.payload.rejected[0]?.asset).toBe("broken");
    expect(result.payload.rejected[0]?.from).toBe("copilot-cli");
    expect(result.payload.rejected[0]?.reason).toContain("command");
  });

  it("refuses at the write boundary as well, whoever the caller is", () => {
    manifest(["claude"]);
    expect(() =>
      writeSourceServers({ broken: { transport: "stdio" } }),
    ).toThrow(AmError);
    expect(exists(".agents-manager/mcp/servers.json")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* doctor reports a parse failure instead of dying of it (SPEC §5)     */
/* ------------------------------------------------------------------ */

describe("doctor survives an unreadable agent file in a target", () => {
  /**
   * `doctor`'s contract, stated at the top of the module: an unparseable file
   * *is* the finding. `checkTargetAgents` was the one check that let the throw
   * escape, so a single corrupt `.agent.md` in `~/.copilot/agents/` replaced
   * the entire report — broken junctions, duplicate copies and all — with a
   * bare exit 2.
   */
  it("turns broken frontmatter into a finding and still reports the rest", () => {
    manifest(["copilot-cli"]);
    write(".agents/skills/demo/SKILL.md", "---\nname: demo\ndescription: d\n---\n\nb\n");
    // A junction whose destination is gone: the finding the user came for.
    write(".copilot/skills/ghost/SKILL.md", "---\nname: ghost\ndescription: d\n---\n\nb\n");
    write(".copilot/agents/broken.agent.md", "---\nname: [unterminated\ndescription: d\n---\n\nb\n");

    const findings = collectDiagnostics();
    const codes = findings.map((f) => f.code);

    expect(codes).toContain("agent.unreadable");
    expect(findings.find((f) => f.code === "agent.unreadable")?.target).toBe("copilot-cli");
    // The rest of the report survived.
    expect(codes).toContain("skill.unmanaged-copy");
    expect(runDoctor({ io: bufferIo() })).toBe(1);
  });

  /**
   * The same conversion, for the file class it had never been applied to.
   * `collectDiagnostics` never called `readMcp`, so the one state in which
   * `inventory`, `plan` and `apply` all exit 2 — an unparseable
   * `~/.claude.json`, the live state file this tool is most careful with
   * (SPEC §6.1) — produced zero findings and `doctor` said the machine was
   * healthy.
   */
  it("turns an unparseable ~/.claude.json into a finding rather than silence", () => {
    manifest(["claude"]);
    write(".claude.json", "{ oauthAccount: not json at all\n");
    write(".agents/skills/demo/SKILL.md", "---\nname: demo\ndescription: d\n---\n\nb\n");

    // Every other command stops here (SPEC §6.3).
    expect(() => runPlan({ io: bufferIo() })).toThrow(AmError);

    const findings = collectDiagnostics();
    const finding = findings.find((f) => f.code === "mcp.unreadable");
    expect(finding?.level).toBe("error");
    expect(finding?.target).toBe("claude");
    expect(finding?.path).toBe(path.join(home, ".claude.json"));
    expect(runDoctor({ io: bufferIo() })).toBe(1);
  });

  it("says nothing about a target whose MCP support is a documented refusal", () => {
    // vs2026 answers "unsupported" (SPEC §4). A refusal is not a fault, and
    // must not become one now that doctor opens the MCP files.
    manifest(["vs2026"]);
    expect(collectDiagnostics().filter((f) => f.code === "mcp.unreadable")).toEqual([]);
    expect(runDoctor({ io: bufferIo() })).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* A failed apply still hands back its audit trail (SPEC §5)           */
/* ------------------------------------------------------------------ */

describe("apply --json reports a partial application", () => {
  /**
   * A *file* sitting where the agents *directory* belongs makes the write fail
   * when `apply` tries to create that directory — and only then, because every
   * read of the path returns "nothing there". Actions are ordered
   * skill → mcp → agent, so the failure lands after real writes have happened:
   * exactly the case where dropping the report loses the record of what changed
   * and of where the backups went.
   */
  function seedApplyThatFailsOnTheAgent(): void {
    manifest(["claude"]);
    write(".agents/skills/demo/SKILL.md", "---\nname: demo\ndescription: d\n---\n\nb\n");
    sourceServers({ managed: { transport: "stdio", command: "npx" } });
    write(
      ".agents-manager/agents/code-reviewer.md",
      "---\nname: code-reviewer\ndescription: d\n---\n\nbody\n",
    );
    write(".claude/agents", "not a directory\n");
  }

  it("keeps the applied entries, the backup directory and the failed action", () => {
    seedApplyThatFailsOnTheAgent();

    const result = applyJson({}, bufferIo());

    expect(result.exitCode).toBe(2);
    const { applied, backupDir, error } = result.payload;
    // The backup directory is the only route back from a partial write.
    expect(backupDir).toBeDefined();
    expect(error?.message).toBeTruthy();
    expect(applied.some((entry) => entry.status === "done")).toBe(true);
    const failed = applied.filter((entry) => entry.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.assetType).toBe("agent");
    expect(failed[0]?.error).toBeTruthy();
    // What it says was written really was written.
    for (const entry of applied.filter((e) => e.status === "done")) {
      expect(fs.existsSync(entry.path)).toBe(true);
    }
  });

  it("emits that payload on stdout and still exits 2", () => {
    seedApplyThatFailsOnTheAgent();

    const io = bufferIo();
    const code = main(["node", "cli.js", "apply", "--json"], { io });

    expect(code).toBe(2);
    const payload = JSON.parse(io.lines.join("\n")) as {
      applied: { status: string }[];
      backupDir?: string;
      error?: { message: string };
    };
    expect(payload.backupDir).toBeDefined();
    expect(payload.applied.some((entry) => entry.status === "done")).toBe(true);
    expect(payload.applied.some((entry) => entry.status === "failed")).toBe(true);
    expect(payload.error?.message).toBeTruthy();
    expect(io.errors.some((line) => line.startsWith("error: "))).toBe(true);
  });

  it("still reports a failure that happens before the first write", () => {
    manifest(["claude"]);
    write(".agents/skills/demo/SKILL.md", "---\nname: demo\ndescription: d\n---\n\nb\n");
    write(".claude/skills/demo/SKILL.md", "---\nname: demo\ndescription: OTHER\n---\n\nb\n");

    const result = applyJson({}, bufferIo());

    expect(result.exitCode).toBe(2);
    expect(result.payload.error?.message).toMatch(/drift/i);
    // Nothing was written, so there is no backup directory to name.
    expect(result.payload.backupDir).toBeUndefined();
    expect(result.payload.applied.every((entry) => entry.status === "skipped")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* SPEC §9.7 — the three skill-slot classifiers must not drift          */
/* ------------------------------------------------------------------ */

/**
 * Three adapters classify what occupies a skill slot, and they are deliberately
 * *not* one function: each infers junction-vs-symlink differently, and
 * `skill-discovery` alone reports a link-to-a-file as `file`. Those differences
 * are documented decisions about three different directories, so unifying them
 * would change behaviour.
 *
 * What must not differ is the rule added in §9.7: a `lstat` that failed for a
 * reason other than absence is `unreadable`, and it is decided *before*
 * `!info.exists`, because every branch below that line reads `exists: false` as
 * 「無い」. Copying a classifier is how v3.1 ended up with two adapters
 * disagreeing about one directory (SPEC §5); this pins the branch in all three
 * without merging them.
 */
describe("the unreadable branch exists in every skill-slot classifier", () => {
  const CLASSIFIERS = [
    "src/adapters/skill-discovery.ts",
    "src/adapters/claude.ts",
    "src/adapters/copilot-cli.ts",
  ] as const;

  it("classifies unreadable before falling through to missing", () => {
    for (const file of CLASSIFIERS) {
      const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      const unreadableAt = source.indexOf('kind = "unreadable"');
      const missingAt = source.indexOf('kind = "missing"');
      expect(unreadableAt, file).toBeGreaterThan(-1);
      expect(missingAt, file).toBeGreaterThan(-1);
      // Order is the rule: `!info.exists` is true for a refused lstat too.
      expect(unreadableAt, file).toBeLessThan(missingAt);
      // And the engine's reason is carried, not dropped (PRODUCT: 捏造しない).
      expect(source, file).toContain("link.unreadable = info.unreadable");
    }
  });
});
