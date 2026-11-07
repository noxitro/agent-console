import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClaudeAdapter, createClaudeAdapter } from "./claude.js";
import { AmError, type AgentDef, type McpServer, type SkillRef } from "../core/model.js";
import {
  claudeAgentPath,
  claudeAgentsDir,
  claudeJsonPath,
  claudeSkillPath,
  claudeSkillsDir,
  sourceSkillDir,
} from "../core/paths.js";
import { parseAgentFile } from "../core/frontmatter.js";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env["AM_HOME"];
  home = fs.mkdtempSync(path.join(os.tmpdir(), "am-claude-"));
  process.env["AM_HOME"] = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env["AM_HOME"];
  else process.env["AM_HOME"] = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function write(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function writeClaudeJson(doc: unknown): void {
  write(claudeJsonPath(), `${JSON.stringify(doc, null, 2)}\n`);
}

/** Apply the adapter's planned edits, so a render can be read back. */
function applyEdits(edits: readonly { path: string; content: string }[]): void {
  for (const edit of edits) write(edit.path, edit.content);
}

const adapter = (): ClaudeAdapter => createClaudeAdapter({ linkMode: "junction" });

/* ------------------------------------------------------------------ */
/* paths / capabilities (SPEC §4)                                      */
/* ------------------------------------------------------------------ */

describe("ClaudeAdapter paths & capabilities (SPEC §4)", () => {
  it("declares the claude dialect and .md agents", () => {
    const a = adapter();
    expect(a.id).toBe("claude");
    expect(a.capabilities.agentExtension).toBe(".md");
    expect(a.capabilities.agentDialect).toBe("claude");
    expect(a.capabilities.supportedTransports).toEqual(["stdio", "http", "sse"]);
    expect(a.capabilities.sharesDiscoveryWith).toBeUndefined();
  });

  it("resolves every path through core/paths", () => {
    expect(adapter().paths()).toEqual({
      mcp: claudeJsonPath(),
      agentsDir: claudeAgentsDir(),
      skillsDir: claudeSkillsDir(),
      // SPEC §10.2: `command` is an opencode-only asset kind.
      commandsDir: "unsupported",
    });
  });
});

/* ------------------------------------------------------------------ */
/* MCP: read                                                           */
/* ------------------------------------------------------------------ */

describe("ClaudeAdapter.readMcp", () => {
  it("returns {} when ~/.claude.json does not exist", () => {
    expect(adapter().readMcp()).toEqual({});
  });

  it("returns {} when the document has no mcpServers key", () => {
    writeClaudeJson({ oauthAccount: { emailAddress: "user@example.com" } });
    expect(adapter().readMcp()).toEqual({});
  });

  it("converts the claude dialect back to the normalized schema", () => {
    writeClaudeJson({
      mcpServers: {
        remote: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "x" } },
        local: { type: "stdio", command: "npx", args: ["-y", "srv"], env: { TOKEN: "t" } },
        streamy: { type: "sse", url: "https://example.com/sse" },
      },
    });
    expect(adapter().readMcp()).toEqual({
      local: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "srv"],
        env: { TOKEN: "t" },
      },
      remote: {
        transport: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "x" },
      },
      streamy: { transport: "sse", url: "https://example.com/sse" },
    });
  });

  it("infers a missing type from the entry shape", () => {
    writeClaudeJson({
      mcpServers: {
        a: { command: "node", args: ["s.js"] },
        b: { url: "https://example.com/mcp" },
      },
    });
    const servers = adapter().readMcp();
    expect(servers["a"]?.transport).toBe("stdio");
    expect(servers["b"]?.transport).toBe("http");
  });

  it("throws on an unknown transport type rather than guessing (SPEC §6.3)", () => {
    writeClaudeJson({ mcpServers: { a: { type: "local", command: "node" } } });
    expect(() => adapter().readMcp()).toThrow(AmError);
  });

  it("throws on malformed JSON instead of treating it as empty (SPEC §6.3)", () => {
    write(claudeJsonPath(), "{ not json");
    expect(() => adapter().readMcp()).toThrow(AmError);
  });

  it("throws when mcpServers is not an object", () => {
    writeClaudeJson({ mcpServers: [] });
    expect(() => adapter().readMcp()).toThrow(AmError);
  });

  it("throws when the document root is not an object", () => {
    write(claudeJsonPath(), "[1,2,3]\n");
    expect(() => adapter().readMcp()).toThrow(AmError);
  });

  // Regression: a single non-string value used to make the whole env/headers
  // map vanish silently, taking the valid sibling entries with it.
  it("coerces scalar env/header values instead of dropping the whole map", () => {
    writeClaudeJson({
      mcpServers: {
        local: { type: "stdio", command: "npx", env: { PORT: 3000, TOKEN: "abc", DEBUG: true } },
        remote: { type: "http", url: "https://e.example/mcp", headers: { Retries: 3 } },
      },
    });
    const servers = adapter().readMcp();
    expect(servers["local"]?.env).toEqual({ DEBUG: "true", PORT: "3000", TOKEN: "abc" });
    expect(servers["remote"]?.headers).toEqual({ Retries: "3" });
  });

  it("throws on a non-scalar env value rather than losing it (SPEC §6.3)", () => {
    writeClaudeJson({ mcpServers: { a: { type: "stdio", command: "x", env: { K: { n: 1 } } } } });
    expect(() => adapter().readMcp()).toThrow(AmError);
  });

  it("throws on a non-scalar args element instead of mangling it via String()", () => {
    writeClaudeJson({ mcpServers: { a: { type: "stdio", command: "x", args: ["-y", { o: 1 }] } } });
    expect(() => adapter().readMcp()).toThrow(AmError);
  });

  it("coerces scalar args elements", () => {
    writeClaudeJson({ mcpServers: { a: { type: "stdio", command: "x", args: ["-p", 8080] } } });
    expect(adapter().readMcp()["a"]?.args).toEqual(["-p", "8080"]);
  });
});

