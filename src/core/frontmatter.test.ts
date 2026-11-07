import { describe, expect, it } from "vitest";

import {
  agentsEqual,
  normalizeTools,
  parseAgentFile,
  parseFrontmatter,
  renderAgentFile,
  renderSourceAgentFile,
  serializeFrontmatter,
  toolsToString,
} from "./frontmatter.js";
import { AmError, type AgentDef } from "./model.js";

const SOURCE_DOC = `---
name: code-reviewer
description: Reviews code changes
tools:
  - Read
  - Grep
model: sonnet
targets:
  - claude
  - copilot-cli
---
You are a code reviewer.

Be terse.
`;

describe("parseFrontmatter", () => {
  it("splits frontmatter from body", () => {
    const { data, body, hasFrontmatter } = parseFrontmatter("---\na: 1\n---\nhello\n");
    expect(hasFrontmatter).toBe(true);
    expect(data).toEqual({ a: 1 });
    expect(body).toBe("hello\n");
  });

  it("treats a document without frontmatter as an empty mapping", () => {
    const { data, body, hasFrontmatter } = parseFrontmatter("just text\n");
    expect(hasFrontmatter).toBe(false);
    expect(data).toEqual({});
    expect(body).toBe("just text\n");
  });

  it("handles CRLF input", () => {
    const { data, body } = parseFrontmatter("---\r\na: 1\r\n---\r\nhello\r\n");
    expect(data).toEqual({ a: 1 });
    expect(body).toBe("hello\n");
  });

  it("handles an empty frontmatter block", () => {
    expect(parseFrontmatter("---\n---\nbody\n").data).toEqual({});
  });

  it("throws on malformed YAML rather than yielding empty data", () => {
    expect(() => parseFrontmatter("---\na: [1, 2\n---\nbody\n")).toThrow(AmError);
  });

  it("throws when the frontmatter is a sequence, not a mapping", () => {
    expect(() => parseFrontmatter("---\n- a\n- b\n---\nbody\n")).toThrow(/must be a YAML mapping/);
  });

  // Regression: an indented `---` inside a block scalar used to terminate the
  // frontmatter, truncating the value into still-valid YAML — silent corruption
  // rather than the loud failure SPEC §6.3 requires.
  it("does not treat an indented --- inside a block scalar as the closing delimiter", () => {
    const doc = "---\nname: x\ndescription: |\n  intro\n  ---\n  more\n---\nbody here\n";
    const { data, body } = parseFrontmatter(doc);
    expect(data["description"]).toBe("intro\n---\nmore\n");
    expect(body).toBe("body here\n");
  });

  it("does not treat a mid-line --- as the closing delimiter", () => {
    const { data, body } = parseFrontmatter('---\nname: "a --- b"\n---\nbody\n');
    expect(data["name"]).toBe("a --- b");
    expect(body).toBe("body\n");
  });

  it("keeps parsing a document whose closing delimiter has no trailing newline", () => {
    expect(parseFrontmatter("---\na: 1\n---").data).toEqual({ a: 1 });
  });

  it("survives the same block scalar through a full agent round trip", () => {
    const doc = "---\nname: x\ndescription: |\n  intro\n  ---\n  more\n---\nbody here\n";
    const agent = parseAgentFile(doc);
    expect(agent.description).toBe("intro\n---\nmore\n");
    expect(agent.body).toBe("body here");
    expect(parseAgentFile(renderSourceAgentFile(agent))).toEqual(agent);
  });
});

describe("serializeFrontmatter", () => {
  it("round-trips through parseFrontmatter", () => {
    const text = serializeFrontmatter({ name: "x", tools: ["A", "B"] }, "body text");
    expect(parseFrontmatter(text).data).toEqual({ name: "x", tools: ["A", "B"] });
    expect(parseFrontmatter(text).body.trim()).toBe("body text");
  });

  it("emits LF only and exactly one trailing newline", () => {
    const text = serializeFrontmatter({ a: 1 }, "body\n\n\n");
    expect(text).not.toContain("\r");
    expect(text.endsWith("body\n")).toBe(true);
  });

  it("omits the block entirely for empty data", () => {
    expect(serializeFrontmatter({}, "body")).toBe("body\n");
    expect(serializeFrontmatter({}, "")).toBe("");
  });
});

