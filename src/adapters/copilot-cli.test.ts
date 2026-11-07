import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CopilotCliAdapter,
  createCopilotCliAdapter,
  fromCopilotServer,
  renderCopilotMcpDocument,
  toCopilotServer,
  type CopilotMcpDocument,
} from "./copilot-cli.js";
import { isUnsupported } from "./types.js";
import { parseAgentFile } from "../core/frontmatter.js";
import { AmError, type AgentDef, type McpServer, type SkillRef } from "../core/model.js";
import {
  copilotAgentPath,
  copilotAgentsDir,
  copilotMcpConfigPath,
  copilotSelfManagedConfigPath,
  copilotSkillPath,
  copilotSkillsDir,
  sourceSkillDir,
} from "../core/paths.js";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env["AM_HOME"];
  home = fs.mkdtempSync(path.join(os.tmpdir(), "am-copilot-"));
  process.env["AM_HOME"] = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env["AM_HOME"];
  else process.env["AM_HOME"] = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function writeRaw(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function makeSkill(name: string, content = "# skill\n"): SkillRef {
  const dir = sourceSkillDir(name);
  writeRaw(path.join(dir, "SKILL.md"), content);
  return { name, sourcePath: dir };
}

const STDIO: McpServer = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "some-server"],
  env: { TOKEN: "abc", ALPHA: "1" },
};

const HTTP: McpServer = {
  transport: "http",
  url: "https://example.com/mcp",
  headers: { Authorization: "Bearer x" },
};

const SSE: McpServer = { transport: "sse", url: "https://example.com/sse" };

/* ------------------------------------------------------------------ */

describe("paths and capabilities (SPEC §4)", () => {
  it("reports the copilot-cli locations", () => {
    const adapter = new CopilotCliAdapter();
    expect(adapter.id).toBe("copilot-cli");
    expect(adapter.paths()).toEqual({
      mcp: path.join(home, ".copilot", "mcp-config.json"),
      agentsDir: path.join(home, ".copilot", "agents"),
      skillsDir: path.join(home, ".copilot", "skills"),
      // SPEC §10.2: `command` is an opencode-only asset kind.
      commandsDir: "unsupported",
    });
  });

  it("declares the copilot agent dialect and all three transports", () => {
    const { capabilities } = new CopilotCliAdapter();
    expect(capabilities.agentExtension).toBe(".agent.md");
    expect(capabilities.agentDialect).toBe("copilot");
    expect(capabilities.supportedTransports).toEqual(["stdio", "http", "sse"]);
    expect(capabilities.sharesDiscoveryWith).toBeUndefined();
  });
});