describe("ClaudeAdapter.readRawMcp", () => {
  it("returns {} when the file or the key is absent", () => {
    expect(adapter().readRawMcp()).toEqual({});
    writeClaudeJson({ numStartups: 1 });
    expect(adapter().readRawMcp()).toEqual({});
  });

  it("returns each entry exactly as written, unknown fields included", () => {
    const entry = {
      type: "stdio",
      command: "npx",
      args: ["-y", "pkg"],
      env: { PORT: 3000 },
      timeout: 60000,
      scope: "user",
    };
    writeClaudeJson({ mcpServers: { unmanaged: entry } });
    expect(adapter().readRawMcp()).toEqual({ unmanaged: entry });
  });

  it("throws when an entry is not an object", () => {
    writeClaudeJson({ mcpServers: { a: "nope" } });
    expect(() => adapter().readRawMcp()).toThrow(AmError);
  });
});

/* ------------------------------------------------------------------ */
/* MCP: render + ~/.claude.json preservation (SPEC §6.1)               */
/* ------------------------------------------------------------------ */

describe("ClaudeAdapter.renderMcp (SPEC §6.1)", () => {
  const servers: Record<string, McpServer> = {
    zulu: { transport: "http", url: "https://z.example/mcp", headers: { A: "1" } },
    alpha: { transport: "stdio", command: "npx", args: ["-y", "a"], env: { K: "v" } },
  };

  it("swaps only mcpServers and preserves every other key structurally", () => {
    const original = {
      numStartups: 42,
      oauthAccount: { emailAddress: "user@example.com", scopes: ["a", "b"] },
      mcpServers: { stale: { type: "stdio", command: "old" } },
      projects: { "C:\\repo": { history: [{ display: "hi" }] } },
      tipsHistory: { x: 1 },
    };
    writeClaudeJson(original);

    const edits = adapter().renderMcp(servers);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.path).toBe(claudeJsonPath());

    const next = JSON.parse(edits[0]?.content ?? "") as Record<string, unknown>;
    expect(Object.keys(next)).toEqual(Object.keys(original));
    for (const key of Object.keys(original)) {
      if (key === "mcpServers") continue;
      expect(next[key]).toEqual((original as Record<string, unknown>)[key]);
    }
    expect(next["mcpServers"]).toEqual({
      alpha: { type: "stdio", command: "npx", args: ["-y", "a"], env: { K: "v" } },
      zulu: { type: "http", url: "https://z.example/mcp", headers: { A: "1" } },
    });
  });

  it("does not write anything (adapters only plan — SPEC §7)", () => {
    writeClaudeJson({ numStartups: 1 });
    const before = fs.readFileSync(claudeJsonPath(), "utf8");
    adapter().renderMcp(servers);
    expect(fs.readFileSync(claudeJsonPath(), "utf8")).toBe(before);
  });

  it("creates a minimal document when ~/.claude.json is absent", () => {
    const content = adapter().renderMcp({})[0]?.content ?? "";
    expect(JSON.parse(content)).toEqual({ mcpServers: {} });
  });

  it("appends mcpServers without disturbing existing key order", () => {
    writeClaudeJson({ b: 1, a: 2 });
    const content = adapter().renderMcp(servers)[0]?.content ?? "";
    expect(Object.keys(JSON.parse(content) as object)).toEqual(["b", "a", "mcpServers"]);
  });

  // SPEC §6.1 minimal touch: ~/.claude.json is Claude Code's live state file.
  it("leaves an existing document untouched when there is nothing to deliver", () => {
    writeClaudeJson({ oauthAccount: { emailAddress: "u@example.com" }, numStartups: 3 });
    expect(adapter().renderMcp({})).toEqual([]);
  });

  it("still rewrites an existing empty mcpServers key when servers are pruned away", () => {
    writeClaudeJson({ numStartups: 3, mcpServers: { gone: { type: "stdio", command: "x" } } });
    const content = adapter().renderMcp({})[0]?.content ?? "";
    expect(JSON.parse(content)).toEqual({ numStartups: 3, mcpServers: {} });
  });

  it("sorts server names and env/header keys so output is byte-stable (SPEC §8)", () => {
    const a = adapter();
    const first = a.renderMcp(servers)[0]?.content;
    const shuffled: Record<string, McpServer> = {
      alpha: { transport: "stdio", command: "npx", args: ["-y", "a"], env: { K: "v" } },
      zulu: { transport: "http", url: "https://z.example/mcp", headers: { A: "1" } },
    };
    expect(a.renderMcp(shuffled)[0]?.content).toBe(first);
  });

  it("throws rather than rewriting a corrupt ~/.claude.json (SPEC §6.3)", () => {
    write(claudeJsonPath(), "{ broken");
    expect(() => adapter().renderMcp(servers)).toThrow(AmError);
  });

  // Regression (SPEC §5): an entry `am` does not manage must survive an apply
  // byte-for-byte, not as a lossy re-render of the normalized projection.
  it("splices preserved entries in verbatim, keeping env and unknown fields", () => {
    const unmanaged = {
      type: "stdio",
      command: "npx",
      args: ["-y", "some-pkg"],
      env: { PORT: 3000, TOKEN: "abc" },
      timeout: 60000,
      scope: "user",
    };
    writeClaudeJson({ numStartups: 1, mcpServers: { unmanaged } });

    const content = adapter().renderMcp(servers, { preserve: { unmanaged } })[0]?.content ?? "";
    const next = JSON.parse(content) as { mcpServers: Record<string, unknown> };
    expect(next.mcpServers["unmanaged"]).toEqual(unmanaged);
    expect(Object.keys(next.mcpServers).sort()).toEqual(["alpha", "unmanaged", "zulu"]);
  });

  it("is a no-op render when the only entry is an unmanaged one (no perpetual update)", () => {
    const unmanaged = { type: "stdio", command: "npx", env: { PORT: 3000 }, timeout: 1 };
    writeClaudeJson({ numStartups: 1, mcpServers: { unmanaged } });
    const before = fs.readFileSync(claudeJsonPath(), "utf8");
    const content = adapter().renderMcp({}, { preserve: { unmanaged } })[0]?.content ?? "";
    expect(content).toBe(before);
  });

  it("lets the source win when a name is both managed and preserved", () => {
    const content =
      adapter().renderMcp(servers, { preserve: { alpha: { type: "stdio", command: "stale" } } })[0]
        ?.content ?? "";
    const next = JSON.parse(content) as { mcpServers: Record<string, { command?: string }> };
    expect(next.mcpServers["alpha"]?.command).toBe("npx");
  });

  it("ends with a trailing newline and 2-space indentation", () => {
    const content = adapter().renderMcp(servers)[0]?.content ?? "";
    expect(content.endsWith("}\n")).toBe(true);
    expect(content).toContain('\n  "mcpServers": {\n    "alpha": {');
  });
});

