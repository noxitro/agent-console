/**
 * SPEC §10 — opencode as a fifth target, and `command` as a fourth asset kind.
 *
 * These are whole-CLI tests: they build a throwaway HOME, run the real command
 * tree, and assert on what actually lands on disk. What they pin:
 *
 *  - **Manifest v1/v2/v3 all load** (§10.5). A build that reads only its own
 *    version turns every existing machine into an exit-2 machine on upgrade.
 *  - **JSONC survives `apply`** (§10.3). The comments in `opencode.jsonc` are
 *    the user's; losing them to a whole-document rewrite is silent data loss,
 *    and the only way to prove they survive is to write the file for real.
 *  - **"unsupported" travels every path** (§10.4). `inventory --json`,
 *    `plan --json` and `apply --json` must each carry the verdict *and* the
 *    reason — an empty list in any one of them reads as "in sync".
 *  - **The http/sse guess is reported** (§10.3), never made in silence.
 *  - **`command` is a first-class kind** for `enable` / `disable` / `remove`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { bufferIo } from "../src/commands/context.js";
import { readManifest } from "../src/core/manifest.js";
import {
  collectDiagnostics,
  matchLegacyCommand,
  readLegacyCommandRules,
} from "../src/commands/doctor.js";
import { readSourceCommands } from "../src/core/source.js";
import type { InventoryJson, PlanJson } from "../src/commands/json.js";
import type { ApplyReport, ImportReport } from "../src/core/report.js";
import type { ExcludeReport, RemoveReport } from "../src/commands/assets.js";
import {
  OPENCODE_COMMAND_KEY_DROPPED_CODE,
  OPENCODE_DISABLED_SERVER_NOTE_CODE,
  OPENCODE_REMOTE_TRANSPORT_NOTE_CODE,
} from "../src/adapters/opencode.js";
import { createClaudeAdapter } from "../src/adapters/claude.js";
import { createCopilotCliAdapter } from "../src/adapters/copilot-cli.js";
import { createVs2026Adapter } from "../src/adapters/vs2026.js";
import { VscodeAdapter } from "../src/adapters/vscode.js";
import { UNSUPPORTED } from "../src/adapters/types.js";

/* ------------------------------------------------------------------ */
/* Fake HOME                                                           */
/* ------------------------------------------------------------------ */

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env["AM_HOME"];
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "am-v3-")));
  process.env["AM_HOME"] = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env["AM_HOME"];
  else process.env["AM_HOME"] = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function write(relative: string, content: string): string {
  const full = path.join(home, ...relative.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

function read(relative: string): string {
  return fs.readFileSync(path.join(home, ...relative.split("/")), "utf8");
}

function exists(relative: string): boolean {
  return fs.existsSync(path.join(home, ...relative.split("/")));
}

/** Run the real CLI and decode a `--json` payload from its single stdout line. */
function cli<T>(...args: string[]): { code: number; payload: T; errors: string[] } {
  const io = bufferIo();
  const code = main(["node", "cli.js", ...args], { io });
  const line = io.lines.at(-1) ?? "";
  return { code, payload: JSON.parse(line) as T, errors: io.errors };
}

/** Run the real CLI in human mode. */
function run(...args: string[]): { code: number; out: string; errors: string } {
  const io = bufferIo();
  const code = main(["node", "cli.js", ...args], { io });
  return { code, out: io.lines.join("\n"), errors: io.errors.join("\n") };
}

const OPENCODE_CONFIG = ".config/opencode/opencode.jsonc";
const OPENCODE_COMMANDS = ".config/opencode/command";

/** A source of truth holding one MCP server and one command. */
function seedSource(manifest?: unknown): void {
  write(
    ".agents-manager/manifest.json",
    `${JSON.stringify(manifest ?? { version: 3 }, null, 2)}\n`,
  );
  write(
    ".agents-manager/mcp/servers.json",
    `${JSON.stringify(
      {
        servers: {
          files: {
            transport: "stdio",
            command: "npx",
            args: ["-y", "server-filesystem", "."],
            targets: ["opencode"],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  write(
    ".agents-manager/commands/run-task.md",
    "---\nname: run-task\ndescription: Run a task\nagent: coordinator\ntargets: [opencode]\n---\n\nRun the task named $ARGUMENTS.\n",
  );
}

/* ------------------------------------------------------------------ */
/* §10.5 — manifest v3                                                 */
/* ------------------------------------------------------------------ */

describe("SPEC §10.5 manifest v3", () => {
  it("accepts a v3 manifest with the commands block and the opencode target", () => {
    seedSource({
      version: 3,
      targets: {
        claude: { enabled: true },
        "copilot-cli": { enabled: true },
        vscode: { enabled: true },
        vs2026: { enabled: true },
        opencode: { enabled: true },
      },
      skills: { linkMode: "junction", exclude: [] },
      mcp: { exclude: [] },
      agents: { exclude: [] },
      commands: { exclude: ["run-task"] },
    });

    const manifest = readManifest();
    expect(manifest.version).toBe(3);
    expect(manifest.commands).toEqual({ exclude: ["run-task"] });
    expect(manifest.targets.opencode.enabled).toBe(true);
    expect(run("inventory").code).toBe(0);
  });

  it("still accepts a v1 manifest and fills every key added since", () => {
    seedSource({ version: 1, targets: { claude: { enabled: true } } });

    const manifest = readManifest();
    // Read as v1 — the file is not rewritten just because it was opened.
    expect(manifest.version).toBe(1);
    expect(manifest.mcp).toEqual({ exclude: [] });
    expect(manifest.agents).toEqual({ exclude: [] });
    expect(manifest.commands).toEqual({ exclude: [] });
    expect(run("inventory").code).toBe(0);
  });

  it("still accepts a v2 manifest and fills in commands.exclude alone", () => {
    seedSource({
      version: 2,
      targets: { claude: { enabled: true } },
      skills: { linkMode: "junction", exclude: [] },
      mcp: { exclude: ["docs"] },
      agents: { exclude: ["reviewer"] },
    });

    const manifest = readManifest();
    expect(manifest.version).toBe(2);
    expect(manifest.mcp).toEqual({ exclude: ["docs"] });
    expect(manifest.agents).toEqual({ exclude: ["reviewer"] });
    expect(manifest.commands).toEqual({ exclude: [] });
    expect(run("inventory").code).toBe(0);
    expect(run("doctor").code).toBe(0);
  });

  it("honours a commands.exclude written into a v2 file rather than dropping it", () => {
    // The v1 regression, one version later: a key the reader ignores means an
    // asset the owner switched off keeps being delivered.
    seedSource({ version: 2, commands: { exclude: ["run-task"] } });
    expect(readManifest().commands.exclude).toEqual(["run-task"]);
  });

  it("writes version 3 with every key once something edits the manifest", () => {
    seedSource({ version: 1, targets: { claude: { enabled: true } } });

    expect(run("disable", "command", "run-task").code).toBe(0);

    const written = JSON.parse(read(".agents-manager/manifest.json")) as Record<string, unknown>;
    expect(written["version"]).toBe(3);
    expect(written["commands"]).toEqual({ exclude: ["run-task"] });
    expect(written["targets"]).toHaveProperty("opencode");
  });
});

/* ------------------------------------------------------------------ */
/* §10.2 — enable / disable / remove for commands                      */
/* ------------------------------------------------------------------ */

describe("SPEC §10.2 command is a first-class asset kind", () => {
  beforeEach(() => {
    seedSource();
  });

  it("disables and re-enables a command through the manifest", () => {
    const off = cli<ExcludeReport>("disable", "command", "run-task", "--json");
    expect(off.code).toBe(0);
    expect(off.payload.changed).toBe(true);
    expect(off.payload.excluded).toEqual(["run-task"]);
    expect(readManifest().commands.exclude).toEqual(["run-task"]);

    const on = cli<ExcludeReport>("enable", "command", "run-task", "--json");
    expect(on.code).toBe(0);
    expect(on.payload.excluded).toEqual([]);
  });

  it("refuses an unknown command name with exit 2 rather than succeeding at nothing", () => {
    expect(run("disable", "command", "no-such-command").code).toBe(2);
    expect(run("remove", "command", "no-such-command", "--yes").code).toBe(2);
  });

  it("lists the victim and writes nothing when `remove` has no --yes", () => {
    const result = run("remove", "command", "run-task");
    expect(result.code).toBe(1);
    expect(exists(".agents-manager/commands/run-task.md")).toBe(true);
  });

  it("removes the command file and backs it up first", () => {
    const result = cli<RemoveReport>("remove", "command", "run-task", "--yes", "--json");
    expect(result.code).toBe(0);
    expect(result.payload.removed).toEqual([
      {
        assetType: "command",
        asset: "run-task",
        path: path.join(home, ".agents-manager", "commands", "run-task.md"),
      },
    ]);
    expect(exists(".agents-manager/commands/run-task.md")).toBe(false);
    const backupDir = result.payload.backupDir;
    expect(backupDir).toBeDefined();
    expect(fs.existsSync(path.join(backupDir as string, ".agents-manager/commands/run-task.md"))).toBe(
      true,
    );
  });

  it("keeps an excluded command out of delivery without deleting the file", () => {
    expect(run("disable", "command", "run-task").code).toBe(0);
    expect(run("apply").code).toBe(0);
    expect(exists(".agents-manager/commands/run-task.md")).toBe(true);
    expect(exists(`${OPENCODE_COMMANDS}/run-task.md`)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* §10.2 / §10.3 — apply against a real opencode install               */
/* ------------------------------------------------------------------ */

describe("SPEC §10.2/§10.3 apply", () => {
  it("delivers the command file with description and agent only", () => {
    seedSource();
    expect(run("apply").code).toBe(0);

    expect(read(`${OPENCODE_COMMANDS}/run-task.md`)).toBe(
      "---\ndescription: Run a task\nagent: coordinator\n---\n\nRun the task named $ARGUMENTS.\n",
    );
  });

  it("keeps the comments in an existing opencode.jsonc through a real write (§10.3)", () => {
    seedSource();
    write(
      OPENCODE_CONFIG,
      `{
  // Written by hand; do not clobber.
  "$schema": "https://opencode.ai/config.json",
  "theme": "tokyonight",
  "mcp": {
    /* a server this tool does not manage */
    "handmade": {
      "type": "remote",
      "url": "https://example.invalid/handmade",
      "enabled": true
    }
  }
}
`,
    );

    expect(run("apply").code).toBe(0);

    const after = read(OPENCODE_CONFIG);
    expect(after).toContain("// Written by hand; do not clobber.");
    expect(after).toContain("/* a server this tool does not manage */");
    expect(after).toContain('"theme": "tokyonight"');
    // The unmanaged server is preserved, and ours was added beside it.
    expect(after).toContain('"handmade"');
    expect(after).toContain('"files"');
    expect(after).toContain('"type": "local"');
  });

  it("reaches the SPEC §8 fixed point: apply → plan reports no difference", () => {
    seedSource();
    expect(run("apply").code).toBe(0);
    expect(run("plan").code).toBe(0);
    // And a second apply writes nothing new.
    expect(run("apply").out).toContain("Nothing to do");
  });

  it("uses the opencode dialect: one command array and `environment`", () => {
    write(
      ".agents-manager/manifest.json",
      `${JSON.stringify({ version: 3 }, null, 2)}\n`,
    );
    write(
      ".agents-manager/mcp/servers.json",
      `${JSON.stringify(
        {
          servers: {
            files: {
              transport: "stdio",
              command: "npx",
              args: ["-y", "fs"],
              env: { TOKEN: "abc" },
              targets: ["opencode"],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    expect(run("apply").code).toBe(0);

    const document = JSON.parse(read(OPENCODE_CONFIG)) as {
      mcp: Record<string, Record<string, unknown>>;
    };
    expect(document.mcp["files"]).toEqual({
      type: "local",
      command: ["npx", "-y", "fs"],
      environment: { TOKEN: "abc" },
      enabled: true,
    });
  });
});

/* ------------------------------------------------------------------ */
/* §10.4 — unsupported propagates through every path                   */
/* ------------------------------------------------------------------ */

describe("SPEC §10.4 unsupported travels with its reason", () => {
  beforeEach(() => {
    seedSource();
  });

  it("marks agents unsupported and skills shared-discovery in inventory --json", () => {
    const result = cli<InventoryJson>("inventory", "--json");
    const opencode = result.payload.targets.find((t) => t.id === "opencode");

    expect(opencode?.agents).toBe("unsupported");
    expect(opencode?.agentsDir).toBe("unsupported");
    // SPEC §10.1, revised: skills are discovered straight from the source of
    // truth — a listing (empty until apply links something), never a sentinel.
    expect(opencode?.skills).toEqual([]);
    expect(opencode?.skillsDir).toBe(path.join(home, ".agents", "skills"));
    // …and the commands the target *does* support are a list, not a sentinel.
    expect(Array.isArray(opencode?.commands)).toBe(true);

    const reasons = opencode?.unsupportedReasons ?? [];
    expect(reasons.map((r) => r.assetType)).toEqual(["agent"]);
    expect(reasons.find((r) => r.assetType === "agent")?.reason).toContain("§10.4");
  });

  it("marks commands unsupported for the other four targets", () => {
    const result = cli<InventoryJson>("inventory", "--json");
    for (const id of ["claude", "copilot-cli", "vscode", "vs2026"] as const) {
      const target = result.payload.targets.find((t) => t.id === id);
      expect(target?.commands).toBe("unsupported");
      expect(target?.commandsDir).toBe("unsupported");
    }
  });

  it("emits unsupported actions in plan --json without making it exit 1", () => {
    expect(run("apply").code).toBe(0);
    const result = cli<PlanJson>("plan", "--json");

    // Notes, not differences: SPEC §5 keeps them out of the exit code.
    expect(result.code).toBe(0);
    const unsupported = result.payload.actions.filter((a) => a.kind === "unsupported");
    expect(unsupported.some((a) => a.target === "opencode" && a.assetType === "agent")).toBe(true);
    // Skills are shared discovery now (SPEC §10.1, revised): no refusal note,
    // and no work either — the owning targets materialize the source root.
    expect(unsupported.some((a) => a.target === "opencode" && a.assetType === "skill")).toBe(false);
    expect(
      result.payload.actions.some((a) => a.target === "opencode" && a.assetType === "skill"),
    ).toBe(false);
    expect(unsupported.some((a) => a.target === "claude" && a.assetType === "command")).toBe(true);
  });

  it("records them as skipped in apply --json rather than dropping them", () => {
    const result = cli<ApplyReport>("apply", "--json");
    expect(result.code).toBe(0);
    const skipped = result.payload.applied.filter((a) => a.kind === "unsupported");
    expect(skipped.every((a) => a.status === "skipped")).toBe(true);
    expect(skipped.some((a) => a.target === "opencode" && a.assetType === "agent")).toBe(true);
    expect(skipped.some((a) => a.assetType === "command" && a.target === "vs2026")).toBe(true);
  });

  it("shows the reason in the human-readable inventory too", () => {
    const result = run("inventory");
    expect(result.out).toContain("agents: unsupported —");
    expect(result.out).toContain("SPEC §10.4");
  });

  it("never writes into opencode's agent directory", () => {
    write(
      ".agents-manager/agents/reviewer.md",
      "---\nname: reviewer\ndescription: Reviews code.\n---\n\nBody.\n",
    );
    expect(run("apply").code).toBe(0);
    expect(exists(".config/opencode/agent")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* §10.3 — import                                                      */
/* ------------------------------------------------------------------ */

describe("SPEC §10.3 import from opencode", () => {
  function seedManifestOnly(): void {
    write(
      ".agents-manager/manifest.json",
      `${JSON.stringify(
        {
          version: 3,
          targets: {
            claude: { enabled: false },
            "copilot-cli": { enabled: false },
            vscode: { enabled: false },
            vs2026: { enabled: false },
            opencode: { enabled: true },
          },
        },
        null,
        2,
      )}\n`,
    );
  }

  it("reports the http/sse ambiguity instead of presenting the guess as a fact", () => {
    seedManifestOnly();
    write(
      OPENCODE_CONFIG,
      `{
  "mcp": {
    "docs": { "type": "remote", "url": "https://example.invalid/mcp", "enabled": true }
  }
}
`,
    );

    const result = cli<ImportReport>("import", "--json");
    expect(result.code).toBe(0);
    expect(result.payload.imported).toContainEqual({
      assetType: "mcp",
      asset: "docs",
      from: "opencode",
    });

    const note = result.payload.notes.find((n) => n.asset === "docs");
    expect(note?.code).toBe(OPENCODE_REMOTE_TRANSPORT_NOTE_CODE);
    expect(note?.from).toBe("opencode");
    expect(note?.detail).toContain("sse");

    // The transport that *was* stored is the documented default.
    const stored = JSON.parse(read(".agents-manager/mcp/servers.json")) as {
      servers: Record<string, { transport: string }>;
    };
    expect(stored.servers["docs"]?.transport).toBe("http");
  });

  it("says nothing about a local server, which converts without loss", () => {
    seedManifestOnly();
    write(
      OPENCODE_CONFIG,
      `{
  "mcp": {
    "files": { "type": "local", "command": ["npx", "-y", "fs"], "enabled": true }
  }
}
`,
    );

    const result = cli<ImportReport>("import", "--json");
    expect(result.payload.notes).toEqual([]);
    const stored = JSON.parse(read(".agents-manager/mcp/servers.json")) as {
      servers: Record<string, unknown>;
    };
    expect(stored.servers["files"]).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "fs"],
    });
  });

  it("lifts command files into the source and notes the keys it could not carry", () => {
    seedManifestOnly();
    write(
      `${OPENCODE_COMMANDS}/run-task.md`,
      "---\ndescription: Run a task\nagent: coordinator\nmodel: anthropic/claude\n---\n\nRun $ARGUMENTS.\n",
    );

    const result = cli<ImportReport>("import", "--json");
    expect(result.code).toBe(0);
    expect(result.payload.imported).toContainEqual({
      assetType: "command",
      asset: "run-task",
      from: "opencode",
    });

    expect(readSourceCommands()).toEqual([
      {
        name: "run-task",
        description: "Run a task",
        agent: "coordinator",
        body: "Run $ARGUMENTS.",
      },
    ]);
    expect(read(".agents-manager/commands/run-task.md")).toContain("name: run-task");

    const note = result.payload.notes.find((n) => n.assetType === "command");
    expect(note?.code).toBe(OPENCODE_COMMAND_KEY_DROPPED_CODE);
    expect(note?.detail).toContain("model");
  });

  it("leaves a description-less command out rather than bricking the source", () => {
    seedManifestOnly();
    write(`${OPENCODE_COMMANDS}/bare.md`, "Just a body, no frontmatter at all.\n");

    const result = cli<ImportReport>("import", "--json");
    expect(result.code).toBe(0);
    expect(result.payload.rejected).toContainEqual({
      assetType: "command",
      asset: "bare",
      from: "opencode",
      reason: 'missing required "description"',
    });
    expect(exists(".agents-manager/commands/bare.md")).toBe(false);
    // The point of the rejection: the source stays readable, so every later
    // command still works (SPEC §6.3). `bare.md` remains in opencode as an
    // unmanaged extra, which `plan` preserves rather than counts as a diff.
    expect(run("plan").code).toBe(0);
    expect(run("doctor").code).toBe(0);
  });

  it("reaches the fixed point from an import of a real opencode install", () => {
    seedManifestOnly();
    write(
      OPENCODE_CONFIG,
      `{
  // keep this
  "mcp": {
    "files": { "type": "local", "command": ["npx", "-y", "fs"], "cwd": "/work", "enabled": true }
  }
}
`,
    );
    write(
      `${OPENCODE_COMMANDS}/run-task.md`,
      "---\ndescription: Run a task\n---\n\nRun $ARGUMENTS.\n",
    );

    expect(run("import").code).toBe(0);
    expect(run("apply").code).toBe(0);
    expect(run("plan").code).toBe(0);

    const after = read(OPENCODE_CONFIG);
    expect(after).toContain("// keep this");
    // SPEC §10.3: the unknown field is still there after a full round trip.
    expect(after).toContain('"cwd"');
  });
});

/* ------------------------------------------------------------------ */
/* §10.3 — the http/sse collapse must not become a conflict            */
/* ------------------------------------------------------------------ */

describe("SPEC §10.3 an unrecoverable transport is a note, never a disagreement", () => {
  function seedTwoTargets(servers: unknown): void {
    write(
      ".agents-manager/manifest.json",
      `${JSON.stringify(
        {
          version: 3,
          targets: {
            claude: { enabled: true },
            "copilot-cli": { enabled: false },
            vscode: { enabled: false },
            vs2026: { enabled: false },
            opencode: { enabled: true },
          },
        },
        null,
        2,
      )}\n`,
    );
    write(".agents-manager/mcp/servers.json", `${JSON.stringify({ servers }, null, 2)}\n`);
  }

  /**
   * The tool's own output used to break its own command. `apply` correctly
   * writes an `sse` server as `"type": "sse"` into claude and `"type":
   * "remote"` into opencode; reading opencode back gives `http`, so `resolve`
   * saw two targets disagreeing and exited 2 — aborting agents, commands and
   * skills with it — on every `am import` from then on, forever.
   */
  it("survives a round trip of an sse server through both claude and opencode", () => {
    seedTwoTargets({ notion: { transport: "sse", url: "https://x.invalid/sse" } });

    expect(run("apply").code).toBe(0);
    expect(read(".claude.json")).toContain('"sse"');
    expect(read(OPENCODE_CONFIG)).toContain('"remote"');

    const result = cli<ImportReport>("import", "--json");
    expect(result.code).toBe(0);
    expect(result.payload.conflicts).toEqual([]);

    // The source keeps the transport it actually knows.
    const stored = JSON.parse(read(".agents-manager/mcp/servers.json")) as {
      servers: Record<string, { transport: string }>;
    };
    expect(stored.servers["notion"]?.transport).toBe("sse");

    // …and the whole cycle is a fixed point, twice over.
    expect(run("plan").code).toBe(0);
    expect(run("import").code).toBe(0);
    expect(run("plan").code).toBe(0);
  });

  /**
   * The other half of the same defect: with opencode as the *only* holder, the
   * fingerprints could never match, so the preserving branch was structurally
   * unreachable and `merged[name] = chosen` replaced the entry wholesale —
   * turning the source's `sse` into `http` and discarding a `targets` selector
   * that no target file records, unreported and with no backup.
   */
  it("keeps the source's transport and targets when only opencode holds the server", () => {
    write(
      ".agents-manager/manifest.json",
      `${JSON.stringify(
        {
          version: 3,
          targets: {
            claude: { enabled: true },
            "copilot-cli": { enabled: false },
            vscode: { enabled: false },
            vs2026: { enabled: false },
            opencode: { enabled: true },
          },
        },
        null,
        2,
      )}\n`,
    );
    write(
      ".agents-manager/mcp/servers.json",
      `${JSON.stringify(
        { servers: { notion: { transport: "sse", url: "https://x.invalid/sse", targets: ["opencode"] } } },
        null,
        2,
      )}\n`,
    );
    write(
      OPENCODE_CONFIG,
      '{ "mcp": { "notion": { "type": "remote", "url": "https://x.invalid/sse", "enabled": true } } }\n',
    );

    const result = cli<ImportReport>("import", "--json");
    expect(result.code).toBe(0);
    expect(result.payload.imported.filter((i) => i.assetType === "mcp")).toEqual([]);

    const stored = JSON.parse(read(".agents-manager/mcp/servers.json")) as {
      servers: Record<string, { transport: string; targets?: string[] }>;
    };
    expect(stored.servers["notion"]?.transport).toBe("sse");
    expect(stored.servers["notion"]?.targets).toEqual(["opencode"]);

    // The scope really was at stake: without the selector, claude gets it too.
    const plan = cli<PlanJson>("plan", "--json");
    expect(plan.payload.actions.some((a) => a.target === "claude" && a.assetType === "mcp" && a.kind !== "unsupported")).toBe(
      false,
    );
  });

  it("still keeps `targets` when the definition genuinely changed", () => {
    write(
      ".agents-manager/manifest.json",
      `${JSON.stringify({ version: 3, targets: { opencode: { enabled: true } } }, null, 2)}\n`,
    );
    write(
      ".agents-manager/mcp/servers.json",
      `${JSON.stringify(
        { servers: { files: { transport: "stdio", command: "npx", args: ["old"], targets: ["opencode"] } } },
        null,
        2,
      )}\n`,
    );
    write(
      OPENCODE_CONFIG,
      '{ "mcp": { "files": { "type": "local", "command": ["npx", "new"], "enabled": true } } }\n',
    );

    expect(run("import").code).toBe(0);
    const stored = JSON.parse(read(".agents-manager/mcp/servers.json")) as {
      servers: Record<string, { args?: string[]; targets?: string[] }>;
    };
    expect(stored.servers["files"]?.args).toEqual(["new"]);
    expect(stored.servers["files"]?.targets).toEqual(["opencode"]);
  });

  it("does not let --prefer opencode downgrade a transport the source already knows", () => {
    // `--prefer` resolves a disagreement *between targets*. There is none here:
    // opencode's `http` is a guess at the very thing the source records. Taking
    // it would rewrite `transport: "sse"` to `"http"` while the URL still ends
    // in `/sse`, and `--prefer` is a global winner for the whole run, so this
    // used to be the only escape from the manufactured conflict above.
    seedTwoTargets({ notion: { transport: "sse", url: "https://x.invalid/sse" } });
    expect(run("apply").code).toBe(0);

    expect(run("import", "--prefer", "opencode").code).toBe(0);
    const stored = JSON.parse(read(".agents-manager/mcp/servers.json")) as {
      servers: Record<string, { transport: string }>;
    };
    expect(stored.servers["notion"]?.transport).toBe("sse");
  });

  it("still reports a genuine cross-target disagreement", () => {
    // The guess tolerance must not swallow a real edit: if opencode's URL
    // differs, the targets really do disagree and SPEC §5 says say so.
    seedTwoTargets({ notion: { transport: "sse", url: "https://x.invalid/sse" } });
    expect(run("apply").code).toBe(0);
    write(
      OPENCODE_CONFIG,
      '{ "mcp": { "notion": { "type": "remote", "url": "https://elsewhere.invalid/mcp", "enabled": true } } }\n',
    );

    const conflicted = run("import");
    expect(conflicted.code).toBe(2);
    expect(conflicted.errors).toContain("conflicting definitions");
  });

  it("reports a server opencode has switched off rather than importing it in silence", () => {
    write(
      ".agents-manager/manifest.json",
      `${JSON.stringify(
        { version: 3, targets: { claude: { enabled: true }, opencode: { enabled: true } } },
        null,
        2,
      )}\n`,
    );
    write(
      OPENCODE_CONFIG,
      '{ "mcp": { "risky": { "type": "local", "command": ["node", "x.js"], "enabled": false } } }\n',
    );

    const result = cli<ImportReport>("import", "--json");
    expect(result.code).toBe(0);
    const note = result.payload.notes.find((n) => n.asset === "risky");
    expect(note?.code).toBe(OPENCODE_DISABLED_SERVER_NOTE_CODE);
    expect(note?.from).toBe("opencode");
  });
});

/* ------------------------------------------------------------------ */
/* §6.3 — import validates names before it writes anything             */
/* ------------------------------------------------------------------ */

describe("SPEC §6.3 import refuses an unusable name without a partial write", () => {
  function seedOpencodeOnly(): void {
    write(
      ".agents-manager/manifest.json",
      `${JSON.stringify(
        {
          version: 3,
          targets: {
            claude: { enabled: false },
            "copilot-cli": { enabled: false },
            vscode: { enabled: false },
            vs2026: { enabled: false },
            opencode: { enabled: true },
          },
        },
        null,
        2,
      )}\n`,
    );
  }

  /**
   * opencode imposes no naming rule, so `my_thing.md` is an ordinary file
   * there. It used to reach `writeSourceCommand` → `assertValidCommandName` and
   * throw — after `mcp/servers.json` had been written, and (with `--move`)
   * after skill directories had already been relocated. The initial-migration
   * command ended at exit 2 with a half-populated source, taking every validly
   * named sibling sorted after it down with it.
   */
  it("skips an oddly named command and imports its siblings", () => {
    seedOpencodeOnly();
    write(`${OPENCODE_COMMANDS}/deploy.md`, "---\ndescription: Ship it\n---\n\nBody.\n");
    write(`${OPENCODE_COMMANDS}/my_thing.md`, "---\ndescription: Do a thing\n---\n\nBody.\n");
    write(`${OPENCODE_COMMANDS}/zebra.md`, "---\ndescription: Last one\n---\n\nBody.\n");

    const result = cli<ImportReport>("import", "--json");
    expect(result.code).toBe(0);
    expect(result.payload.rejected).toContainEqual({
      assetType: "command",
      asset: "my_thing",
      from: "opencode",
      reason: "name is not lowercase alphanumerics and hyphens (≤64 chars)",
    });

    // Everything valid survived, including the name sorted after the bad one.
    expect(exists(".agents-manager/commands/deploy.md")).toBe(true);
    expect(exists(".agents-manager/commands/zebra.md")).toBe(true);
    expect(exists(".agents-manager/commands/my_thing.md")).toBe(false);
    // And the source is still readable, so every later command works — the
    // import even reaches SPEC §8's fixed point, with the refused file left in
    // opencode as an unmanaged extra that `plan` preserves rather than counts.
    expect(run("plan").code).toBe(0);
    expect(run("doctor").code).toBe(1);
    expect(readSourceCommands().map((c) => c.name)).toEqual(["deploy", "zebra"]);
  });

  it("does not abandon a --move that already relocated a skill directory", () => {
    seedOpencodeOnly();
    write(".claude/skills/my-skill/SKILL.md", "---\nname: my-skill\ndescription: d\n---\n\nb\n");
    write(`${OPENCODE_COMMANDS}/Deploy.md`, "---\ndescription: Ship it\n---\n\nBody.\n");

    // The move is committed before the write phase, so an abort there left the
    // machine changed and the source empty. Now the run completes.
    expect(run("import", "--move").code).toBe(0);
    expect(exists(".agents-manager/mcp/servers.json")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* §10.3 — a repeated key makes the read and write paths disagree      */
/* ------------------------------------------------------------------ */

describe("SPEC §6.3 a duplicated `mcp` key is a hard stop, not a silent wrong write", () => {
  it("never reports 'in sync' about an edit that landed where nothing reads it", () => {
    seedSource();
    write(
      OPENCODE_CONFIG,
      `{
  "mcp": { "other": { "type": "local", "command": ["o"], "enabled": true } },
  "theme": "dark",
  "mcp": { "files": { "type": "local", "command": ["npx", "-y", "OLD"], "enabled": true } }
}
`,
    );

    const before = read(OPENCODE_CONFIG);

    // `plan` stops rather than promising a write it cannot land (SPEC §6.3).
    const planned = run("plan");
    expect(planned.code).toBe(2);
    expect(planned.errors).toContain("more than once");

    // `apply` writes nothing at all…
    expect(run("apply").code).toBe(2);
    expect(read(OPENCODE_CONFIG)).toBe(before);

    // …and the next `plan` does not turn round and call the machine in sync.
    expect(run("plan").code).toBe(2);

    // doctor names the file rather than answering "No problems found".
    const finding = collectDiagnostics().find(
      (f) => f.code === "mcp.unreadable" && f.target === "opencode",
    );
    expect(finding?.message).toContain("more than once");
  });

  it("clears once the blocks are merged", () => {
    seedSource();
    write(
      OPENCODE_CONFIG,
      `{
  "mcp": {
    "other": { "type": "local", "command": ["o"], "enabled": true },
    "files": { "type": "local", "command": ["npx", "-y", "OLD"], "enabled": true }
  }
}
`,
    );
    expect(run("apply").code).toBe(0);
    expect(run("plan").code).toBe(0);
    const document = JSON.parse(read(OPENCODE_CONFIG)) as {
      mcp: Record<string, { command: string[] }>;
    };
    expect(document.mcp["files"]?.command).toEqual(["npx", "-y", "server-filesystem", "."]);
  });
});

/* ------------------------------------------------------------------ */
/* §8 — a config with no trailing newline is not a permanent diff      */
/* ------------------------------------------------------------------ */

describe("SPEC §8 the fixed point does not depend on the user's final byte", () => {
  it("reports no change for an in-sync config whose last byte is `}`", () => {
    seedSource();
    expect(run("apply").code).toBe(0);
    expect(run("plan").code).toBe(0);

    const stripped = read(OPENCODE_CONFIG).replace(/\n$/, "");
    write(OPENCODE_CONFIG, stripped);

    expect(run("plan").code).toBe(0);
    expect(run("apply").out).toContain("Nothing to do");
    // The file was genuinely left alone, not rewritten to reach the fixed point.
    expect(read(OPENCODE_CONFIG)).toBe(stripped);
  });
});

/* ------------------------------------------------------------------ */
/* §10.2 — the other four adapters refuse commands outright            */
/* ------------------------------------------------------------------ */

describe("SPEC §10.2 commands are opencode-only", () => {
  it("has every pre-v3 adapter answer unsupported in both directions", () => {
    const adapters = [
      createClaudeAdapter(),
      createCopilotCliAdapter(),
      new VscodeAdapter(),
      createVs2026Adapter(),
    ];
    for (const adapter of adapters) {
      expect(adapter.readCommands()).toBe(UNSUPPORTED);
      expect(adapter.renderCommands([])).toBe(UNSUPPORTED);
      expect(adapter.paths().commandsDir).toBe(UNSUPPORTED);
      // A refusal is not an empty plan: passing a real command changes nothing.
      expect(
        adapter.renderCommands([{ name: "run-task", description: "x", body: "y" }]),
      ).toBe(UNSUPPORTED);
    }
  });
});

/* ------------------------------------------------------------------ */
/* §10.2 — doctor sees the command directory                           */
/* ------------------------------------------------------------------ */

describe("SPEC §10.2 doctor covers source commands", () => {
  it("reports a malformed command file instead of finding no problems", () => {
    // `readSourceCommands` is strict, so this file makes `plan` and `inventory`
    // exit 2. A `doctor` that read no commands would answer "No problems found"
    // about the very state the user came to have explained.
    seedSource();
    write(
      ".agents-manager/commands/broken.md",
      ["---", "description: [unclosed", "---", "", "Body.", ""].join("\n"),
    );

    const findings = collectDiagnostics();
    expect(findings.map((f) => f.code)).toContain("command.unreadable");
    expect(run("doctor").code).toBe(1);
  });

  it("reports a command whose frontmatter has no description", () => {
    seedSource();
    write(
      ".agents-manager/commands/nodesc.md",
      ["---", "name: nodesc", "---", "", "Body.", ""].join("\n"),
    );

    // Strict parsing makes this the `unreadable` finding rather than a
    // per-field one — either way it is reported, never silently skipped.
    const findings = collectDiagnostics();
    expect(findings.some((f) => f.code.startsWith("command."))).toBe(true);
  });

  it("flags a command name that is not lowercase-hyphen", () => {
    seedSource();
    write(
      ".agents-manager/commands/Bad_Name.md",
      ["---", "name: Bad_Name", "description: Something", "---", "", "Body.", ""].join("\n"),
    );

    const findings = collectDiagnostics();
    expect(findings.map((f) => f.code)).toContain("command.invalid-name");
    // The name is also the file name, so an invalid one is a real hazard, not
    // a style note (SPEC §10.2).
    expect(findings.find((f) => f.code === "command.invalid-name")?.asset).toBe("Bad_Name");
  });

  it("finds nothing to say about a well-formed command", () => {
    seedSource();
    expect(collectDiagnostics().filter((f) => f.code.startsWith("command."))).toEqual([]);
  });
});

/**
 * ARCHITECTURE.md「am から引き継いだもの」: stale copies in the source are named
 * by the owner in `~/.agent-console/legacy-commands.json`, not by this code.
 */
describe("legacy commands named by ~/.agent-console/legacy-commands.json", () => {
  const RULES = ".agent-console/legacy-commands.json";

  function writeCommandSource(name: string): void {
    write(
      `.agents-manager/commands/${name}.md`,
      ["---", `name: ${name}`, "description: Something", "---", "", "Body.", ""].join("\n"),
    );
  }

  it("finds nothing when the rule file does not exist", () => {
    seedSource();
    writeCommandSource("old-report");
    expect(exists(RULES)).toBe(false);
    const codes = collectDiagnostics().map((f) => f.code);
    expect(codes.filter((c) => c === "command.legacy")).toEqual([]);
    expect(codes.filter((c) => c.startsWith("console."))).toEqual([]);
  });

  it("warns about each source command a rule matches, naming the file, the rule and the note", () => {
    seedSource();
    writeCommandSource("old-report");
    writeCommandSource("legacy-tool");
    writeCommandSource("current-tool");
    write(
      RULES,
      `${JSON.stringify({
        version: 1,
        commands: [
          { match: "old-*", note: "the maintained copy lives elsewhere" },
          { match: "legacy-tool" },
        ],
      })}\n`,
    );

    const legacy = collectDiagnostics().filter((f) => f.code === "command.legacy");
    expect(legacy.map((f) => f.asset).sort()).toEqual(["legacy-tool", "old-report"]);
    expect(legacy.every((f) => f.level === "warn")).toBe(true);

    const old = legacy.find((f) => f.asset === "old-report");
    expect(old?.path).toBe(path.join(home, ".agents-manager", "commands", "old-report.md"));
    expect(old?.message).toContain('"old-*"');
    expect(old?.message).toContain("the maintained copy lives elsewhere");
    expect(old?.message).toContain("`apply` would distribute this copy");
    // Nothing else is wrong with the source; the warnings alone make doctor exit 1.
    expect(collectDiagnostics().filter((f) => f.code !== "command.legacy")).toEqual([]);
    expect(run("doctor").code).toBe(1);
  });

  it("reports an unparseable rule file as an error instead of running with no rules", () => {
    seedSource();
    writeCommandSource("old-report");
    write(RULES, "{ not json\n");

    const findings = collectDiagnostics();
    const finding = findings.find((f) => f.code === "console.legacy-commands-unreadable");
    expect(finding?.level).toBe("error");
    expect(finding?.path).toBe(path.join(home, ...RULES.split("/")));
    expect(findings.filter((f) => f.code === "command.legacy")).toEqual([]);
    expect(run("doctor").code).toBe(1);
  });

  it("reports a rule file of the wrong shape the same way", () => {
    seedSource();
    for (const doc of [
      { version: 2, commands: [] },
      { version: 1, commands: {} },
      { version: 1, commands: [{ note: "no match" }] },
      { version: 1, commands: [{ match: "*" }] },
      { version: 1, commands: [{ match: "a*b" }] },
      { version: 1, commands: [{ match: "old-*", note: 3 }] },
      [],
    ]) {
      write(RULES, `${JSON.stringify(doc)}\n`);
      const codes = collectDiagnostics().map((f) => f.code);
      expect(codes, JSON.stringify(doc)).toContain("console.legacy-commands-unreadable");
    }
  });

  it("is a pure name rule (positive and negative controls)", () => {
    const rules = [{ match: "old-*" }, { match: "legacy-tool", note: "n" }];
    expect(matchLegacyCommand("old-report", rules)).toEqual({ match: "old-*" });
    expect(matchLegacyCommand("old-", rules)).toEqual({ match: "old-*" });
    expect(matchLegacyCommand("legacy-tool", rules)).toEqual({ match: "legacy-tool", note: "n" });
    expect(matchLegacyCommand("legacy-tool-2", rules)).toBeUndefined();
    expect(matchLegacyCommand("my-old-report", rules)).toBeUndefined();
    expect(matchLegacyCommand("older", rules)).toBeUndefined();
    expect(matchLegacyCommand("old-report", [])).toBeUndefined();
  });

  it("reads the rule file it is given, and tells absent from present", () => {
    const file = path.join(home, "rules.json");
    expect(readLegacyCommandRules(file)).toEqual({ status: "absent" });
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, commands: [{ match: "old-*" }] })}\n`);
    expect(readLegacyCommandRules(file)).toEqual({ status: "ok", rules: [{ match: "old-*" }] });
  });
});

/* ------------------------------------------------------------------ */
/* §6.3 — doctor opens every file whose parse failure stops the tool   */
/* ------------------------------------------------------------------ */

describe("SPEC §6.3 doctor covers the target-side files too", () => {
  /**
   * `readCommands` parses YAML, so one hand-edited opencode command file with a
   * broken block is a file `plan` will never mention (`planCommands` only diffs
   * bytes). `doctor` used to say "No problems found" about it: the file was
   * visible from nowhere. It is `doctor`'s to report, and the verdict is an
   * **error** — see the leniency test below for the other half of the split.
   */
  it("reports a malformed opencode command file as an error", () => {
    seedSource();
    write(
      `${OPENCODE_COMMANDS}/bad.md`,
      ["---", "description: [unclosed", "---", "", "Body.", ""].join("\n"),
    );

    const findings = collectDiagnostics();
    const finding = findings.find((f) => f.code === "command.unreadable" && f.target === "opencode");
    expect(finding).toBeDefined();
    expect(finding?.level).toBe("error");
    expect(finding?.path).toBe(path.join(home, ...`${OPENCODE_COMMANDS}/bad.md`.split("/")));
    expect(run("doctor").code).toBe(1);
  });

  /**
   * The same hole, one asset kind over: `collectDiagnostics` never called
   * `readMcp` at all, so an unparseable `opencode.jsonc` — the one state in
   * which `inventory`, `plan` and `apply` all exit 2 — produced zero findings.
   */
  it("reports an unparseable opencode.jsonc instead of finding no problems", () => {
    seedSource();
    write(OPENCODE_CONFIG, '{ "mcp": { "a": { "type": "local" "command": ["x"] } } }\n');

    expect(run("plan").code).toBe(2);

    const finding = collectDiagnostics().find(
      (f) => f.code === "mcp.unreadable" && f.target === "opencode",
    );
    expect(finding).toBeDefined();
    expect(finding?.level).toBe("error");
    expect(finding?.path).toBe(path.join(home, ...OPENCODE_CONFIG.split("/")));
    expect(run("doctor").code).toBe(1);
  });

  it("reports an unparseable source servers.json for the same reason", () => {
    seedSource();
    write(".agents-manager/mcp/servers.json", "{ not json\n");

    expect(run("plan").code).toBe(2);
    const findings = collectDiagnostics();
    expect(findings.map((f) => f.code)).toContain("mcp.unreadable");
    // A *source* finding names no target.
    expect(findings.find((f) => f.code === "mcp.unreadable")?.target).toBeUndefined();
  });

  /**
   * opencode imposes no naming rule on `command/<name>.md`, so this is a warning
   * about what `import` will refuse — not an error about the target, which is
   * working exactly as opencode intends.
   */
  it("warns about a target command file `import` could never lift into the source", () => {
    seedSource();
    write(`${OPENCODE_COMMANDS}/my_thing.md`, "---\ndescription: Does a thing\n---\n\nBody.\n");

    const finding = collectDiagnostics().find(
      (f) => f.code === "command.invalid-name" && f.target === "opencode",
    );
    expect(finding?.level).toBe("warn");
    expect(finding?.asset).toBe("my_thing");
  });
});

/* ------------------------------------------------------------------ */
/* §10.2 — the display path keeps a broken command file as a row       */
/* ------------------------------------------------------------------ */

/**
 * The defect: when one file in `~/.config/opencode/command/` has a frontmatter
 * block that does not parse, `am inventory` used to answer exit 2 with
 * **nothing printed** — no targets, no skills, no servers. The console's whole
 * survey is that one payload, so the window opened onto a fault plate over a
 * single command file.
 *
 * The split this pins is the one `readSkillMeta` already uses for a malformed
 * `SKILL.md` (SPEC §10.2, and `src/core/source.ts`): the *display* path keeps
 * the row and drops the fields it could not read, while every path that leads to
 * a write stays strict (SPEC §6.3).
 */
describe("SPEC §10.2 one unreadable command file does not take inventory down", () => {
  const BROKEN = ["---", "description: [unclosed", "---", "", "Body.", ""].join("\n");

  /**
   * `run-task` is in the source too, so this is the case that matters most: the
   * file the target actually reads is broken, and the tool has a good version of it.
   * `spec-check` is target-only and well-formed — it proves the good rows
   * survive beside the broken one instead of the listing being emptied.
   */
  function seedBrokenCommandFile(): void {
    seedSource();
    write(`${OPENCODE_COMMANDS}/run-task.md`, BROKEN);
    write(`${OPENCODE_COMMANDS}/spec-check.md`, "---\ndescription: Check it\n---\n\nBody.\n");
  }

  it("scans to the end: exit 0, every target still reported", () => {
    seedBrokenCommandFile();

    const result = run("inventory");
    expect(result.code).toBe(0);
    for (const target of ["claude", "copilot-cli", "vscode", "vs2026", "opencode"]) {
      expect(result.out).toContain(`=== ${target}`);
    }
    // The broken file is named, and named as unreadable rather than as a
    // command with an empty description.
    expect(result.out).toContain("run-task");
    expect(result.out).toContain("UNREADABLE");
  });

  it("keeps the broken file as a row: file-name stem, no invented fields", () => {
    seedBrokenCommandFile();

    const result = cli<InventoryJson>("inventory", "--json");
    expect(result.code).toBe(0);
    const opencode = result.payload.targets.find((t) => t.id === "opencode");
    expect(result.payload.targets).toHaveLength(5);

    const commands = opencode?.commands;
    expect(Array.isArray(commands)).toBe(true);
    const broken = (commands as { name: string; unreadable?: string }[]).find(
      (c) => c.name === "run-task",
    );
    expect(broken?.unreadable).toContain("YAML");
    // The message carries the file it is about.
    expect(broken?.unreadable).toContain("run-task.md");
    // Absent is absent: no fabricated description, no fabricated agent.
    expect(broken).not.toHaveProperty("description");
    expect(broken).not.toHaveProperty("agent");

    // …and the well-formed neighbour is untouched.
    expect(commands).toContainEqual({ name: "spec-check", description: "Check it" });
  });

  it("still surveys the source and the other asset kinds", () => {
    seedBrokenCommandFile();

    const result = cli<InventoryJson>("inventory", "--json");
    expect(result.payload.source.commands.map((c) => c.name)).toEqual(["run-task"]);
    expect(result.payload.source.mcp.map((m) => m.name)).toEqual(["files"]);
  });

  it("leaves doctor's error where it was — inventory reports, doctor judges", () => {
    seedBrokenCommandFile();

    const finding = collectDiagnostics().find(
      (f) => f.code === "command.unreadable" && f.target === "opencode",
    );
    expect(finding?.level).toBe("error");
    expect(run("doctor").code).toBe(1);
  });

  it("keeps `plan` strict: the broken target file is a difference, not a shrug", () => {
    seedBrokenCommandFile();

    const result = cli<PlanJson>("plan", "--json");
    // Exit 1 = a real difference exists (SPEC §5). `plan` diffs bytes, so the
    // unreadable file is simply not what the source renders.
    expect(result.code).toBe(1);
    const action = result.payload.actions.find(
      (a) => a.assetType === "command" && a.asset === "run-task" && a.target === "opencode",
    );
    expect(action?.kind).toBe("update");
  });

  it("keeps `import` strict: an unparseable file is never lifted into the source", () => {
    seedBrokenCommandFile();

    // SPEC §6.3 — the read that feeds a write refuses the file outright.
    expect(run("import").code).toBe(2);
    expect(readSourceCommands().map((c) => c.description)).toEqual(["Run a task"]);
  });

  it("keeps a malformed *source* command file strict, in every command", () => {
    seedSource();
    write(".agents-manager/commands/broken.md", BROKEN);

    // The source is this tool's own schema (SPEC §10.2); leniency there would
    // let `apply` distribute a definition nobody could read.
    expect(run("plan").code).toBe(2);
    expect(run("apply", "--dry-run").code).toBe(2);
  });
});