describe("MCP dialect conversion (SPEC §4)", () => {
  it("maps stdio to type \"local\" with tools: [\"*\"]", () => {
    expect(toCopilotServer(STDIO)).toEqual({
      type: "local",
      command: "npx",
      args: ["-y", "some-server"],
      env: { ALPHA: "1", TOKEN: "abc" },
      tools: ["*"],
    });
  });

  it("keeps http and sse type names", () => {
    expect(toCopilotServer(HTTP).type).toBe("http");
    expect(toCopilotServer(SSE).type).toBe("sse");
  });

  it("does not emit stdio fields on remote servers or vice versa", () => {
    const http = toCopilotServer({ ...HTTP, command: "ignored", args: ["x"] });
    expect(http.command).toBeUndefined();
    expect(http.args).toBeUndefined();
    const stdio = toCopilotServer({ ...STDIO, url: "https://ignored" });
    expect(stdio.url).toBeUndefined();
  });

  it("reads type \"local\" back as stdio and drops tools", () => {
    const server = fromCopilotServer(
      "x",
      { type: "local", command: "npx", args: ["a"], tools: ["*"] },
      "cfg",
    );
    expect(server).toEqual({ transport: "stdio", command: "npx", args: ["a"] });
  });

  it("accepts \"stdio\" as a synonym on read", () => {
    expect(fromCopilotServer("x", { type: "stdio", command: "c" }, "cfg").transport).toBe("stdio");
  });

  it("infers the transport when type is absent", () => {
    expect(fromCopilotServer("x", { command: "c" }, "cfg").transport).toBe("stdio");
    expect(fromCopilotServer("x", { url: "https://u" }, "cfg").transport).toBe("http");
  });

  it("throws on an unknown type instead of guessing", () => {
    expect(() => fromCopilotServer("x", { type: "carrier-pigeon" }, "cfg")).toThrow(AmError);
  });

  it("throws when an entry is not an object", () => {
    expect(() => fromCopilotServer("x", "nope", "cfg")).toThrow(AmError);
  });

  /* SPEC §6.3: a well-formed-but-unexpected value is silent data loss too. */
  it("coerces scalar env values and refuses non-scalar ones", () => {
    expect(
      fromCopilotServer("x", { type: "local", command: "c", env: { PORT: 8080, DEBUG: true } }, "cfg")
        .env,
    ).toEqual({ DEBUG: "true", PORT: "8080" });
    // `String({...})` is "[object Object]" — it would be imported into the
    // source of truth and rendered back into every target as if the user had
    // written it.
    expect(() =>
      fromCopilotServer("x", { type: "local", command: "c", env: { NESTED: { a: 1 } } }, "cfg"),
    ).toThrow(AmError);
    expect(() =>
      fromCopilotServer("x", { type: "local", command: "c", env: { LIST: ["a"] } }, "cfg"),
    ).toThrow(AmError);
  });

  it("refuses a non-scalar arg instead of stringifying it", () => {
    expect(
      fromCopilotServer("x", { type: "local", command: "c", args: ["a", 1, false] }, "cfg").args,
    ).toEqual(["a", "1", "false"]);
    expect(() =>
      fromCopilotServer("x", { type: "local", command: "c", args: [{ flag: "-y" }] }, "cfg"),
    ).toThrow(AmError);
  });

  it("refuses a non-object env / headers instead of dropping it", () => {
    expect(() =>
      fromCopilotServer("x", { type: "local", command: "c", env: "PORT=1" }, "cfg"),
    ).toThrow(AmError);
    expect(() =>
      fromCopilotServer("x", { type: "http", url: "https://u", headers: ["a"] }, "cfg"),
    ).toThrow(AmError);
  });

  it("refuses a non-scalar header value", () => {
    expect(() =>
      fromCopilotServer("x", { type: "http", url: "https://u", headers: { A: { b: 1 } } }, "cfg"),
    ).toThrow(AmError);
  });
});