/* ------------------------------------------------------------------ */
/* MCP round trip (SPEC §8)                                            */
/* ------------------------------------------------------------------ */

describe("MCP round trip: normalized → render → re-parse (SPEC §8)", () => {
  const servers: Record<string, McpServer> = {
    stdio: { transport: "stdio", command: "npx", args: ["-y", "pkg"], env: { A: "1", B: "2" } },
    http: { transport: "http", url: "https://example.com/mcp", headers: { Authorization: "b" } },
    sse: { transport: "sse", url: "https://example.com/sse", headers: { X: "y" } },
  };

  it("re-parses to the identical normalized model", () => {
    const a = adapter();
    applyEdits(a.renderMcp(servers));
    expect(a.readMcp()).toEqual(servers);
  });

  it("is a fixed point: rendering the re-parsed model reproduces the file", () => {
    const a = adapter();
    const first = a.renderMcp(servers);
    applyEdits(first);
    const second = a.renderMcp(a.readMcp());
    expect(second[0]?.content).toBe(fs.readFileSync(claudeJsonPath(), "utf8"));
    expect(second[0]?.content).toBe(first[0]?.content);
  });

  it("keeps unrelated live state across a full round trip", () => {
    writeClaudeJson({ oauthAccount: { emailAddress: "u@example.com" }, numStartups: 7 });
    const a = adapter();
    applyEdits(a.renderMcp(servers));
    const doc = JSON.parse(fs.readFileSync(claudeJsonPath(), "utf8")) as Record<string, unknown>;
    expect(doc["oauthAccount"]).toEqual({ emailAddress: "u@example.com" });
    expect(doc["numStartups"]).toBe(7);
    expect(a.readMcp()).toEqual(servers);
  });
});

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

