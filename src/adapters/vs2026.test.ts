import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseAgentFile, renderAgentFile } from "../core/frontmatter.js";
import { AmError, type AgentDef } from "../core/model.js";
import { sourceSkillsDir, vs2026AgentPath, vs2026AgentsDir } from "../core/paths.js";
import { isUnsupported, UNSUPPORTED, type Adapter } from "./types.js";
import {
  createVs2026Adapter,
  VS2026_AGENT_EXTENSION,
  vs2026AgentNameFromFile,
  vs2026McpUnsupportedAction,
} from "./vs2026.js";

const adapter = createVs2026Adapter();
/** Compile-time proof that the narrowed adapter still satisfies SPEC §7. */
const asAdapter: Adapter = adapter;

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env["AM_HOME"];
  home = fs.mkdtempSync(path.join(os.tmpdir(), "am-vs2026-"));
  process.env["AM_HOME"] = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["AM_HOME"];
  else process.env["AM_HOME"] = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

/** Write the rendered plan to disk, the way `commands/apply.ts` would. */
function applyEdits(edits: readonly { path: string; content: string }[]): void {
  for (const edit of edits) {
    fs.mkdirSync(path.dirname(edit.path), { recursive: true });
    fs.writeFileSync(edit.path, edit.content, "utf8");
  }
}

const FULL_AGENT: AgentDef = {
  name: "code-reviewer",
  description: "Reviews code changes",
  tools: ["Read", "Grep"],
  model: "sonnet",
  targets: ["claude", "vs2026"],
  extra: { "argument-hint": "<path>" },
  body: "You are a code reviewer.\n\nBe terse.",
};

const MINIMAL_AGENT: AgentDef = {
  name: "summarizer",
  description: "Summarizes text",
  body: "Summarize.",
};