describe("renderCopilotMcpDocument", () => {
  it("sorts server names and is deterministic (SPEC §8 fixed point)", () => {
    const a = renderCopilotMcpDocument({ zeta: SSE, alpha: STDIO });
    const b = renderCopilotMcpDocument({ alpha: STDIO, zeta: SSE });
    expect(a).toBe(b);
    expect(Object.keys((JSON.parse(a) as CopilotMcpDocument).mcpServers ?? {})).toEqual([
      "alpha",
      "zeta",
    ]);
  });

  it("emits 2-space JSON with a trailing newline", () => {
    const text = renderCopilotMcpDocument({ alpha: STDIO });
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "mcpServers": {');
  });

  it("preserves unrelated top-level keys structurally", () => {
    const text = renderCopilotMcpDocument({ alpha: STDIO }, { custom: { keep: true } });
    const parsed = JSON.parse(text) as CopilotMcpDocument;
    expect(parsed["custom"]).toEqual({ keep: true });
    expect(Object.keys(parsed.mcpServers ?? {})).toEqual(["alpha"]);
  });

  // Regression (SPEC §5): re-rendering an unmanaged entry used to overwrite its
  // `tools` allowlist with ["*"], silently widening a permission the user set.
  it("keeps a preserved entry verbatim, tools restriction and unknown keys included", () => {
    const unmanaged = { type: "local", command: "mytool", tools: ["read_file"], customField: 42 };
    const text = renderCopilotMcpDocument({ alpha: STDIO }, null, { unmanaged });
    const parsed = JSON.parse(text) as CopilotMcpDocument;
    expect((parsed.mcpServers ?? {})["unmanaged"]).toEqual(unmanaged);
    expect((parsed.mcpServers ?? {})["alpha"]?.tools).toEqual(["*"]);
  });

  it("lets the source win when a name is both managed and preserved", () => {
    const text = renderCopilotMcpDocument({ alpha: STDIO }, null, {
      alpha: { type: "local", command: "stale", tools: ["read_file"] },
    });
    const entry = (JSON.parse(text) as CopilotMcpDocument).mcpServers?.["alpha"];
    expect(entry?.command).toBe("npx");
    expect(entry?.tools).toEqual(["*"]);
  });
});

describe("readRawMcp", () => {
  it("returns {} when the file or the key is absent", () => {
    expect(new CopilotCliAdapter().readRawMcp()).toEqual({});
    writeRaw(copilotMcpConfigPath(), '{ "other": 1 }\n');
    expect(new CopilotCliAdapter().readRawMcp()).toEqual({});
  });

  it("returns entries exactly as written", () => {
    const entry = { type: "local", command: "mytool", tools: ["read_file"], customField: 42 };
    writeRaw(copilotMcpConfigPath(), `${JSON.stringify({ mcpServers: { u: entry } })}\n`);
    expect(new CopilotCliAdapter().readRawMcp()).toEqual({ u: entry });
  });

  it("throws on unparseable JSON (SPEC §6.3)", () => {
    writeRaw(copilotMcpConfigPath(), "{ not json\n");
    expect(() => new CopilotCliAdapter().readRawMcp()).toThrow(AmError);
  });
});

describe("renderMcp preservation (SPEC §5, §6.1)", () => {
  it("re-renders an unmanaged server to the identical bytes (no perpetual update)", () => {
    const unmanaged = { type: "local", command: "mytool", tools: ["read_file"], extra: 1 };
    const first = renderCopilotMcpDocument({}, null, { unmanaged });
    writeRaw(copilotMcpConfigPath(), first);
    const adapter = new CopilotCliAdapter();
    const again = adapter.renderMcp({}, { preserve: adapter.readRawMcp() });
    expect(again[0]?.content).toBe(first);
  });

  it("does not add an empty mcpServers key to a file that has none", () => {
    writeRaw(copilotMcpConfigPath(), '{\n  "other": 1\n}\n');
    expect(new CopilotCliAdapter().renderMcp({})).toEqual([]);
  });
});

describe("readMcp", () => {
  it("returns {} when the config is missing", () => {
    expect(new CopilotCliAdapter().readMcp()).toEqual({});
  });

  it("returns {} when mcpServers is absent", () => {
    writeRaw(copilotMcpConfigPath(), '{ "other": 1 }\n');
    expect(new CopilotCliAdapter().readMcp()).toEqual({});
  });

  it("throws on unparseable JSON rather than treating it as empty (SPEC §6.3)", () => {
    writeRaw(copilotMcpConfigPath(), "{ not json\n");
    expect(() => new CopilotCliAdapter().readMcp()).toThrow(AmError);
  });

  it("throws when mcpServers is not an object", () => {
    writeRaw(copilotMcpConfigPath(), '{ "mcpServers": [] }\n');
    expect(() => new CopilotCliAdapter().readMcp()).toThrow(AmError);
  });

  it("never reads ~/.copilot/config.json (SPEC §6.2)", () => {
    // A non-strict JSON file with comments: reading it would throw.
    writeRaw(copilotSelfManagedConfigPath(), '{\n  // self-managed\n  "theme": "dark"\n}\n');
    writeRaw(copilotMcpConfigPath(), '{ "mcpServers": {} }\n');
    const adapter = new CopilotCliAdapter();
    expect(adapter.readMcp()).toEqual({});
    expect(adapter.renderMcp({})).toHaveLength(1);
    // and it is left untouched
    expect(fs.readFileSync(copilotSelfManagedConfigPath(), "utf8")).toContain("// self-managed");
  });
});

describe("MCP round trip (normalize → render → re-parse, SPEC §8)", () => {
  it("survives a full round trip for every transport", () => {
    const servers: Record<string, McpServer> = { alpha: STDIO, beta: HTTP, gamma: SSE };
    const adapter = new CopilotCliAdapter();

    const edits = adapter.renderMcp(servers);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.path).toBe(copilotMcpConfigPath());
    writeRaw(edits[0]!.path, edits[0]!.content);

    const reread = adapter.readMcp();
    expect(isUnsupported(reread)).toBe(false);
    expect(reread).toEqual({
      alpha: { transport: "stdio", command: "npx", args: ["-y", "some-server"], env: { ALPHA: "1", TOKEN: "abc" } },
      beta: HTTP,
      gamma: SSE,
    });
  });

  it("re-rendering the re-parsed servers reproduces the same bytes", () => {
    const adapter = new CopilotCliAdapter();
    const first = adapter.renderMcp({ alpha: STDIO, beta: HTTP })[0]!;
    writeRaw(first.path, first.content);
    const reread = adapter.readMcp();
    expect(isUnsupported(reread)).toBe(false);
    const second = adapter.renderMcp(reread as Record<string, McpServer>)[0]!;
    expect(second.content).toBe(first.content);
  });

  it("preserves foreign top-level keys through render", () => {
    writeRaw(copilotMcpConfigPath(), '{\n  "mcpServers": {},\n  "keepMe": { "a": 1 }\n}\n');
    const edit = new CopilotCliAdapter().renderMcp({ alpha: STDIO })[0]!;
    const parsed = JSON.parse(edit.content) as CopilotMcpDocument;
    expect(parsed["keepMe"]).toEqual({ a: 1 });
    expect(Object.keys(parsed)).toEqual(["mcpServers", "keepMe"]);
  });
});

