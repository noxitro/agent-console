/**
 * opencode adapter tests (SPEC §10).
 *
 * Three things here are not shared with any other adapter and carry most of the
 * risk:
 *
 *  1. **JSONC survives a write.** `opencode.jsonc` is hand-edited and carries
 *     comments; SPEC §10.3 calls dropping them silent data loss. The comment
 *     assertions below are the whole reason this adapter uses `jsonc-parser`
 *     instead of `JSON.stringify`.
 *  2. **Unknown fields come back.** `cwd` / `timeout` / `oauth` are opencode's,
 *     not ours, and must reappear byte-for-byte after a rewrite.
 *  3. **"unsupported" is a real answer.** Agents and skills are refused *with a
 *     reason* (SPEC §10.4), which is what keeps `plan` from claiming a target
 *     is in sync with files it never looked at.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AmError, type CommandDef, type McpServer } from "../core/model.js";
import {
  opencodeCommandPath,
  opencodeCommandsDir,
  opencodeConfigPath,
  sourceSkillsDir,
} from "../core/paths.js";
import { isUnsupported, UNSUPPORTED, type Adapter } from "./types.js";
import { createClaudeAdapter } from "./claude.js";
import { vscodeAdapter } from "./vscode.js";
import {
  createOpencodeAdapter,
  fromOpencodeServer,
  OPENCODE_AGENTS_UNSUPPORTED_DETAIL,
  OPENCODE_COMMAND_KEY_DROPPED_CODE,
  OPENCODE_DISABLED_SERVER_NOTE_CODE,
  OPENCODE_REMOTE_TRANSPORT_NOTE_CODE,
  parseOpencodeConfig,
  toOpencodeServer,
} from "./opencode.js";

const adapter = createOpencodeAdapter();
/** Compile-time proof that the concrete adapter still satisfies SPEC §7. */
const asAdapter: Adapter = adapter;

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env["AM_HOME"];
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "am-opencode-")));
  process.env["AM_HOME"] = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["AM_HOME"];
  else process.env["AM_HOME"] = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function writeConfig(text: string): void {
  const file = opencodeConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function writeCommand(name: string, text: string): void {
  const file = opencodeCommandPath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

/** Write a rendered plan to disk, the way `commands/apply.ts` would. */
function applyEdits(edits: readonly { path: string; content: string }[]): void {
  for (const edit of edits) {
    fs.mkdirSync(path.dirname(edit.path), { recursive: true });
    fs.writeFileSync(edit.path, edit.content, "utf8");
  }
}

function renderOnly(servers: Record<string, McpServer>): string {
  const edits = adapter.renderMcp(servers);
  const first = edits[0];
  if (first === undefined) throw new Error("expected one edit");
  return first.content;
}

const STDIO: McpServer = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "server-filesystem", "."],
  env: { TOKEN: "abc" },
};

const HTTP: McpServer = {
  transport: "http",
  url: "https://example.invalid/mcp",
  headers: { Authorization: "Bearer x" },
};

/* ------------------------------------------------------------------ */
/* Identity and paths (SPEC §10.1)                                     */
/* ------------------------------------------------------------------ */