describe("normalizeTools / toolsToString (SPEC §4)", () => {
  it("accepts a YAML array", () => {
    expect(normalizeTools(["Read", "Grep"])).toEqual(["Read", "Grep"]);
  });

  it("accepts the claude comma-separated string", () => {
    expect(normalizeTools("Read, Grep,Bash")).toEqual(["Read", "Grep", "Bash"]);
  });

  it("returns undefined when absent so the key stays omitted", () => {
    expect(normalizeTools(undefined)).toBeUndefined();
    expect(normalizeTools(null)).toBeUndefined();
  });

  it("drops empty entries", () => {
    expect(normalizeTools("Read, ,Grep,")).toEqual(["Read", "Grep"]);
  });

  it("throws on a non-string, non-array value", () => {
    expect(() => normalizeTools(42)).toThrow(AmError);
  });

  it("renders the claude dialect string", () => {
    expect(toolsToString(["Read", "Grep"])).toBe("Read, Grep");
  });

  // Regression (SPEC §8 round trip): a Claude Code permission specifier is a
  // single entry even though it contains commas. Splitting on every comma tore
  // it into two broken fragments, which `import` then wrote into the source.
  it("keeps commas inside parentheses/brackets within one entry", () => {
    expect(normalizeTools("Bash(git add:*, git commit:*), Read")).toEqual([
      "Bash(git add:*, git commit:*)",
      "Read",
    ]);
    expect(normalizeTools("mcp__x[a, b], Grep")).toEqual(["mcp__x[a, b]", "Grep"]);
  });

  it("round-trips a comma-containing entry through the claude dialect", () => {
    const tools = ["Bash(git add:*, git commit:*)", "Read"];
    expect(normalizeTools(toolsToString(tools))).toEqual(tools);
  });

  it("refuses to render an entry whose comma is not enclosed", () => {
    expect(() => toolsToString(["a, b", "Read"])).toThrow(AmError);
  });
});

describe("parseAgentFile", () => {
  it("parses the normalized source form", () => {
    const agent = parseAgentFile(SOURCE_DOC, { sourcePath: "code-reviewer.md" });
    expect(agent.name).toBe("code-reviewer");
    expect(agent.description).toBe("Reviews code changes");
    expect(agent.tools).toEqual(["Read", "Grep"]);
    expect(agent.model).toBe("sonnet");
    expect(agent.targets).toEqual(["claude", "copilot-cli"]);
    expect(agent.body).toBe("You are a code reviewer.\n\nBe terse.");
  });

  it("normalizes the claude tools string into an array", () => {
    const agent = parseAgentFile("---\nname: a\ndescription: d\ntools: Read, Grep\n---\nbody\n");
    expect(agent.tools).toEqual(["Read", "Grep"]);
  });

  it("uses fallbackName when name is absent", () => {
    const agent = parseAgentFile("---\ndescription: d\n---\nbody\n", { fallbackName: "from-file" });
    expect(agent.name).toBe("from-file");
  });

  it("throws when name is missing entirely", () => {
    expect(() => parseAgentFile("---\ndescription: d\n---\nbody\n")).toThrow(/required "name"/);
  });

  it("throws when description is missing", () => {
    expect(() => parseAgentFile("---\nname: a\n---\nbody\n")).toThrow(/required "description"/);
  });

  it("allows missing fields in lenient mode (importing from a target)", () => {
    const agent = parseAgentFile("---\nname: a\n---\nbody\n", { lenient: true });
    expect(agent.description).toBe("");
  });

  it("rejects an unknown target id", () => {
    expect(() => parseAgentFile("---\nname: a\ndescription: d\ntargets: [nope]\n---\nb\n")).toThrow(
      /Unknown target "nope"/,
    );
  });

  it("preserves unknown frontmatter keys in extra", () => {
    const agent = parseAgentFile(
      "---\nname: a\ndescription: d\nargument-hint: <file>\n---\nbody\n",
    );
    expect(agent.extra).toEqual({ "argument-hint": "<file>" });
  });
});