/* ------------------------------------------------------------------ */

const AGENT: AgentDef = {
  name: "code-reviewer",
  description: "Reviews code changes",
  tools: ["Read", "Grep"],
  model: "sonnet",
  targets: ["claude", "copilot-cli"],
  extra: { color: "blue" },
  body: "You are a code reviewer.",
};

describe("renderAgents (SPEC §4 dialect table)", () => {
  it("writes .agent.md files under ~/.copilot/agents", () => {
    const edits = new CopilotCliAdapter().renderAgents([AGENT]);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.path).toBe(path.join(home, ".copilot", "agents", "code-reviewer.agent.md"));
    expect(edits[0]?.path).toBe(copilotAgentPath("code-reviewer"));
  });

  it("emits tools as a YAML array, never a comma-separated string", () => {
    const content = new CopilotCliAdapter().renderAgents([AGENT])[0]!.content;
    expect(content).toMatch(/tools:\n\s+- Read\n\s+- Grep/);
    expect(content).not.toContain("tools: Read, Grep");
  });

  it("strips targets and keeps description and unknown keys", () => {
    const content = new CopilotCliAdapter().renderAgents([AGENT])[0]!.content;
    expect(content).not.toContain("targets");
    expect(content).toContain("description: Reviews code changes");
    expect(content).toContain("color: blue");
  });

  it("sorts output by agent name", () => {
    const zed: AgentDef = { name: "zed", description: "z", body: "b" };
    const abe: AgentDef = { name: "abe", description: "a", body: "b" };
    const edits = new CopilotCliAdapter().renderAgents([zed, abe]);
    expect(edits.map((e) => path.basename(e.path))).toEqual(["abe.agent.md", "zed.agent.md"]);
  });

  it("throws when description is missing (copilot requires it)", () => {
    const bad: AgentDef = { name: "no-desc", description: "  ", body: "b" };
    expect(() => new CopilotCliAdapter().renderAgents([bad])).toThrow(AmError);
  });

  it("throws on a name that cannot be a safe file name", () => {
    const bad: AgentDef = { name: "../escape", description: "d", body: "b" };
    expect(() => new CopilotCliAdapter().renderAgents([bad])).toThrow(AmError);
  });

  it("never writes during render (SPEC §7)", () => {
    new CopilotCliAdapter().renderAgents([AGENT]);
    expect(fs.existsSync(copilotAgentsDir())).toBe(false);
  });
});