describe("identity and paths", () => {
  it("declares the vs2026 identity and copilot dialect (SPEC §4)", () => {
    expect(adapter.id).toBe("vs2026");
    expect(asAdapter.id).toBe("vs2026");
    expect(adapter.capabilities.agentDialect).toBe("copilot");
    expect(adapter.capabilities.agentExtension).toBe(".agent.md");
    expect(VS2026_AGENT_EXTENSION).toBe(".agent.md");
    // No MCP file exists for this target, so no transport can be delivered.
    expect(adapter.capabilities.supportedTransports).toEqual([]);
    // Agents are rendered by this adapter, so discovery is NOT fully shared.
    expect(adapter.capabilities.sharesDiscoveryWith).toBeUndefined();
  });

  it("reports ~/.github/agents and an unsupported MCP path", () => {
    const paths = adapter.paths();
    expect(paths.agentsDir).toBe(vs2026AgentsDir());
    expect(paths.agentsDir).toBe(path.join(home, ".github", "agents"));
    expect(paths.mcp).toBe(UNSUPPORTED);
    expect(isUnsupported(paths.mcp)).toBe(true);
    // Skills come from the shared discovery path (the source of truth itself).
    expect(paths.skillsDir).toBe(path.join(home, ".agents", "skills"));
  });

  it("tracks AM_HOME between calls", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "am-vs2026-alt-"));
    try {
      process.env["AM_HOME"] = other;
      expect(adapter.paths().agentsDir).toBe(path.join(other, ".github", "agents"));
    } finally {
      process.env["AM_HOME"] = home;
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("MCP (unsupported, SPEC §4)", () => {
  it("reads as unsupported rather than empty", () => {
    expect(adapter.readMcp()).toBe(UNSUPPORTED);
  });

  it("renders no file edits, even for a populated server set", () => {
    const edits = adapter.renderMcp({
      fs: { transport: "stdio", command: "npx", args: ["-y", "server-fs"] },
      remote: { transport: "http", url: "https://example.invalid/mcp" },
    });
    expect(edits).toEqual([]);
  });

  it("offers an explicit unsupported action for plan/inventory", () => {
    const action = vs2026McpUnsupportedAction();
    expect(action.kind).toBe("unsupported");
    expect(action.target).toBe("vs2026");
    expect(action.asset).toBe("mcp");
    expect(action.detail).toMatch(/not supported/i);
  });

  it("writes nothing to the home directory while reading and rendering", () => {
    adapter.readMcp();
    adapter.renderMcp({});
    adapter.readAgents();
    adapter.renderAgents([FULL_AGENT]);
    adapter.planSkills([{ name: "style-guide", sourcePath: path.join(home, ".agents", "skills") }]);
    expect(fs.readdirSync(home)).toEqual([]);
  });
});

describe("skills (shared discovery, SPEC §4)", () => {
  it("plans no skill work", () => {
    expect(
      adapter.planSkills([
        { name: "style-guide", sourcePath: path.join(home, ".agents", "skills", "style-guide") },
        { name: "chart-kit", sourcePath: path.join(home, ".agents", "skills", "chart-kit") },
      ]),
    ).toEqual([]);
  });

  /*
   * SPEC §4 / §10.7 — vs2026 is the third target that discovers skills straight
   * from the source of truth, and it now says so the way the other two do.
   *
   * It used to answer `UNSUPPORTED`, on the grounds that a listing would let a
   * caller derive a `delete` against the source. It would not — the tests below
   * measure that rather than assuming it — and refusing to answer produced the
   * thing SPEC §5 forbids instead: one directory read by three targets, two
   * returning its contents and the third calling it 非対応 while naming that
   * very directory as its `skillsDir`.
   */
  it("reports the source directory's contents, as the other shared readers do", () => {
    fs.mkdirSync(path.join(sourceSkillsDir(), "beta"), { recursive: true });
    fs.mkdirSync(path.join(sourceSkillsDir(), "alpha"), { recursive: true });
    const links = adapter.readSkillLinks();
    expect(links.map((l) => l.name)).toEqual(["alpha", "beta"]);
    expect(links.every((l) => l.kind === "directory")).toBe(true);
  });

  it("returns an empty list when the source has no skills directory", () => {
    expect(adapter.readSkillLinks()).toEqual([]);
  });

  /**
   * The positive control for the refusal that was removed.
   *
   * The old comment claimed the listing itself was the hazard, so the listing
   * being present is exactly the condition under which "no `delete` is derived"
   * has to be shown rather than argued. `--prune` is included because that is
   * the only flag under which a skill `delete` is executable at all
   * (`isExecutableAction`), and a source-of-truth deletion is the one outcome
   * this repository treats as unthinkable.
   */
  it("derives no action against the source even with a full listing and --prune", () => {
    fs.mkdirSync(path.join(sourceSkillsDir(), "style-guide"), { recursive: true });
    fs.mkdirSync(path.join(sourceSkillsDir(), "orphan-in-source"), { recursive: true });
    expect(adapter.readSkillLinks()).toHaveLength(2);

    // Only one of the two is in the manifest; the other is exactly the shape
    // that becomes an `orphan` — and so a `delete` — for a target that owns its
    // directory.
    expect(
      adapter.planSkills([
        { name: "style-guide", sourcePath: path.join(sourceSkillsDir(), "style-guide") },
      ]),
    ).toEqual([]);
  });
});

describe("renderAgents (copilot dialect, SPEC §4)", () => {
  it("writes .agent.md files under ~/.github/agents", () => {
    const edits = adapter.renderAgents([FULL_AGENT]);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.path).toBe(path.join(home, ".github", "agents", "code-reviewer.agent.md"));
    expect(edits[0]?.path).toBe(vs2026AgentPath("code-reviewer"));
  });

  it("emits tools as a YAML array, never a comma-separated string", () => {
    const content = adapter.renderAgents([FULL_AGENT])[0]?.content ?? "";
    expect(content).toContain("tools:\n  - Read\n  - Grep");
    expect(content).not.toContain("tools: Read, Grep");
    expect(content).toBe(renderAgentFile(FULL_AGENT, "copilot"));
  });

  it("strips the source-only targets key", () => {
    const content = adapter.renderAgents([FULL_AGENT])[0]?.content ?? "";
    expect(content).not.toContain("targets");
    expect(parseAgentFile(content).targets).toBeUndefined();
  });

  it("preserves unknown frontmatter keys", () => {
    const content = adapter.renderAgents([FULL_AGENT])[0]?.content ?? "";
    expect(content).toContain("argument-hint: <path>");
  });

  it("omits optional keys that the agent does not define", () => {
    const content = adapter.renderAgents([MINIMAL_AGENT])[0]?.content ?? "";
    expect(content).not.toContain("tools:");
    expect(content).not.toContain("model:");
  });

  it("is deterministic: sorted by name and stable across calls", () => {
    const unsorted = [MINIMAL_AGENT, FULL_AGENT];
    const first = adapter.renderAgents(unsorted);
    const second = adapter.renderAgents([...unsorted].reverse());
    expect(first.map((e) => e.path)).toEqual(second.map((e) => e.path));
    expect(first.map((e) => e.path.endsWith("code-reviewer.agent.md"))).toEqual([true, false]);
    expect(first).toEqual(second);
  });

  it("uses LF only and ends with exactly one newline", () => {
    const content = adapter.renderAgents([FULL_AGENT])[0]?.content ?? "";
    expect(content).not.toContain("\r");
    expect(content.endsWith("\n")).toBe(true);
    expect(content.endsWith("\n\n")).toBe(false);
  });

  it("does not mutate the input array", () => {
    const input = [MINIMAL_AGENT, FULL_AGENT];
    adapter.renderAgents(input);
    expect(input[0]).toBe(MINIMAL_AGENT);
  });

  // SPEC §3: `vs2026AgentPath` is a bare join, so an unvalidated name would
  // write outside ~/.github/agents.
  it.each(["../../evil", "..\\evil", "has space", "UPPER", ""])(
    "refuses to render an agent named %j",
    (name) => {
      expect(() => adapter.renderAgents([{ name, description: "d", body: "b" }])).toThrow(AmError);
    },
  );
});

describe("readAgents", () => {
  it("returns [] when the directory does not exist", () => {
    expect(adapter.readAgents()).toEqual([]);
  });

  it("ignores files without the .agent.md extension", () => {
    fs.mkdirSync(vs2026AgentsDir(), { recursive: true });
    fs.writeFileSync(path.join(vs2026AgentsDir(), "README.md"), "not an agent\n", "utf8");
    fs.writeFileSync(path.join(vs2026AgentsDir(), "notes.txt"), "nope\n", "utf8");
    expect(adapter.readAgents()).toEqual([]);
  });

  it("falls back to the file name when frontmatter omits name", () => {
    applyEdits([
      {
        path: vs2026AgentPath("triage-bot"),
        content: "---\ndescription: Triages issues\n---\nTriage.\n",
      },
    ]);
    const agents = adapter.readAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.name).toBe("triage-bot");
    expect(agents[0]?.description).toBe("Triages issues");
  });

  it("normalizes a claude-style comma-separated tools string into an array", () => {
    applyEdits([
      {
        path: vs2026AgentPath("legacy"),
        content: "---\nname: legacy\ndescription: Legacy file\ntools: Read, Grep\n---\nBody.\n",
      },
    ]);
    expect(adapter.readAgents()[0]?.tools).toEqual(["Read", "Grep"]);
  });

  it("returns agents sorted by name", () => {
    applyEdits(adapter.renderAgents([FULL_AGENT, MINIMAL_AGENT]));
    expect(adapter.readAgents().map((a) => a.name)).toEqual(["code-reviewer", "summarizer"]);
  });

  it("throws on malformed frontmatter instead of treating it as empty (SPEC §6.3)", () => {
    applyEdits([
      {
        path: vs2026AgentPath("broken"),
        content: "---\nname: broken\ntools: [unclosed\n---\nBody.\n",
      },
    ]);
    expect(() => adapter.readAgents()).toThrow(AmError);
  });

  it("normalizes CRLF on read", () => {
    fs.mkdirSync(vs2026AgentsDir(), { recursive: true });
    fs.writeFileSync(
      vs2026AgentPath("crlf"),
      "---\r\nname: crlf\r\ndescription: CRLF file\r\n---\r\nLine one.\r\nLine two.\r\n",
      "utf8",
    );
    const agent = adapter.readAgents()[0];
    expect(agent?.body).toBe("Line one.\nLine two.");
  });
});