describe("identity and paths (SPEC §10.1)", () => {
  it("resolves every path under ~/.config/opencode", () => {
    expect(adapter.id).toBe("opencode");
    expect(asAdapter.id).toBe("opencode");
    expect(adapter.paths()).toEqual({
      mcp: path.join(home, ".config", "opencode", "opencode.jsonc"),
      // SPEC §10.4 — agentsDir refused, not merely empty.
      agentsDir: UNSUPPORTED,
      skillsDir: path.join(home, ".agents", "skills"),
      commandsDir: path.join(home, ".config", "opencode", "command"),
    });
  });

  it("honours XDG_CONFIG_HOME when no AM_HOME override is in play", () => {
    const previousXdg = process.env["XDG_CONFIG_HOME"];
    const previousAm = process.env["AM_HOME"];
    const xdg = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "am-xdg-")));
    try {
      delete process.env["AM_HOME"];
      process.env["XDG_CONFIG_HOME"] = xdg;
      expect(opencodeConfigPath()).toBe(path.join(xdg, "opencode", "opencode.jsonc"));
    } finally {
      if (previousXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = previousXdg;
      if (previousAm !== undefined) process.env["AM_HOME"] = previousAm;
      fs.rmSync(xdg, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* MCP dialect (SPEC §10.3)                                            */
/* ------------------------------------------------------------------ */

describe("MCP dialect conversion (SPEC §10.3)", () => {
  it("renders stdio as type local with one unified command array and `environment`", () => {
    expect(toOpencodeServer(STDIO)).toEqual({
      type: "local",
      command: ["npx", "-y", "server-filesystem", "."],
      environment: { TOKEN: "abc" },
      enabled: true,
    });
    // The two traps the table calls out, stated as assertions.
    expect(toOpencodeServer(STDIO)).not.toHaveProperty("args");
    expect(toOpencodeServer(STDIO)).not.toHaveProperty("env");
  });

  it("renders http and sse alike as type remote", () => {
    const sse: McpServer = { transport: "sse", url: "https://example.invalid/sse" };
    expect(toOpencodeServer(HTTP)["type"]).toBe("remote");
    expect(toOpencodeServer(sse)["type"]).toBe("remote");
  });

  it("round-trips a stdio server: normalized → render → parse → identical", () => {
    const back = fromOpencodeServer("fs", toOpencodeServer(STDIO), "test.jsonc");
    expect(back).toEqual(STDIO);
  });

  it("round-trips an http server", () => {
    const back = fromOpencodeServer("docs", toOpencodeServer(HTTP), "test.jsonc");
    expect(back).toEqual(HTTP);
  });

  it("reads an sse server back as http, because opencode cannot tell them apart", () => {
    const sse: McpServer = { transport: "sse", url: "https://example.invalid/sse" };
    const back = fromOpencodeServer("legacy", toOpencodeServer(sse), "test.jsonc");
    // SPEC §10.3: the information is genuinely gone. `import` reports it.
    expect(back.transport).toBe("http");
    expect(back.url).toBe(sse.url);
  });

  it("refuses an unknown type rather than guessing a transport", () => {
    expect(() => fromOpencodeServer("x", { type: "stdio" }, "test.jsonc")).toThrow(AmError);
  });

  it("refuses a local entry with no command", () => {
    expect(() => fromOpencodeServer("x", { type: "local" }, "test.jsonc")).toThrow(/command/);
  });

  it("refuses a remote entry with no url", () => {
    expect(() => fromOpencodeServer("x", { type: "remote" }, "test.jsonc")).toThrow(/url/);
  });
});

/* ------------------------------------------------------------------ */
/* MCP read / write (SPEC §10.3, §6.3, §6.4)                           */
/* ------------------------------------------------------------------ */

describe("readMcp", () => {
  it("returns {} when opencode has never been configured", () => {
    expect(adapter.readMcp()).toEqual({});
    expect(adapter.readRawMcp()).toEqual({});
  });

  it("reads the mcp key of a commented, trailing-comma JSONC document", () => {
    writeConfig(`{
  // opencode's own schema pointer
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "fs": {
      "type": "local",
      "command": ["npx", "-y", "server-filesystem", "."],
      "environment": { "TOKEN": "abc" },
      "enabled": true,
    },
  },
}
`);
    expect(adapter.readMcp()).toEqual({
      fs: { transport: "stdio", command: "npx", args: ["-y", "server-filesystem", "."], env: { TOKEN: "abc" } },
    });
  });

  it("throws on a malformed document instead of reporting no servers (SPEC §6.3)", () => {
    writeConfig('{ "mcp": { "fs": }\n');
    expect(() => adapter.readMcp()).toThrow(AmError);
  });

  it("throws when mcp is not an object", () => {
    writeConfig('{ "mcp": [] }\n');
    expect(() => adapter.readMcp()).toThrow(/is not an object/);
  });
});

describe("renderMcp preserves the JSONC document (SPEC §10.3)", () => {
  it("keeps comments, other keys and formatting when adding a server", () => {
    writeConfig(`{
  // The schema line opencode writes for itself.
  "$schema": "https://opencode.ai/config.json",
  /* Block comment about the theme. */
  "theme": "tokyonight"
}
`);

    const content = renderOnly({ fs: STDIO });

    // The whole point of the surgical edit: prose the user wrote survives.
    expect(content).toContain("// The schema line opencode writes for itself.");
    expect(content).toContain("/* Block comment about the theme. */");
    expect(content).toContain('"theme": "tokyonight"');
    expect(content).toContain('"$schema": "https://opencode.ai/config.json"');
    // And the server really did land.
    applyEdits([{ path: opencodeConfigPath(), content }]);
    expect(adapter.readMcp()).toEqual({ fs: STDIO });
  });

  it("keeps a comment attached to a server it is not changing", () => {
    writeConfig(`{
  "mcp": {
    // keep me: this server is hand-managed
    "legacy": {
      "type": "remote",
      "url": "https://example.invalid/legacy",
      "enabled": true
    }
  }
}
`);

    const content = adapter.renderMcp({ fs: STDIO }, {
      preserve: { legacy: { type: "remote", url: "https://example.invalid/legacy", enabled: true } },
    })[0]?.content;

    expect(content).toContain("// keep me: this server is hand-managed");
    expect(content).toContain('"fs"');
  });

  it("restores unknown per-server fields on the way back out (SPEC §10.3)", () => {
    writeConfig(`{
  "mcp": {
    "fs": {
      "type": "local",
      "command": ["npx", "-y", "server-filesystem", "."],
      "cwd": "/work",
      "timeout": 30000,
      "oauth": { "clientId": "abc" },
      "enabled": true
    }
  }
}
`);

    const content = renderOnly({ fs: STDIO });
    applyEdits([{ path: opencodeConfigPath(), content }]);
    const entry = adapter.readRawMcp()["fs"] as Record<string, unknown>;

    // Not dropped, not degraded — the same values, still there.
    expect(entry["cwd"]).toBe("/work");
    expect(entry["timeout"]).toBe(30000);
    expect(entry["oauth"]).toEqual({ clientId: "abc" });
  });

  it("does not flip an `enabled: false` the owner set inside opencode", () => {
    writeConfig(`{
  "mcp": {
    "fs": {
      "type": "local",
      "command": ["npx"],
      "enabled": false
    }
  }
}
`);
    const content = renderOnly({ fs: { transport: "stdio", command: "npx" } });
    applyEdits([{ path: opencodeConfigPath(), content }]);
    expect((adapter.readRawMcp()["fs"] as Record<string, unknown>)["enabled"]).toBe(false);
  });

  it("creates a valid document when opencode.jsonc does not exist yet", () => {
    const content = renderOnly({ docs: HTTP });
    expect(parseOpencodeConfig(content, "x")).toEqual({
      mcp: { docs: { type: "remote", url: HTTP.url, headers: HTTP.headers, enabled: true } },
    });
    expect(content.endsWith("\n")).toBe(true);
    expect(content).not.toContain("\r");
  });

  it("leaves a config file with no mcp key alone when there is nothing to deliver", () => {
    writeConfig('{ "theme": "tokyonight" }\n');
    expect(adapter.renderMcp({})).toEqual([]);
  });

  it("is a fixed point: rendering what is already there changes nothing (SPEC §8)", () => {
    const first = renderOnly({ fs: STDIO, docs: HTTP });
    applyEdits([{ path: opencodeConfigPath(), content: first }]);
    const second = renderOnly({ fs: STDIO, docs: HTTP });
    expect(second).toBe(first);
  });

  /**
   * The read path (`parse()`, last-wins) and the write path (`modify()` →
   * `findNodeAtLocation`, first-wins) resolve a repeated key differently. A
   * document that makes them disagree took the edit into a block nothing reads
   * back, and — because re-rendering then produced the same no-op edit — every
   * `plan` afterwards reported 「差分なし」 about a change that never happened,
   * permanently. SPEC §6.3 says input this tool cannot understand is a stop.
   */
  it("refuses a document that declares `mcp` twice, instead of editing the block nobody reads", () => {
    writeConfig(`{
  "mcp": { "other": { "type": "local", "command": ["o"], "enabled": true } },
  "theme": "dark",
  "mcp": { "files": { "type": "local", "command": ["npx", "-y", "OLD"], "enabled": true } }
}
`);

    expect(() => adapter.readMcp()).toThrow(AmError);
    expect(() => adapter.readMcp()).toThrow(/more than once/);
    expect(() => adapter.readRawMcp()).toThrow(/more than once/);
    // The write path stops at the same gate, so `apply` cannot proceed either.
    expect(() => adapter.renderMcp({ files: STDIO })).toThrow(/more than once/);
  });

  it("refuses a repeated server name inside `mcp` for the same reason", () => {
    writeConfig(`{
  "mcp": {
    "files": { "type": "local", "command": ["npx", "-y", "OLD"], "enabled": true },
    "files": { "type": "local", "command": ["npx", "-y", "NEWER"], "enabled": true }
  }
}
`);

    expect(() => adapter.readMcp()).toThrow(/"files"/);
    expect(() => adapter.renderMcp({ files: STDIO })).toThrow(/more than once/);
  });

  it("accepts a repeated key outside the mcp path, which this adapter never edits", () => {
    // Narrow on purpose: a duplicate elsewhere is opencode's business, and
    // refusing the whole file over it would strand a config that works.
    writeConfig(`{
  "theme": "dark",
  "theme": "light",
  "mcp": { "files": { "type": "local", "command": ["npx"], "enabled": true } }
}
`);
    expect(Object.keys(adapter.readMcp())).toEqual(["files"]);
  });

  /**
   * `withTrailingNewline` is this tool's formatting for a file it writes
   * (SPEC §6.4). Imposing it on a document the run left alone made a config
   * whose last byte is `}` differ from its rendering by exactly one byte —
   * so `plan` reported `update mcp … content differs from source` and exited 1
   * on a machine that was already in sync, and only a rewrite this adapter had
   * no reason to make could clear it (SPEC §8's fixed point).
   */
  it("is byte-identical to a file with no trailing newline when nothing changes", () => {
    const canonical = renderOnly({ fs: STDIO });
    const stripped = canonical.replace(/\n$/, "");
    expect(stripped.endsWith("}")).toBe(true);
    writeConfig(stripped);

    const rendered = renderOnly({ fs: STDIO });
    expect(rendered).toBe(stripped);
    expect(rendered.endsWith("\n")).toBe(false);
  });

  it("still applies its own formatting once an entry genuinely changes", () => {
    writeConfig(renderOnly({ fs: STDIO }).replace(/\n$/, ""));
    const changed = renderOnly({ fs: { ...STDIO, args: ["-y", "other"] } });
    expect(changed.endsWith("\n")).toBe(true);
  });

  /**
   * The boundary of what the surgical write preserves, pinned rather than
   * assumed. The module comment used to promise that comments and formatting
   * came through untouched full stop; `modify()` replaces a whole value node,
   * so that is true *around* a rewritten entry and false *inside* it.
   */
  it("keeps comments around a rewritten entry and loses the ones inside it", () => {
    writeConfig(`{
  // outside: hand-written, must survive
  "theme": "tokyonight",
  "mcp": {
    // above the entry
    "fs": {
      "type": "local",
      // the executable
      "command": ["npx", "-y", "server-filesystem", "."],
      "cwd": "C:/work",
      "enabled": true
    }
  }
}
`);

    const onDisk: McpServer = {
      transport: "stdio",
      command: "npx",
      args: ["-y", "server-filesystem", "."],
    };

    // A no-op leaves the entry, inner comment included, strictly alone.
    const untouched = renderOnly({ fs: onDisk });
    expect(untouched).toContain("// the executable");

    // A real change replaces the whole value node, and what was inside it goes.
    const changed = renderOnly({
      fs: { ...onDisk, args: ["-y", "server-filesystem", "elsewhere"] },
    });
    expect(changed).toContain("// outside: hand-written, must survive");
    expect(changed).toContain("// above the entry");
    expect(changed).toContain('"theme": "tokyonight"');
    // SPEC §10.3's unknown-field rule still holds through the rewrite.
    expect(changed).toContain('"cwd": "C:/work"');
    // …but the comment that lived inside the rewritten value does not.
    expect(changed).not.toContain("// the executable");
  });

  it("drops a server the source no longer has only when it is not preserved", () => {
    writeConfig(`{
  "mcp": {
    "gone": { "type": "local", "command": ["old"], "enabled": true }
  }
}
`);
    const pruned = renderOnly({});
    expect(parseOpencodeConfig(pruned, "x")).toEqual({ mcp: {} });
  });
});

/* ------------------------------------------------------------------ */
/* Commands (SPEC §10.2)                                               */
/* ------------------------------------------------------------------ */

const RUN_TASK: CommandDef = {
  name: "run-task",
  description: "Run a task",
  agent: "coordinator",
  targets: ["opencode"],
  body: "Run the task named $ARGUMENTS and report back.",
};

describe("commands (SPEC §10.2)", () => {
  it("renders description and agent only, dropping name and targets", () => {
    const edits = adapter.renderCommands([RUN_TASK]);
    expect(isUnsupported(edits)).toBe(false);
    const edit = (edits as { path: string; content: string }[])[0];
    expect(edit?.path).toBe(opencodeCommandPath("run-task"));
    expect(edit?.content).toBe(
      "---\ndescription: Run a task\nagent: coordinator\n---\n\nRun the task named $ARGUMENTS and report back.\n",
    );
    expect(edit?.content).not.toContain("name:");
    expect(edit?.content).not.toContain("targets:");
  });

  it("passes the body through untouched, $ARGUMENTS included", () => {
    const edits = adapter.renderCommands([RUN_TASK]) as { content: string }[];
    expect(edits[0]?.content).toContain("$ARGUMENTS");
  });

  it("round-trips: render → read → the same description, agent and body", () => {
    applyEdits(adapter.renderCommands([RUN_TASK]) as { path: string; content: string }[]);
    expect(adapter.readCommands()).toEqual([
      {
        name: "run-task",
        description: "Run a task",
        agent: "coordinator",
        body: "Run the task named $ARGUMENTS and report back.",
      },
    ]);
  });

  it("reads a command with no agent, and omits the key rather than defaulting it", () => {
    writeCommand("plain", "---\ndescription: Just do it\n---\n\nBody.\n");
    const commands = adapter.readCommands();
    expect(commands).toEqual([{ name: "plain", description: "Just do it", body: "Body." }]);
    expect(commands[0]).not.toHaveProperty("agent");
  });

  it("refuses a name that would escape the command directory", () => {
    const escaping: CommandDef = { name: "../../evil", description: "x", body: "y" };
    expect(() => adapter.renderCommands([escaping])).toThrow(AmError);
  });

  it("reports frontmatter keys the normalized schema cannot carry", () => {
    writeCommand(
      "modelled",
      "---\ndescription: Uses a model\nmodel: anthropic/claude\nsubtask: true\n---\n\nBody.\n",
    );
    const notes = adapter.commandImportNotes("modelled", {
      name: "modelled",
      description: "Uses a model",
      body: "Body.",
    });
    expect(notes.map((n) => n.code)).toEqual([
      OPENCODE_COMMAND_KEY_DROPPED_CODE,
      OPENCODE_COMMAND_KEY_DROPPED_CODE,
    ]);
    expect(notes.map((n) => n.detail).join(" ")).toContain("model");
    expect(notes.map((n) => n.detail).join(" ")).toContain("subtask");
  });

  it("lists nothing when the command directory does not exist", () => {
    expect(adapter.readCommands()).toEqual([]);
    expect(fs.existsSync(opencodeCommandsDir())).toBe(false);
  });
});

/**
 * SPEC §10.2 — the two reads of the same directory.
 *
 * `readCommands` feeds `plan` / `apply` / `import` / `doctor` and stays strict
 * (SPEC §6.3). `readCommandsForDisplay` feeds `inventory`, which writes nothing:
 * one file with a broken frontmatter block used to make the whole survey exit 2
 * with nothing printed, and the console — whose window *is* that payload — showed
 * a fault plate instead of a table over a single command file.
 */
describe("commands: the display read (SPEC §10.2)", () => {
  const BROKEN = "---\ndescription: [unclosed\n---\n\nBody.\n";

  it("throws on the strict read and keeps the row on the display read", () => {
    writeCommand("task-baseline", BROKEN);

    expect(() => adapter.readCommands()).toThrow(AmError);

    const listed = adapter.readCommandsForDisplay();
    expect(listed).toHaveLength(1);
    // The name is the file-name stem — the one fact still legible about it.
    expect(listed[0]?.name).toBe("task-baseline");
    expect(listed[0]?.unreadable).toContain(opencodeCommandPath("task-baseline"));
    // Absent is absent: nothing is invented to fill the columns (PRODUCT).
    expect(listed[0]).not.toHaveProperty("description");
    expect(listed[0]).not.toHaveProperty("agent");
  });

  it("keeps every well-formed neighbour beside the broken one", () => {
    writeCommand("task-baseline", BROKEN);
    writeCommand("run-task", "---\ndescription: Run a task\nagent: coordinator\n---\n\nBody.\n");
    writeCommand("plain", "---\ndescription: Just do it\n---\n\nBody.\n");

    expect(adapter.readCommandsForDisplay()).toEqual([
      { name: "plain", description: "Just do it" },
      { name: "run-task", description: "Run a task", agent: "coordinator" },
      { name: "task-baseline", unreadable: expect.stringContaining("YAML") as unknown as string },
    ]);
  });

  it("says exactly what the strict read says when nothing is broken", () => {
    writeCommand("run-task", "---\ndescription: Run a task\nagent: coordinator\n---\n\nBody.\n");

    const strict = adapter.readCommands().map(({ body: _body, ...rest }) => rest);
    expect(adapter.readCommandsForDisplay()).toEqual(strict);
  });

  it("lists nothing at all when the directory does not exist", () => {
    expect(adapter.readCommandsForDisplay()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Refusals (SPEC §10.4 / §10.1)                                       */
/* ------------------------------------------------------------------ */

describe("unsupported asset kinds", () => {
  it("refuses agents in both directions, with the SPEC §10.4 reason", () => {
    expect(adapter.readAgents()).toBe(UNSUPPORTED);
    expect(adapter.renderAgents([])).toBe(UNSUPPORTED);
    const reason = adapter.unsupportedReason("agent") ?? "";
    expect(reason).toContain(OPENCODE_AGENTS_UNSUPPORTED_DETAIL);
    // The reason has to name the actual asymmetry, not merely say "no".
    expect(reason).toContain("permission");
    expect(reason).toContain("boolean map");
  });

  it("supports skills discovery via canonical store, no unsupported action", () => {
    expect(adapter.unsupportedReason("skill")).toBeUndefined();
    const actions = adapter.planSkills([{ name: "demo", sourcePath: "/nowhere" }]);
    expect(actions).toEqual([]);
    expect(actions.some((a) => a.kind === "unsupported")).toBe(false);
    expect(adapter.readSkillLinks()).not.toBe(UNSUPPORTED);
    expect(Array.isArray(adapter.readSkillLinks())).toBe(true);
  });

  it("has no reason to offer for the kinds it does support", () => {
    expect(adapter.unsupportedReason("mcp")).toBeUndefined();
    expect(adapter.unsupportedReason("command")).toBeUndefined();
  });

  it("discovers the skill source directly: links reported, no work planned", () => {
    fs.mkdirSync(path.join(sourceSkillsDir(), "demo"), { recursive: true });
    fs.writeFileSync(path.join(sourceSkillsDir(), "stray.txt"), "x", "utf8");

    const links = adapter.readSkillLinks();
    // A skill is a directory holding SKILL.md, so a loose file in the root is
    // not a skill anyone discovers. Listing it would put a row in `inventory`
    // for something no target sees — and, because vscode reads this same
    // directory and lists only directories, it would also make two views of
    // one directory disagree (SPEC §5).
    expect(links.map((l) => l.name)).toEqual(["demo"]);
    expect(links.find((l) => l.name === "demo")).toMatchObject({ name: "demo", kind: "directory" });
    expect(links.find((l) => l.name === "stray.txt")).toBeUndefined();
    expect(vscodeAdapter.readSkillLinks()).toEqual(links);

    expect(adapter.planSkills([{ name: "demo", sourcePath: path.join(sourceSkillsDir(), "demo") }])).toEqual([]);
    expect(adapter.unsupportedReason("skill")).toBeUndefined();
  });

  it("positive control: planSkills() returns [] while Claude adapter returns non-empty for the same skill", () => {
    const skillName = "test-skill";
    const skillDir = path.join(sourceSkillsDir(), skillName);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: test-skill\ndescription: Test skill\n---\n\nTest content\n", "utf8");

    const skillRef = { name: skillName, sourcePath: skillDir };

    expect(adapter.planSkills([skillRef])).toEqual([]);

    const claudeAdapter = createClaudeAdapter();
    const claudeActions = claudeAdapter.planSkills([skillRef]);
    expect(claudeActions.length).toBeGreaterThan(0);
    expect(claudeActions[0]?.kind).toBe("link");
  });

  it("readSkillLinks() returns empty array when skills directory does not exist", () => {
    expect(adapter.readSkillLinks()).toEqual([]);
  });

  it("readSkillLinks() classifies a broken symlink as 'broken'", () => {
    const skillsDir = sourceSkillsDir();
    fs.mkdirSync(skillsDir, { recursive: true });
    const brokenLinkPath = path.join(skillsDir, "broken-link");
    try {
      fs.symlinkSync("non-existent-target", brokenLinkPath);
    } catch {
      return;
    }

    const links = adapter.readSkillLinks();
    const brokenLink = links.find((l) => l.name === "broken-link");
    expect(brokenLink).toBeDefined();
    expect(brokenLink?.kind).toBe("broken");
  });

  it("readSkillLinks() omits a regular file — it is not a skill any target discovers", () => {
    const skillsDir = sourceSkillsDir();
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "regular-file.txt"), "file content", "utf8");
    fs.mkdirSync(path.join(skillsDir, "real-skill"), { recursive: true });

    const links = adapter.readSkillLinks();
    expect(links.find((l) => l.name === "regular-file.txt")).toBeUndefined();
    // Positive control for the omission: the reader is not simply returning []
    // — a real skill directory beside the stray file is still reported.
    expect(links.find((l) => l.name === "real-skill")?.kind).toBe("directory");
  });
});

/* ------------------------------------------------------------------ */
/* Import notes (SPEC §10.3)                                           */
/* ------------------------------------------------------------------ */

describe("import notes", () => {
  it("flags an imported remote server as an unrecoverable http/sse guess", () => {
    const notes = adapter.mcpImportNotes("docs", { transport: "http", url: "https://x.invalid" });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.code).toBe(OPENCODE_REMOTE_TRANSPORT_NOTE_CODE);
    expect(notes[0]?.detail).toContain("sse");
  });

  it("says nothing about a stdio server, which converts losslessly", () => {
    expect(adapter.mcpImportNotes("fs", STDIO)).toEqual([]);
  });

  /**
   * The write path preserves an owner-set `"enabled": false` on purpose. The
   * read path used to drop it with no note at all, so a server opencode had
   * switched off was imported as an ordinary one and then delivered to Claude
   * Code as active — a bigger loss than the transport guess above, travelling
   * in silence while the smaller one was reported.
   */
  it("reports a server opencode has switched off, instead of importing it in silence", () => {
    writeConfig(`{
  "mcp": {
    "risky": { "type": "local", "command": ["node", "x.js"], "enabled": false }
  }
}
`);

    expect(adapter.mcpDisabledNames()).toEqual(["risky"]);

    const server = adapter.readMcp()["risky"] as McpServer;
    const notes = adapter.mcpImportNotes("risky", server);
    expect(notes.map((n) => n.code)).toEqual([OPENCODE_DISABLED_SERVER_NOTE_CODE]);
    expect(notes[0]?.detail).toContain("enabled");
    expect(notes[0]?.detail).toContain("am disable mcp");
  });

  it("says nothing about a server opencode is running", () => {
    writeConfig(`{
  "mcp": {
    "fine": { "type": "local", "command": ["node", "x.js"], "enabled": true }
  }
}
`);
    expect(adapter.mcpDisabledNames()).toEqual([]);
    expect(adapter.mcpImportNotes("fine", adapter.readMcp()["fine"] as McpServer)).toEqual([]);
  });

  it("marks a remote server's transport as a guess and a local one as an observation", () => {
    expect(adapter.mcpImportIsGuess("docs", HTTP)).toBe(true);
    expect(adapter.mcpImportIsGuess("fs", STDIO)).toBe(false);
  });

  /**
   * `commandImportNotes` used to rebuild the path from the asset name. A file
   * that declares its own frontmatter `name` overrides the file-name fallback,
   * so the reconstructed path named a file that does not exist and the notes
   * about what was dropped vanished — exactly when the frontmatter was unusual
   * enough to have any.
   */
  it("finds the command file even when its frontmatter name differs from the file name", () => {
    writeCommand(
      "deploy",
      "---\nname: deployment\ndescription: Ship it\nmodel: anthropic/claude\nsubtask: true\n---\n\nBody.\n",
    );

    const command = adapter.readCommands()[0];
    expect(command?.name).toBe("deployment");

    const notes = adapter.commandImportNotes("deployment", command as CommandDef);
    expect(notes.map((n) => n.code)).toEqual([
      OPENCODE_COMMAND_KEY_DROPPED_CODE,
      OPENCODE_COMMAND_KEY_DROPPED_CODE,
    ]);
    expect(notes.map((n) => n.detail).join(" ")).toContain("model");
    expect(notes.map((n) => n.detail).join(" ")).toContain("subtask");
  });

  it("ignores a file that merely shares the name and did not produce the command", () => {
    // `other.md` renames itself, so it is *not* the source of the command
    // called `other`; `real.md` is. Reconstructing the path from the asset name
    // took the first file on faith and reported another command's dropped keys
    // as this one's. The shortcut is now checked rather than assumed.
    writeCommand("other", "---\nname: renamed\ndescription: X\nmodel: a/b\n---\n\nX.\n");
    writeCommand("real", "---\nname: other\ndescription: Y\ntemplate: t\n---\n\nY.\n");

    const details = adapter
      .commandImportNotes("other", { name: "other", description: "Y", body: "Y." })
      .map((n) => n.detail)
      .join(" ");
    expect(details).toContain("template");
    expect(details).not.toContain("model");
  });

  it("returns no notes when no file produced that command name", () => {
    expect(
      adapter.commandImportNotes("ghost", { name: "ghost", description: "x", body: "y" }),
    ).toEqual([]);
  });
});