describe("renderAgentFile dialects (SPEC §4)", () => {
  const agent: AgentDef = {
    name: "code-reviewer",
    description: "Reviews code changes",
    tools: ["Read", "Grep"],
    model: "sonnet",
    targets: ["claude", "copilot-cli"],
    body: "You are a code reviewer.",
  };

  it("renders tools as a comma-separated string for claude", () => {
    const text = renderAgentFile(agent, "claude");
    expect(parseFrontmatter(text).data["tools"]).toBe("Read, Grep");
    expect(text).toContain("tools: Read, Grep");
  });

  it("renders tools as a YAML array for copilot", () => {
    const text = renderAgentFile(agent, "copilot");
    expect(parseFrontmatter(text).data["tools"]).toEqual(["Read", "Grep"]);
  });

  it("always strips targets from rendered output (SPEC §3)", () => {
    for (const dialect of ["claude", "copilot"] as const) {
      const data = parseFrontmatter(renderAgentFile(agent, dialect)).data;
      expect(data["targets"]).toBeUndefined();
    }
  });

  it("keeps name and description in both dialects", () => {
    for (const dialect of ["claude", "copilot"] as const) {
      const data = parseFrontmatter(renderAgentFile(agent, dialect)).data;
      expect(data["name"]).toBe("code-reviewer");
      expect(data["description"]).toBe("Reviews code changes");
    }
  });

  it("omits tools when the list is empty", () => {
    const bare: AgentDef = { name: "a", description: "d", tools: [], body: "b" };
    expect(parseFrontmatter(renderAgentFile(bare, "claude")).data["tools"]).toBeUndefined();
  });

  it("round-trips through both dialects back to the same normalized agent", () => {
    for (const dialect of ["claude", "copilot"] as const) {
      const reparsed = parseAgentFile(renderAgentFile(agent, dialect));
      expect(reparsed.name).toBe(agent.name);
      expect(reparsed.description).toBe(agent.description);
      expect(reparsed.tools).toEqual(agent.tools);
      expect(reparsed.model).toBe(agent.model);
      expect(reparsed.body).toBe(agent.body);
      // targets is source-only and does not survive a target round trip
      expect(reparsed.targets).toBeUndefined();
    }
  });
});

describe("renderSourceAgentFile", () => {
  it("round-trips the full normalized agent including targets", () => {
    const agent = parseAgentFile(SOURCE_DOC);
    const reparsed = parseAgentFile(renderSourceAgentFile(agent));
    expect(reparsed).toEqual(agent);
  });

  it("is idempotent", () => {
    const once = renderSourceAgentFile(parseAgentFile(SOURCE_DOC));
    const twice = renderSourceAgentFile(parseAgentFile(once));
    expect(twice).toBe(once);
  });

  it("always writes tools as a YAML array", () => {
    const agent = parseAgentFile("---\nname: a\ndescription: d\ntools: Read, Grep\n---\nbody\n");
    expect(parseFrontmatter(renderSourceAgentFile(agent)).data["tools"]).toEqual(["Read", "Grep"]);
  });
});

describe("agentsEqual", () => {
  it("ignores body trailing whitespace differences", () => {
    const a = parseAgentFile("---\nname: a\ndescription: d\n---\nbody\n");
    const b = parseAgentFile("---\nname: a\ndescription: d\n---\nbody\n\n\n");
    expect(agentsEqual(a, b)).toBe(true);
  });

  it("detects a description change", () => {
    const a = parseAgentFile("---\nname: a\ndescription: d\n---\nbody\n");
    const b = parseAgentFile("---\nname: a\ndescription: e\n---\nbody\n");
    expect(agentsEqual(a, b)).toBe(false);
  });
});