describe("ClaudeAdapter.renderAgents (SPEC §4 dialect table)", () => {
  const agent: AgentDef = {
    name: "code-reviewer",
    description: "Reviews code",
    tools: ["Read", "Grep"],
    model: "sonnet",
    targets: ["claude", "vs2026"],
    body: "You review code.",
  };

  it("writes .md files under ~/.claude/agents", () => {
    const edits = adapter().renderAgents([agent]);
    expect(edits[0]?.path).toBe(claudeAgentPath("code-reviewer"));
    expect(edits[0]?.path.endsWith(".md")).toBe(true);
    expect(edits[0]?.path.endsWith(".agent.md")).toBe(false);
  });

  it("renders tools as a comma-separated string, not an array", () => {
    const content = adapter().renderAgents([agent])[0]?.content ?? "";
    expect(content).toContain("tools: Read, Grep");
    expect(content).not.toContain("- Read");
  });

  it("always strips the source-only targets key (SPEC §3)", () => {
    const content = adapter().renderAgents([agent])[0]?.content ?? "";
    expect(content).not.toContain("targets");
  });

  it("keeps the required name key and the body", () => {
    const content = adapter().renderAgents([agent])[0]?.content ?? "";
    expect(content).toContain("name: code-reviewer");
    expect(content.endsWith("You review code.\n")).toBe(true);
  });

  it("omits tools entirely when the source has none", () => {
    const content =
      adapter().renderAgents([{ name: "a", description: "d", body: "b" }])[0]?.content ?? "";
    expect(content).not.toContain("tools");
  });

  it("preserves unknown frontmatter keys", () => {
    const content =
      adapter().renderAgents([
        { name: "a", description: "d", body: "b", extra: { "argument-hint": "<file>" } },
      ])[0]?.content ?? "";
    expect(content).toContain("argument-hint: <file>");
  });

  // SPEC §3: the name becomes a file name, so it must be validated before it
  // reaches `path.join` — `../../evil` would otherwise write outside ~/.claude.
  it.each(["../../evil", "..\\evil", "has space", "UPPER", "a:b", ""])(
    "refuses to render an agent named %j",
    (name) => {
      expect(() => adapter().renderAgents([{ name, description: "d", body: "b" }])).toThrow(
        AmError,
      );
    },
  );

  it("emits agents in a deterministic (name-sorted) order", () => {
    const edits = adapter().renderAgents([
      { name: "zebra", description: "z", body: "z" },
      { name: "apple", description: "a", body: "a" },
    ]);
    expect(edits.map((e) => path.basename(e.path))).toEqual(["apple.md", "zebra.md"]);
  });
});