describe("agent round trip (normalize → render → re-parse → identical)", () => {
  it("returns the same agent minus source-only targets", () => {
    const adapter = new CopilotCliAdapter();
    const edit = adapter.renderAgents([AGENT])[0]!;
    writeRaw(edit.path, edit.content);

    const agents = adapter.readAgents();
    expect(isUnsupported(agents)).toBe(false);
    const [reread] = agents as AgentDef[];
    const { targets: _targets, ...expected } = AGENT;
    expect(reread).toEqual(expected);
  });

  it("re-rendering the re-parsed agent reproduces the same bytes", () => {
    const adapter = new CopilotCliAdapter();
    const first = adapter.renderAgents([AGENT])[0]!;
    writeRaw(first.path, first.content);
    const [reread] = adapter.readAgents() as AgentDef[];
    const second = adapter.renderAgents([reread!])[0]!;
    expect(second.content).toBe(first.content);
    expect(second.path).toBe(first.path);
  });

  it("round-trips an agent with neither tools nor model", () => {
    const minimal: AgentDef = { name: "plain", description: "does things", body: "Body text." };
    const adapter = new CopilotCliAdapter();
    const edit = adapter.renderAgents([minimal])[0]!;
    writeRaw(edit.path, edit.content);
    expect(parseAgentFile(edit.content, { sourcePath: edit.path })).toEqual(minimal);
    expect((adapter.readAgents() as AgentDef[])[0]).toEqual(minimal);
  });

  it("accepts a claude-style comma string on read and normalizes it to an array", () => {
    writeRaw(
      copilotAgentPath("legacy"),
      "---\nname: legacy\ndescription: legacy agent\ntools: Read, Grep\n---\nBody\n",
    );
    const [agent] = new CopilotCliAdapter().readAgents() as AgentDef[];
    expect(agent?.tools).toEqual(["Read", "Grep"]);
  });

  it("falls back to the file name and tolerates a missing description on read", () => {
    writeRaw(copilotAgentPath("from-name"), "Body only\n");
    const [agent] = new CopilotCliAdapter().readAgents() as AgentDef[];
    expect(agent?.name).toBe("from-name");
    expect(agent?.description).toBe("");
  });

  it("ignores files that are not .agent.md and returns [] for a missing dir", () => {
    expect(new CopilotCliAdapter().readAgents()).toEqual([]);
    writeRaw(path.join(copilotAgentsDir(), "notes.md"), "---\nname: notes\n---\nx\n");
    expect(new CopilotCliAdapter().readAgents()).toEqual([]);
  });

  it("throws on malformed YAML frontmatter (SPEC §6.3)", () => {
    writeRaw(copilotAgentPath("broken"), "---\na: [1, 2\n---\nbody\n");
    expect(() => new CopilotCliAdapter().readAgents()).toThrow(AmError);
  });
});

/* ------------------------------------------------------------------ */

