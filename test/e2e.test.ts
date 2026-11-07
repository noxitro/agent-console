/**
 * End-to-end tests (SPEC §8).
 *
 * A throwaway HOME is built in a temp directory and handed to the tool through
 * `AM_HOME`, so every path the commands touch is real but disposable. The
 * central assertion is the fixed point the spec demands:
 *
 *     import → apply → plan == no difference
 *
 * Junctions are exercised on the actual file system rather than mocked — the
 * whole point of SPEC §6.6 is what Windows does with a real reparse point —
 * and one case forces the documented copy fallback.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runApply } from "../src/commands/apply.js";
import { collectDiagnostics, runDoctor } from "../src/commands/doctor.js";
import { runImport } from "../src/commands/import.js";
import { runInventory } from "../src/commands/inventory.js";
import { runPlan } from "../src/commands/plan.js";
import { bufferIo } from "../src/commands/context.js";
import { createJunction, directoriesIdentical, inspectPath, linkPointsTo } from "../src/core/fsops.js";
import { main } from "../src/cli.js";

/* ------------------------------------------------------------------ */
/* Fake HOME                                                           */
/* ------------------------------------------------------------------ */

let home: string;
let previousHome: string | undefined;

function write(relative: string, content: string): string {
  const full = path.join(home, ...relative.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

function read(relative: string): string {
  return fs.readFileSync(path.join(home, ...relative.split("/")), "utf8");
}

function abs(relative: string): string {
  return path.join(home, ...relative.split("/"));
}

function exists(relative: string): boolean {
  return fs.existsSync(abs(relative));
}

const SKILL_MD = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nInstructions for ${name}.\n`;

/**
 * The starting environment: one skill already in the source, one skill living
 * as a physical copy inside a target, plus MCP servers and an agent that exist
 * only in Claude Code — i.e. exactly the "migrate an existing setup" shape
 * `import` is for.
 */
function seedEnvironment(): void {
  // Source of truth: one skill.
  write(".agents/skills/demo-skill/SKILL.md", SKILL_MD("demo-skill", "A demo skill."));
  write(".agents/skills/demo-skill/reference/notes.md", "nested reference file\n");

  // A physical skill directory that only Claude Code knows about.
  write(".claude/skills/extra-skill/SKILL.md", SKILL_MD("extra-skill", "An extra skill."));

  // `~/.claude.json` is a live state file: the other keys must survive (SPEC §6.1).
  write(
    ".claude.json",
    `${JSON.stringify(
      {
        numStartups: 42,
        oauthAccount: { emailAddress: "user@example.com" },
        mcpServers: {
          filesystem: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
          },
          docs: { type: "http", url: "https://example.invalid/mcp" },
        },
        projects: {},
      },
      null,
      2,
    )}\n`,
  );

  write(
    ".claude/agents/code-reviewer.md",
    "---\nname: code-reviewer\ndescription: Reviews changes for correctness.\ntools: Read, Grep\nmodel: sonnet\n---\n\nYou are a meticulous code reviewer.\n",
  );
}

beforeEach(() => {
  previousHome = process.env["AM_HOME"];
  // `realpathSync` defeats Windows 8.3 short paths, which would otherwise make
  // junction destination comparisons fail for cosmetic reasons.
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "am-e2e-")));
  process.env["AM_HOME"] = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env["AM_HOME"];
  else process.env["AM_HOME"] = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* The fixed point                                                     */
/* ------------------------------------------------------------------ */

describe("import → apply → plan reaches a fixed point", () => {
  it("imports the environment into the source of truth", () => {
    seedEnvironment();
    const io = bufferIo();

    expect(runImport({ io, move: true })).toBe(0);

    // manifest + normalized MCP + normalized agent all materialized.
    expect(exists(".agents-manager/manifest.json")).toBe(true);
    const servers = JSON.parse(read(".agents-manager/mcp/servers.json")) as {
      servers: Record<string, { transport: string; command?: string; url?: string }>;
    };
    expect(Object.keys(servers.servers).sort()).toEqual(["docs", "filesystem"]);
    expect(servers.servers["filesystem"]?.transport).toBe("stdio");
    expect(servers.servers["docs"]?.transport).toBe("http");

    const agent = read(".agents-manager/agents/code-reviewer.md");
    // The source always stores `tools` as a YAML array (SPEC §3).
    expect(agent).toContain("- Read");
    expect(agent).toContain("- Grep");
    expect(agent).toContain("You are a meticulous code reviewer.");

    // `--move` relocated the physical target skill into the source.
    expect(exists(".agents/skills/extra-skill/SKILL.md")).toBe(true);
    expect(exists(".claude/skills/extra-skill")).toBe(false);
  });

  it("applies the plan and then reports zero difference", () => {
    seedEnvironment();
    const io = bufferIo();

    expect(runImport({ io, move: true })).toBe(0);
    expect(runPlan({ io })).toBe(1); // the source is not distributed yet
    expect(runApply({ io })).toBe(0);

    // The fixed point (SPEC §8).
    const planIo = bufferIo();
    expect(runPlan({ io: planIo })).toBe(0);
    expect(planIo.text()).toContain("No changes");

    // A second apply is a no-op.
    const applyIo = bufferIo();
    expect(runApply({ io: applyIo })).toBe(0);
    expect(applyIo.text()).toContain("Nothing to do");
  });

  it("distributes every asset to the targets that own it", () => {
    seedEnvironment();
    const io = bufferIo();
    runImport({ io, move: true });
    runApply({ io });

    // agents: claude dialect (comma string) vs copilot dialect (YAML array)
    expect(read(".claude/agents/code-reviewer.md")).toContain("tools: Read, Grep");
    expect(read(".copilot/agents/code-reviewer.agent.md")).toContain("- Read");
    expect(read(".github/agents/code-reviewer.agent.md")).toContain("- Grep");

    // MCP dialects (SPEC §4): copilot spells stdio "local"; VS Code uses `servers`.
    const copilot = JSON.parse(read(".copilot/mcp-config.json")) as {
      mcpServers: Record<string, { type: string; tools?: string[] }>;
    };
    expect(copilot.mcpServers["filesystem"]?.type).toBe("local");
    expect(copilot.mcpServers["filesystem"]?.tools).toEqual(["*"]);

    const vscode = JSON.parse(read("AppData/Roaming/Code/User/mcp.json")) as {
      servers: Record<string, { type: string }>;
    };
    expect(vscode.servers["filesystem"]?.type).toBe("stdio");

    // vs2026 has no MCP support in v1 — nothing may be written for it.
    expect(exists(".github/mcp.json")).toBe(false);
  });

  it("preserves every other key of ~/.claude.json (SPEC §6.1)", () => {
    seedEnvironment();
    const io = bufferIo();
    runImport({ io, move: true });
    runApply({ io });

    const document = JSON.parse(read(".claude.json")) as Record<string, unknown>;
    expect(Object.keys(document).sort()).toEqual([
      "mcpServers",
      "numStartups",
      "oauthAccount",
      "projects",
    ]);
    expect(document["numStartups"]).toBe(42);
    expect(document["oauthAccount"]).toEqual({ emailAddress: "user@example.com" });
  });

  it("backs up every file it overwrites", () => {
    seedEnvironment();
    const io = bufferIo();
    runImport({ io, move: true });
    runApply({ io, now: new Date("2026-08-16T12:00:00.000Z") });

    const backup = abs(".agents-manager/backups/2026-08-16T12-00-00.000Z/.claude.json");
    expect(fs.existsSync(backup)).toBe(true);
    const original = JSON.parse(fs.readFileSync(backup, "utf8")) as Record<string, unknown>;
    expect(original["numStartups"]).toBe(42);
  });
});

describe("an empty environment", () => {
  it("plans nothing and creates no config files", () => {
    const io = bufferIo();

    expect(runPlan({ io })).toBe(0);
    expect(io.text()).toContain("No changes");

    expect(runApply({ io: bufferIo() })).toBe(0);
    // Especially `~/.claude.json`: a live file owned by Claude Code (SPEC §6.1)
    // must never be conjured into existence just to hold an empty server map.
    expect(exists(".claude.json")).toBe(false);
    expect(exists(".copilot/mcp-config.json")).toBe(false);
    expect(exists("AppData/Roaming/Code/User/mcp.json")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Junctions on the real file system (SPEC §6.6, §8)                   */
/* ------------------------------------------------------------------ */

describe("skill materialization", () => {
  it("creates real junctions that resolve back to the source", () => {
    seedEnvironment();
    const io = bufferIo();
    runImport({ io, move: true });
    runApply({ io });

    for (const target of [".claude/skills", ".copilot/skills"]) {
      for (const skill of ["demo-skill", "extra-skill"]) {
        const linkPath = abs(`${target}/${skill}`);
        const source = abs(`.agents/skills/${skill}`);
        const info = inspectPath(linkPath);

        expect(info.exists).toBe(true);
        if (process.platform === "win32") {
          expect(info.isLink).toBe(true);
          expect(linkPointsTo(linkPath, source)).toBe(true);
        }
        // Whether linked or copied, the target must see the source's content.
        expect(fs.existsSync(path.join(linkPath, "SKILL.md"))).toBe(true);
      }
    }

    // A junction shows the nested file too — proof it is not a shallow copy.
    expect(fs.existsSync(abs(".claude/skills/demo-skill/reference/notes.md"))).toBe(true);
  });

  it("falls back to a copy when the junction cannot be created (SPEC §6.6)", () => {
    // An occupied path makes `symlinkSync` fail with EEXIST — the cheapest
    // faithful way to provoke the documented fallback on a real file system.
    const source = abs(".agents/skills/demo-skill");
    fs.mkdirSync(path.join(source, "reference"), { recursive: true });
    fs.writeFileSync(path.join(source, "SKILL.md"), SKILL_MD("demo-skill", "A demo skill."));
    fs.writeFileSync(path.join(source, "reference", "notes.md"), "nested\n");

    const occupied = abs("occupied");
    fs.mkdirSync(occupied, { recursive: true });

    const result = createJunction(source, occupied);

    expect(result.mode).toBe("copy");
    expect(result.fellBack).toBe(true);
    expect(result.error).toBeTypeOf("string");
    expect(inspectPath(occupied).isLink).toBe(false);
    expect(fs.existsSync(path.join(occupied, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(occupied, "reference", "notes.md"))).toBe(true);
  });

  it('materializes physical copies when linkMode is "copy"', () => {
    seedEnvironment();
    write(
      ".agents-manager/manifest.json",
      `${JSON.stringify(
        {
          version: 1,
          targets: {
            claude: { enabled: true },
            "copilot-cli": { enabled: false },
            vscode: { enabled: false },
            vs2026: { enabled: false },
          },
          skills: { linkMode: "copy", exclude: [] },
        },
        null,
        2,
      )}\n`,
    );

    const io = bufferIo();
    runImport({ io, move: true });
    expect(runApply({ io })).toBe(0);

    const materialized = abs(".claude/skills/demo-skill");
    expect(inspectPath(materialized).isLink).toBe(false);
    expect(inspectPath(materialized).isDirectory).toBe(true);
    expect(directoriesIdentical(materialized, abs(".agents/skills/demo-skill"))).toBe(true);

    // And it is a fixed point in copy mode as well.
    expect(runPlan({ io: bufferIo() })).toBe(0);
  });

  it("refuses to replace a physical copy that differs from the source (drift)", () => {
    seedEnvironment();
    const io = bufferIo();
    runImport({ io, move: true });

    // A divergent physical copy where the junction should go.
    write(".claude/skills/demo-skill/SKILL.md", SKILL_MD("demo-skill", "Locally edited."));

    const planIo = bufferIo();
    expect(runPlan({ io: planIo })).toBe(1);
    expect(planIo.text()).toContain("drift");

    expect(() => runApply({ io: bufferIo() })).toThrow(/drift/i);
    // Nothing was written: the divergent copy is still exactly as it was.
    expect(read(".claude/skills/demo-skill/SKILL.md")).toContain("Locally edited.");
  });
});

/* ------------------------------------------------------------------ */
/* Deletion policy (SPEC §5)                                           */
/* ------------------------------------------------------------------ */

describe("deletion requires --prune --yes", () => {
  it("never removes target assets the source does not have unless asked", () => {
    seedEnvironment();
    const io = bufferIo();
    runImport({ io, move: true });
    runApply({ io });

    // An agent that exists only in the target, created after the import.
    write(
      ".claude/agents/stray.md",
      "---\nname: stray\ndescription: Not in the source.\n---\n\nStray agent.\n",
    );

    // Without `--prune` the stray file is reported as *preserved*, which is a
    // note and not a difference: `plan` exits 0 because `apply` genuinely has
    // nothing to do. Reporting it as `delete` (and exiting 1) used to make the
    // SPEC §8 fixed point unreachable for as long as the file existed.
    const planIo = bufferIo();
    expect(runPlan({ io: planIo })).toBe(0);
    expect(planIo.text()).toContain("preserve");
    expect(planIo.text()).toContain("--prune");
    expect(planIo.text()).not.toContain("delete");

    // A plain apply leaves it alone.
    expect(runApply({ io: bufferIo() })).toBe(0);
    expect(exists(".claude/agents/stray.md")).toBe(true);

    // `--prune` is what turns the same fact into planned work.
    const pruneIo = bufferIo();
    expect(runPlan({ io: pruneIo, prune: true })).toBe(1);
    expect(pruneIo.text()).toContain("delete");

    // `--prune` alone enumerates but refuses.
    expect(() => runApply({ io: bufferIo(), prune: true })).toThrow(/confirmation/i);
    expect(exists(".claude/agents/stray.md")).toBe(true);

    // `--prune --yes` removes it, after backing it up.
    expect(runApply({ io: bufferIo(), prune: true, yes: true })).toBe(0);
    expect(exists(".claude/agents/stray.md")).toBe(false);
    expect(runPlan({ io: bufferIo() })).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Conflicts (SPEC §5)                                                 */
/* ------------------------------------------------------------------ */

describe("import conflict handling", () => {
  it("fails when two targets disagree, and obeys --prefer", () => {
    seedEnvironment();
    write(
      ".copilot/agents/code-reviewer.agent.md",
      "---\nname: code-reviewer\ndescription: A different reviewer.\ntools:\n  - Read\n---\n\nCopilot's own version.\n",
    );

    expect(() => runImport({ io: bufferIo() })).toThrow(/conflicting definitions/i);

    const io = bufferIo();
    expect(runImport({ io, prefer: "copilot-cli" })).toBe(0);
    expect(read(".agents-manager/agents/code-reviewer.md")).toContain("Copilot's own version.");
  });

  it("rejects an unknown --prefer target", () => {
    seedEnvironment();
    expect(() => runImport({ io: bufferIo(), prefer: "emacs" })).toThrow(/emacs/);
  });
});

/* ------------------------------------------------------------------ */
/* Read-only commands                                                  */
/* ------------------------------------------------------------------ */

describe("inventory and doctor", () => {
  it("inventory reports every target and writes nothing", () => {
    seedEnvironment();
    const io = bufferIo();
    runImport({ io: bufferIo(), move: true });
    runApply({ io: bufferIo() });

    const before = fs.readdirSync(home).sort();
    expect(runInventory({ io })).toBe(0);
    const text = io.text();

    for (const target of ["claude", "copilot-cli", "vscode", "vs2026"]) {
      expect(text).toContain(`=== ${target} ===`);
    }
    expect(text).toContain("demo-skill");
    expect(text).toContain("unsupported"); // vs2026 MCP row (SPEC §4)
    expect(fs.readdirSync(home).sort()).toEqual(before);
  });

  it("doctor is clean on a freshly applied environment", () => {
    seedEnvironment();
    runImport({ io: bufferIo(), move: true });
    runApply({ io: bufferIo() });

    expect(collectDiagnostics()).toEqual([]);
    expect(runDoctor({ io: bufferIo() })).toBe(0);
  });

  it("doctor reports a broken skill and a name mismatch", () => {
    seedEnvironment();
    runImport({ io: bufferIo(), move: true });
    runApply({ io: bufferIo() });

    // Frontmatter name that disagrees with the directory (SPEC §3).
    write(".agents/skills/demo-skill/SKILL.md", SKILL_MD("something-else", "A demo skill."));
    // A skill with no SKILL.md at all.
    fs.mkdirSync(abs(".agents/skills/empty-skill"), { recursive: true });

    const codes = collectDiagnostics().map((d) => d.code);
    expect(codes).toContain("skill.name-mismatch");
    expect(codes).toContain("skill.missing-manifest");
    expect(runDoctor({ io: bufferIo() })).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* CLI surface (SPEC §5 exit codes)                                    */
/* ------------------------------------------------------------------ */

describe("the am CLI", () => {
  it("maps command outcomes to the documented exit codes", () => {
    seedEnvironment();

    expect(main(["node", "am", "import", "--move"], { io: bufferIo() })).toBe(0);
    expect(main(["node", "am", "plan"], { io: bufferIo() })).toBe(1);
    expect(main(["node", "am", "apply"], { io: bufferIo() })).toBe(0);
    expect(main(["node", "am", "plan"], { io: bufferIo() })).toBe(0);
    expect(main(["node", "am", "apply", "--dry-run"], { io: bufferIo() })).toBe(0);
    expect(main(["node", "am", "inventory"], { io: bufferIo() })).toBe(0);
    expect(main(["node", "am", "doctor"], { io: bufferIo() })).toBe(0);
  });

  it("returns 2 for a broken source file (SPEC §6.3)", () => {
    seedEnvironment();
    write(".agents-manager/mcp/servers.json", "{ this is not json ");

    const io = bufferIo();
    expect(main(["node", "am", "plan"], { io })).toBe(2);
    expect(io.errors.join("\n")).toMatch(/parse/i);
  });

  it("returns 2 for an unknown command", () => {
    const io = bufferIo();
    expect(main(["node", "am", "frobnicate"], { io })).toBe(2);
  });

  /**
   * Commander reports a usage error twice over: once through
   * `configureOutput.writeErr`, which `buildProgram` routes into `io.err`, and
   * again as the message on the `CommanderError` it then throws. `main`'s catch
   * used to print that message as well, so every usage error reached stderr in
   * duplicate.
   *
   * Counted rather than matched: the text was never wrong, only doubled, so an
   * assertion that merely finds the line would pass in both worlds.
   */
  it("puts a usage error on stderr exactly once", () => {
    for (const argv of [
      ["frobnicate"],
      ["--frobnicate"],
      ["inventory", "--frobnicate"],
      ["enable"],
      ["plan", "extra-arg"],
    ]) {
      const io = bufferIo();
      expect(main(["node", "am", ...argv], { io }), argv.join(" ")).toBe(2);
      expect(io.errors, argv.join(" ")).toHaveLength(1);
      expect(io.errors[0], argv.join(" ")).toMatch(/^error: /);
    }
  });

  /**
   * The other half of the same branch: `--json` callers get the envelope on
   * stdout, and the human line stays on stderr. Removing the duplicate print
   * must not remove the message the plain caller reads.
   */
  it("still answers a --json caller with an error envelope and one stderr line", () => {
    const io = bufferIo();
    expect(main(["node", "am", "frobnicate", "--json"], { io })).toBe(2);
    expect(io.errors).toHaveLength(1);
    expect(JSON.parse(io.text()) as { error: { message: string } }).toEqual({
      error: { message: "error: unknown command 'frobnicate'" },
    });
  });

  it("keeps --help and --version out of the error path", () => {
    for (const argv of [["--help"], ["--version"], ["inventory", "--help"]]) {
      const io = bufferIo();
      expect(main(["node", "am", ...argv], { io }), argv.join(" ")).toBe(0);
      expect(io.errors, argv.join(" ")).toEqual([]);
    }
  });
});