describe("ClaudeAdapter.readAgents", () => {
  it("returns [] when the agents directory is missing", () => {
    expect(adapter().readAgents()).toEqual([]);
  });

  it("normalizes a comma-separated tools string back into an array", () => {
    write(
      claudeAgentPath("x"),
      "---\nname: x\ndescription: d\ntools: Read, Grep, Bash\n---\n\nbody\n",
    );
    expect(adapter().readAgents()[0]?.tools).toEqual(["Read", "Grep", "Bash"]);
  });

  it("falls back to the file name when frontmatter omits name", () => {
    write(claudeAgentPath("from-filename"), "---\ndescription: d\n---\n\nbody\n");
    expect(adapter().readAgents()[0]?.name).toBe("from-filename");
  });

  it("ignores files that are not .md", () => {
    write(path.join(claudeAgentsDir(), "notes.txt"), "hello");
    write(claudeAgentPath("real"), "---\nname: real\ndescription: d\n---\n\nb\n");
    expect(adapter().readAgents().map((a) => a.name)).toEqual(["real"]);
  });

  it("throws on malformed YAML frontmatter", () => {
    write(claudeAgentPath("bad"), "---\nname: [unclosed\n---\n\nbody\n");
    expect(() => adapter().readAgents()).toThrow(AmError);
  });

  it("returns agents sorted by name", () => {
    write(claudeAgentPath("b"), "---\nname: b\ndescription: d\n---\n\nb\n");
    write(claudeAgentPath("a"), "---\nname: a\ndescription: d\n---\n\na\n");
    expect(adapter().readAgents().map((a) => a.name)).toEqual(["a", "b"]);
  });
});

describe("Agent round trip: normalized → render → re-parse (SPEC §8)", () => {
  const agents: AgentDef[] = [
    {
      name: "code-reviewer",
      description: "Reviews code carefully",
      tools: ["Read", "Grep"],
      model: "sonnet",
      body: "Line one.\n\nLine two.",
    },
    { name: "minimal", description: "No optional keys", body: "Body." },
    {
      name: "with-extra",
      description: "Has unknown keys",
      tools: ["Read"],
      body: "Body.",
      extra: { "argument-hint": "<path>" },
    },
  ];

  it("re-parses each rendered file to the identical AgentDef", () => {
    const a = adapter();
    for (const agent of agents) {
      const edit = a.renderAgents([agent])[0]!;
      const reparsed = parseAgentFile(edit.content, {
        fallbackName: agent.name,
        sourcePath: edit.path,
      });
      expect(reparsed).toEqual(agent);
    }
  });

  it("drops targets on the way out, so the round trip is minus targets only", () => {
    const a = adapter();
    const withTargets: AgentDef = { ...agents[0]!, targets: ["claude"] };
    const content = a.renderAgents([withTargets])[0]?.content ?? "";
    expect(parseAgentFile(content)).toEqual(agents[0]);
  });

  it("is a fixed point through the file system: render → read → render", () => {
    const a = adapter();
    const first = a.renderAgents(agents);
    applyEdits(first);
    const second = a.renderAgents(a.readAgents());
    expect(second).toEqual(first);
    for (const edit of second) {
      expect(fs.readFileSync(edit.path, "utf8")).toBe(edit.content);
    }
  });

  it("survives a file written with CRLF endings", () => {
    const a = adapter();
    const edit = a.renderAgents([agents[0]!])[0]!;
    write(edit.path, edit.content.replace(/\n/g, "\r\n"));
    expect(a.renderAgents(a.readAgents())[0]?.content).toBe(edit.content);
  });
});

/* ------------------------------------------------------------------ */
/* Skills (SPEC §4, §6.6)                                              */
/* ------------------------------------------------------------------ */