describe("planSkills (SPEC §4, §6.6)", () => {
  it("plans a link for a skill missing from the target", () => {
    const skill = makeSkill("alpha");
    const actions = new CopilotCliAdapter({ linkMode: "junction" }).planSkills([skill]);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe("link");
    expect(actions[0]?.target).toBe("copilot-cli");
    expect(actions[0]?.asset).toBe("skill");
    expect(actions[0]?.path).toBe(copilotSkillPath("alpha"));
    expect(actions[0]?.sourcePath).toBe(skill.sourcePath);
  });

  it("is a no-op when a junction already points at the source", () => {
    const skill = makeSkill("alpha");
    fs.mkdirSync(copilotSkillsDir(), { recursive: true });
    fs.symlinkSync(skill.sourcePath, copilotSkillPath("alpha"), "junction");
    expect(new CopilotCliAdapter({ linkMode: "junction" }).planSkills([skill])).toEqual([]);
  });

  it("updates a junction that points somewhere else", () => {
    const skill = makeSkill("alpha");
    const elsewhere = path.join(home, "elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.mkdirSync(copilotSkillsDir(), { recursive: true });
    fs.symlinkSync(elsewhere, copilotSkillPath("alpha"), "junction");
    const actions = new CopilotCliAdapter({ linkMode: "junction" }).planSkills([skill]);
    expect(actions.map((a) => a.kind)).toEqual(["update"]);
  });

  it("replaces an identical physical copy with a junction", () => {
    const skill = makeSkill("alpha");
    writeRaw(path.join(copilotSkillPath("alpha"), "SKILL.md"), "# skill\n");
    const actions = new CopilotCliAdapter({ linkMode: "junction" }).planSkills([skill]);
    expect(actions.map((a) => a.kind)).toEqual(["link"]);
  });

  it("reports drift for a divergent physical copy instead of clobbering it", () => {
    const skill = makeSkill("alpha");
    writeRaw(path.join(copilotSkillPath("alpha"), "SKILL.md"), "# locally edited\n");
    const actions = new CopilotCliAdapter({ linkMode: "junction" }).planSkills([skill]);
    expect(actions.map((a) => a.kind)).toEqual(["drift"]);
  });

  it("reports drift when a file occupies the skill path", () => {
    const skill = makeSkill("alpha");
    writeRaw(copilotSkillPath("alpha"), "not a directory");
    const actions = new CopilotCliAdapter({ linkMode: "junction" }).planSkills([skill]);
    expect(actions.map((a) => a.kind)).toEqual(["drift"]);
  });

  it("honours linkMode: copy", () => {
    const skill = makeSkill("alpha");
    const actions = new CopilotCliAdapter({ linkMode: "copy" }).planSkills([skill]);
    expect(actions[0]?.kind).toBe("link");
    expect(actions[0]?.linkMode).toBe("copy");
    expect(actions[0]?.detail).toContain("copy");
  });

  it("reports target-only skills as deletes", () => {
    const skill = makeSkill("alpha");
    writeRaw(path.join(copilotSkillPath("orphan"), "SKILL.md"), "# orphan\n");
    const actions = new CopilotCliAdapter({ linkMode: "junction" }).planSkills([skill]);
    expect(actions.filter((a) => a.kind === "delete").map((a) => a.name)).toEqual(["orphan"]);
  });

  it("defaults linkMode to the manifest value", () => {
    makeSkill("alpha");
    writeRaw(
      path.join(home, ".agents-manager", "manifest.json"),
      JSON.stringify({
        version: 1,
        targets: {
          claude: { enabled: true },
          "copilot-cli": { enabled: true },
          vscode: { enabled: true },
          vs2026: { enabled: true },
        },
        skills: { linkMode: "copy", exclude: [] },
      }),
    );
    const actions = createCopilotCliAdapter().planSkills([
      { name: "alpha", sourcePath: sourceSkillDir("alpha") },
    ]);
    expect(actions[0]?.linkMode).toBe("copy");
  });

  // SPEC §5: `delete` means ソースに無く実環境にだけある. A skill removed from
  // the delivery list by manifest.skills.exclude is still in the source, so it
  // is not an orphan — the claude adapter has always behaved this way.
  it("does not report an excluded skill as delete while it exists in the source", () => {
    const kept = makeSkill("alpha");
    makeSkill("excluded");
    writeRaw(path.join(copilotSkillPath("excluded"), "SKILL.md"), "x\n");
    const actions = new CopilotCliAdapter({ linkMode: "junction" }).planSkills([kept]);
    expect(actions.some((a) => a.kind === "delete")).toBe(false);
  });

  it("still reports a skill absent from the source as delete", () => {
    const kept = makeSkill("alpha");
    writeRaw(path.join(copilotSkillPath("orphan"), "SKILL.md"), "x\n");
    const actions = new CopilotCliAdapter({ linkMode: "junction" }).planSkills([kept]);
    expect(actions.filter((a) => a.kind === "delete")).toMatchObject([{ name: "orphan" }]);
  });

  it("never writes during planning (SPEC §6.5)", () => {
    const skill = makeSkill("alpha");
    new CopilotCliAdapter({ linkMode: "junction" }).planSkills([skill]);
    expect(fs.existsSync(copilotSkillsDir())).toBe(false);
  });
});

describe("readSkillLinks", () => {
  it("returns [] when the skills directory does not exist", () => {
    expect(new CopilotCliAdapter().readSkillLinks()).toEqual([]);
  });

  it("classifies real directories and junctions", () => {
    const skill = makeSkill("linked");
    writeRaw(path.join(copilotSkillPath("physical"), "SKILL.md"), "# p\n");
    fs.symlinkSync(skill.sourcePath, copilotSkillPath("linked"), "junction");
    const links = new CopilotCliAdapter().readSkillLinks();
    expect(isUnsupported(links)).toBe(false);
    const byName = Object.fromEntries(
      (links as { name: string; kind: string }[]).map((l) => [l.name, l.kind]),
    );
    expect(byName["physical"]).toBe("directory");
    // Windows cannot fully distinguish a junction from a directory symlink;
    // both are handled identically by the diff engine.
    expect(byName["linked"]).toBe(process.platform === "win32" ? "junction" : "symlink");
  });

  it("classifies a broken link", () => {
    const gone = path.join(home, "gone");
    fs.mkdirSync(gone, { recursive: true });
    fs.mkdirSync(copilotSkillsDir(), { recursive: true });
    fs.symlinkSync(gone, copilotSkillPath("dangling"), "junction");
    fs.rmSync(gone, { recursive: true, force: true });
    const links = new CopilotCliAdapter().readSkillLinks() as { name: string; kind: string }[];
    expect(links.find((l) => l.name === "dangling")?.kind).toBe("broken");
  });
});