describe("round trip: normalize → render → re-parse → identical (SPEC §8)", () => {
  it("round-trips a fully populated agent (minus the stripped targets key)", () => {
    applyEdits(adapter.renderAgents([FULL_AGENT]));
    const [readBack] = adapter.readAgents();
    const { targets: _stripped, ...expected } = FULL_AGENT;
    expect(readBack).toEqual(expected);
  });

  it("round-trips a minimal agent unchanged", () => {
    applyEdits(adapter.renderAgents([MINIMAL_AGENT]));
    expect(adapter.readAgents()).toEqual([MINIMAL_AGENT]);
  });

  it("reaches a fixed point: re-rendering what was read produces identical bytes", () => {
    const first = adapter.renderAgents([FULL_AGENT, MINIMAL_AGENT]);
    applyEdits(first);
    const second = adapter.renderAgents(adapter.readAgents());
    expect(second).toEqual(first);
    applyEdits(second);
    expect(adapter.renderAgents(adapter.readAgents())).toEqual(first);
  });

  it("round-trips bodies containing frontmatter-like delimiters and unicode", () => {
    const tricky: AgentDef = {
      name: "tricky",
      description: "Body with --- separators, 日本語, and code",
      body: "Intro\n\n---\n\n```yaml\nname: not-frontmatter\n```\n\n終わり",
    };
    applyEdits(adapter.renderAgents([tricky]));
    expect(adapter.readAgents()).toEqual([tricky]);
  });

  it("round-trips a description that needs YAML quoting", () => {
    const quoted: AgentDef = {
      name: "quoted",
      description: 'Uses: colons, "quotes", and #hashes',
      tools: ["Read"],
      body: "Body.",
    };
    applyEdits(adapter.renderAgents([quoted]));
    expect(adapter.readAgents()).toEqual([quoted]);
  });
});

describe("vs2026AgentNameFromFile", () => {
  it("strips the .agent.md extension", () => {
    expect(vs2026AgentNameFromFile("code-reviewer.agent.md")).toBe("code-reviewer");
  });

  it("accepts a full path", () => {
    expect(vs2026AgentNameFromFile(vs2026AgentPath("code-reviewer"))).toBe("code-reviewer");
  });

  it("rejects other extensions and empty names", () => {
    expect(vs2026AgentNameFromFile("code-reviewer.md")).toBeUndefined();
    expect(vs2026AgentNameFromFile(".agent.md")).toBeUndefined();
  });
});