function makeSourceSkill(name: string, body = "# skill\n"): SkillRef {
  const dir = sourceSkillDir(name);
  write(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n\n${body}`);
  return { name, sourcePath: dir };
}

describe("ClaudeAdapter.planSkills (SPEC §6.6)", () => {
  it("plans a link when the target slot is empty", () => {
    const skill = makeSourceSkill("alpha");
    const actions = adapter().planSkills([skill]);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: "link",
      target: "claude",
      asset: "skill",
      name: "alpha",
      path: claudeSkillPath("alpha"),
      sourcePath: skill.sourcePath,
      linkMode: "junction",
    });
  });

  it("is a no-op when a junction already resolves to the source", () => {
    const skill = makeSourceSkill("alpha");
    fs.mkdirSync(claudeSkillsDir(), { recursive: true });
    fs.symlinkSync(skill.sourcePath, claudeSkillPath("alpha"), "junction");
    expect(adapter().planSkills([skill])).toEqual([]);
  });

  it("reports drift for a physical copy whose content differs (SPEC §6.6)", () => {
    const skill = makeSourceSkill("alpha");
    write(path.join(claudeSkillPath("alpha"), "SKILL.md"), "different\n");
    const actions = adapter().planSkills([skill]);
    expect(actions[0]?.kind).toBe("drift");
  });

  it("plans a link for a physical copy identical to the source (SPEC §6.6)", () => {
    const skill = makeSourceSkill("alpha");
    fs.cpSync(skill.sourcePath, claudeSkillPath("alpha"), { recursive: true });
    const actions = adapter().planSkills([skill]);
    expect(actions[0]?.kind).toBe("link");
  });

  it("reports drift when a plain file occupies the slot", () => {
    const skill = makeSourceSkill("alpha");
    write(claudeSkillPath("alpha"), "not a directory");
    expect(adapter().planSkills([skill])[0]?.kind).toBe("drift");
  });

  it("converts an existing junction to a copy under linkMode copy", () => {
    const skill = makeSourceSkill("alpha");
    fs.mkdirSync(claudeSkillsDir(), { recursive: true });
    fs.symlinkSync(skill.sourcePath, claudeSkillPath("alpha"), "junction");
    const actions = createClaudeAdapter({ linkMode: "copy" }).planSkills([skill]);
    expect(actions[0]).toMatchObject({ kind: "update", linkMode: "copy" });
  });

  it("reports a target-only skill as delete", () => {
    const skill = makeSourceSkill("alpha");
    write(path.join(claudeSkillPath("orphan"), "SKILL.md"), "x\n");
    const actions = adapter().planSkills([skill]);
    expect(actions.filter((a) => a.kind === "delete")).toMatchObject([
      { name: "orphan", path: claudeSkillPath("orphan") },
    ]);
  });

  it("does not report an excluded skill as delete while it exists in the source", () => {
    const kept = makeSourceSkill("alpha");
    makeSourceSkill("excluded");
    write(path.join(claudeSkillPath("excluded"), "SKILL.md"), "x\n");
    // "excluded" is filtered out of the delivery list by manifest.skills.exclude,
    // but it is not absent from the source, so it must not be pruned.
    expect(adapter().planSkills([kept]).some((a) => a.kind === "delete")).toBe(false);
  });

  // SPEC §5 scopes `delete` to 管理下資産: a stray file the user dropped into
  // ~/.claude/skills was never managed and must not be pruned away.
  it("does not report a stray plain file as an orphan skill", () => {
    const kept = makeSourceSkill("alpha");
    write(claudeSkillPath("notes.txt"), "personal notes\n");
    write(claudeSkillPath("desktop.ini"), "[.ShellClassInfo]\n");
    expect(adapter().planSkills([kept]).some((a) => a.kind === "delete")).toBe(false);
  });

  it("still reports an orphan directory alongside a stray file", () => {
    const kept = makeSourceSkill("alpha");
    write(claudeSkillPath("notes.txt"), "x");
    write(path.join(claudeSkillPath("orphan"), "SKILL.md"), "x\n");
    expect(adapter().planSkills([kept]).filter((a) => a.kind === "delete")).toMatchObject([
      { name: "orphan" },
    ]);
  });

  it("does not write anything (SPEC §6.5)", () => {
    const skill = makeSourceSkill("alpha");
    adapter().planSkills([skill]);
    expect(fs.existsSync(claudeSkillsDir())).toBe(false);
  });
});

describe("ClaudeAdapter.readSkillLinks", () => {
  it("returns [] when the skills directory is missing", () => {
    expect(adapter().readSkillLinks()).toEqual([]);
  });

  it("classifies real directories, links and files", () => {
    const skill = makeSourceSkill("linked");
    fs.mkdirSync(claudeSkillPath("physical"), { recursive: true });
    fs.symlinkSync(skill.sourcePath, claudeSkillPath("linked"), "junction");
    write(claudeSkillPath("stray.txt"), "x");

    const byName = new Map(adapter().readSkillLinks().map((l) => [l.name, l]));
    expect(byName.get("physical")?.kind).toBe("directory");
    expect(["junction", "symlink"]).toContain(byName.get("linked")?.kind);
    expect(byName.get("linked")?.linkTarget).toBeDefined();
    expect(byName.get("stray.txt")?.kind).toBe("file");
  });

  it("classifies a link with an unresolvable destination as broken", () => {
    const gone = path.join(home, "gone");
    fs.mkdirSync(gone, { recursive: true });
    fs.mkdirSync(claudeSkillsDir(), { recursive: true });
    fs.symlinkSync(gone, claudeSkillPath("dead"), "junction");
    fs.rmSync(gone, { recursive: true, force: true });

    const link = adapter().readSkillLinks().find((l) => l.name === "dead");
    expect(link?.kind).toBe("broken");
  });
});
