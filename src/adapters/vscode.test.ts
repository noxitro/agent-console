import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AmError, type McpServer } from "../core/model.js";
import { copilotAgentsDir, sourceSkillsDir, vscodeMcpPath } from "../core/paths.js";
import {
  VSCODE_AGENT_EXTENSION,
  VSCODE_SERVERS_KEY,
  VscodeAdapter,
  mcpWarnings,
  parseVscodeMcp,
  toVscodeServer,
  toVscodeServers,
  vscodeAdapter,
} from "./vscode.js";

let tmp: string;
let adapter: VscodeAdapter;
const savedEnv = { AM_HOME: process.env["AM_HOME"], AM_APPDATA: process.env["AM_APPDATA"] };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-vscode-"));
  process.env["AM_HOME"] = path.join(tmp, "home");
  process.env["AM_APPDATA"] = path.join(tmp, "appdata");
  adapter = new VscodeAdapter();
});

afterEach(() => {
  for (const key of ["AM_HOME", "AM_APPDATA"] as const) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeMcpJson(value: unknown): void {
  const target = vscodeMcpPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function renderedDocument(servers: Record<string, McpServer>): Record<string, unknown> {
  const edits = adapter.renderMcp(servers);
  expect(edits).toHaveLength(1);
  const edit = edits[0];
  if (edit === undefined) throw new Error("no edit");
  expect(edit.path).toBe(vscodeMcpPath());
  return JSON.parse(edit.content) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */

describe("paths and capabilities (SPEC §4)", () => {
  it("puts MCP at %APPDATA%/Code/User/mcp.json", () => {
    expect(adapter.paths().mcp).toBe(path.join(tmp, "appdata", "Code", "User", "mcp.json"));
  });

  it("reports the shared copilot-cli agents directory and the skill source", () => {
    expect(adapter.paths().agentsDir).toBe(copilotAgentsDir());
    expect(adapter.paths().skillsDir).toBe(sourceSkillsDir());
  });

  it("declares that discovery is shared with copilot-cli", () => {
    expect(adapter.capabilities.sharesDiscoveryWith).toBe("copilot-cli");
    expect(adapter.capabilities.agentExtension).toBe(VSCODE_AGENT_EXTENSION);
    expect(adapter.capabilities.agentDialect).toBe("copilot");
    expect(adapter.capabilities.supportedTransports).toEqual(["stdio", "http"]);
  });

  it("exposes a singleton with id vscode", () => {
    expect(vscodeAdapter.id).toBe("vscode");
  });
});

describe("MCP dialect conversion (SPEC §4 matrix)", () => {
  it("maps stdio to type stdio and keeps command/args/env", () => {
    expect(
      toVscodeServer({
        transport: "stdio",
        command: "npx",
        args: ["-y", "pkg"],
        env: { B: "2", A: "1" },
      }),
    ).toEqual({ type: "stdio", command: "npx", args: ["-y", "pkg"], env: { A: "1", B: "2" } });
  });

  it("maps http to type http and keeps url/headers", () => {
    expect(
      toVscodeServer({ transport: "http", url: "https://x.test", headers: { Auth: "t" } }),
    ).toEqual({ type: "http", url: "https://x.test", headers: { Auth: "t" } });
  });

  it("returns null for sse (unsupported by VS Code)", () => {
    expect(toVscodeServer({ transport: "sse", url: "https://x.test" })).toBeNull();
  });

  it("strips source-only targets and transport-irrelevant fields", () => {
    const entry = toVscodeServer({
      transport: "stdio",
      command: "npx",
      url: "https://leak.test",
      targets: ["vscode", "claude"],
    });
    expect(entry).toEqual({ type: "stdio", command: "npx" });
    expect(entry === null ? [] : Object.keys(entry)).not.toContain("targets");
  });

  it("sorts server names and drops sse entries", () => {
    const out = toVscodeServers({
      zeta: { transport: "stdio", command: "z" },
      alpha: { transport: "http", url: "https://a.test" },
      streamer: { transport: "sse", url: "https://s.test" },
    });
    expect(Object.keys(out)).toEqual(["alpha", "zeta"]);
  });
});

describe("sse warning (SPEC §4: 非対応 → plan で警告しスキップ)", () => {
  it("emits one unsupported action per sse server and none otherwise", () => {
    const warnings = mcpWarnings({
      ok: { transport: "stdio", command: "x" },
      streamer: { transport: "sse", url: "https://s.test" },
    });
    expect(warnings).toHaveLength(1);
    const warning = warnings[0];
    if (warning === undefined) throw new Error("no warning");
    expect(warning.kind).toBe("unsupported");
    expect(warning.target).toBe("vscode");
    expect(warning.asset).toBe("mcp");
    expect(warning.detail).toContain("streamer");
    expect(warning.detail).toContain("sse");
    expect(warning.path).toBe(vscodeMcpPath());
  });

  it("is also reachable from the adapter instance", () => {
    expect(adapter.mcpWarnings({ s: { transport: "sse", url: "https://s.test" } })).toHaveLength(1);
  });
});

describe("round trip: normalized → render → re-parse (SPEC §8)", () => {
  const servers: Record<string, McpServer> = {
    "http-one": {
      transport: "http",
      url: "https://api.test/mcp",
      headers: { Authorization: "Bearer x" },
    },
    "stdio-one": {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@scope/server", "--flag"],
      env: { TOKEN: "abc", ZONE: "eu" },
    },
    "stdio-bare": { transport: "stdio", command: "server.exe" },
  };

  it("re-parses to exactly the normalized input", () => {
    const doc = renderedDocument(servers);
    expect(parseVscodeMcp(doc)).toEqual(servers);
  });

  it("is idempotent: rendering the re-parsed servers yields identical bytes", () => {
    const first = adapter.renderMcp(servers)[0];
    if (first === undefined) throw new Error("no edit");
    writeMcpJson(JSON.parse(first.content));
    const second = adapter.renderMcp(parseVscodeMcp(JSON.parse(first.content)))[0];
    if (second === undefined) throw new Error("no edit");
    expect(second.content).toBe(first.content);
  });

  it("survives a round trip through the file system via readMcp", () => {
    const doc = renderedDocument(servers);
    writeMcpJson(doc);
    expect(adapter.readMcp()).toEqual(servers);
  });

  it("drops sse on the way out but keeps it on the way in", () => {
    const withSse: Record<string, McpServer> = {
      ...servers,
      streamer: { transport: "sse", url: "https://s.test" },
    };
    const doc = renderedDocument(withSse);
    expect(parseVscodeMcp(doc)).toEqual(servers);

    writeMcpJson({ servers: { streamer: { type: "sse", url: "https://s.test" } } });
    expect(adapter.readMcp()).toEqual({ streamer: { transport: "sse", url: "https://s.test" } });
  });

  it("renders deterministically regardless of source key order", () => {
    const reversed: Record<string, McpServer> = {};
    for (const name of Object.keys(servers).reverse()) {
      const server = servers[name];
      if (server !== undefined) reversed[name] = server;
    }
    const a = adapter.renderMcp(servers)[0];
    const b = adapter.renderMcp(reversed)[0];
    expect(a?.content).toBe(b?.content);
  });
});

describe("renderMcp preserves the rest of mcp.json (SPEC §4: inputs 保全)", () => {
  it("keeps inputs and any other top-level keys byte-for-byte", () => {
    writeMcpJson({
      inputs: [{ id: "token", type: "promptString", description: "Token", password: true }],
      servers: { stale: { type: "stdio", command: "old" } },
      "some.other.setting": { nested: [1, 2, 3] },
    });
    const doc = renderedDocument({ fresh: { transport: "stdio", command: "new" } });
    expect(doc["inputs"]).toEqual([
      { id: "token", type: "promptString", description: "Token", password: true },
    ]);
    expect(doc["some.other.setting"]).toEqual({ nested: [1, 2, 3] });
  });

  it("replaces the servers map wholesale rather than merging", () => {
    writeMcpJson({ servers: { stale: { type: "stdio", command: "old" } } });
    const doc = renderedDocument({ fresh: { transport: "stdio", command: "new" } });
    expect(Object.keys(doc[VSCODE_SERVERS_KEY] as Record<string, unknown>)).toEqual(["fresh"]);
  });

  it("keeps the original position of the servers key", () => {
    writeMcpJson({ inputs: [], servers: {}, tail: 1 });
    const doc = renderedDocument({});
    expect(Object.keys(doc)).toEqual(["inputs", "servers", "tail"]);
  });

  it("creates the document when mcp.json does not exist", () => {
    const doc = renderedDocument({ a: { transport: "http", url: "https://a.test" } });
    expect(Object.keys(doc)).toEqual([VSCODE_SERVERS_KEY]);
  });

  it("ends the rendered file with exactly one newline and no BOM", () => {
    const edits = adapter.renderMcp({});
    expect(edits[0]?.content.endsWith("}\n")).toBe(true);
    expect(edits[0]?.content.startsWith("{")).toBe(true);
  });

  it("never writes (SPEC §6.5)", () => {
    adapter.renderMcp({ a: { transport: "stdio", command: "x" } });
    expect(fs.existsSync(vscodeMcpPath())).toBe(false);
  });

  it("does not add an empty servers key to a file that has none", () => {
    writeMcpJson({ inputs: [] });
    expect(adapter.renderMcp({})).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* sse: skipped means NOT WRITTEN, never REMOVED (SPEC §4, §5)         */
/* ------------------------------------------------------------------ */

describe("sse entries are skipped without being deleted", () => {
  const sseEntry = { type: "sse", url: "https://s.test/sse" };

  it("keeps an existing on-disk sse entry when the source declares it sse", () => {
    writeMcpJson({ servers: { streamer: sseEntry } });
    const doc = renderedDocument({ streamer: { transport: "sse", url: "https://s.test/sse" } });
    expect((doc[VSCODE_SERVERS_KEY] as Record<string, unknown>)["streamer"]).toEqual(sseEntry);
  });

  it("still does not invent an sse entry that mcp.json never had", () => {
    writeMcpJson({ servers: {} });
    const doc = renderedDocument({ streamer: { transport: "sse", url: "https://s.test/sse" } });
    expect(doc[VSCODE_SERVERS_KEY]).toEqual({});
  });

  it("preserves an unmanaged sse extra handed in through options.preserve", () => {
    writeMcpJson({ servers: { streamer: sseEntry } });
    const edits = adapter.renderMcp(
      { fresh: { transport: "stdio", command: "new" } },
      { preserve: { streamer: sseEntry } },
    );
    const servers = (JSON.parse(edits[0]?.content ?? "{}") as Record<string, unknown>)[
      VSCODE_SERVERS_KEY
    ] as Record<string, unknown>;
    expect(servers["streamer"]).toEqual(sseEntry);
    expect(Object.keys(servers).sort()).toEqual(["fresh", "streamer"]);
  });

  it("re-renders a preserved sse entry to identical bytes (no perpetual update)", () => {
    writeMcpJson({ servers: { streamer: sseEntry } });
    const raw = adapter.readRawMcp();
    const first = adapter.renderMcp({}, { preserve: raw })[0]?.content ?? "";
    fs.writeFileSync(vscodeMcpPath(), first);
    expect(adapter.renderMcp({}, { preserve: adapter.readRawMcp() })[0]?.content).toBe(first);
  });
});

describe("readRawMcp", () => {
  it("returns {} without a file or a servers key", () => {
    expect(adapter.readRawMcp()).toEqual({});
    writeMcpJson({ inputs: [] });
    expect(adapter.readRawMcp()).toEqual({});
  });

  it("returns entries verbatim, unknown keys included", () => {
    const entry = { type: "stdio", command: "x", envFile: ".env", dev: { watch: true } };
    writeMcpJson({ servers: { a: entry } });
    expect(adapter.readRawMcp()).toEqual({ a: entry });
  });

  it("throws when an entry is not an object (SPEC §6.3)", () => {
    writeMcpJson({ servers: { a: 5 } });
    expect(() => adapter.readRawMcp()).toThrow(AmError);
  });
});

describe("read failures throw rather than becoming empty data (SPEC §6.3)", () => {
  it("returns {} when mcp.json is missing", () => {
    expect(adapter.readMcp()).toEqual({});
  });

  it("throws on invalid JSON", () => {
    writeMcpJson("{ not json");
    expect(() => adapter.readMcp()).toThrow(AmError);
  });

  it("throws when the document is not an object", () => {
    writeMcpJson([1, 2]);
    expect(() => adapter.readMcp()).toThrow(AmError);
  });

  it("throws when servers is not an object", () => {
    writeMcpJson({ servers: [] });
    expect(() => adapter.readMcp()).toThrow(AmError);
  });

  it("throws on an unknown transport type", () => {
    writeMcpJson({ servers: { x: { type: "carrier-pigeon", command: "x" } } });
    expect(() => adapter.readMcp()).toThrow(AmError);
  });

  it("throws when a server entry has neither type nor a recognisable shape", () => {
    writeMcpJson({ servers: { x: { note: "hi" } } });
    expect(() => adapter.readMcp()).toThrow(AmError);
  });

  it("throws on a non-array args", () => {
    writeMcpJson({ servers: { x: { type: "stdio", command: "x", args: "one two" } } });
    expect(() => adapter.readMcp()).toThrow(AmError);
  });

  /*
   * SPEC §6.3: `args` gets the same treatment as `env` and `headers`. It used
   * to be the one asymmetric field — `String({...})` turned a structured entry
   * into the literal argument "[object Object]".
   */
  it("throws on a non-scalar arg rather than stringifying it", () => {
    writeMcpJson({ servers: { x: { type: "stdio", command: "x", args: [{ flag: "-y" }] } } });
    expect(() => adapter.readMcp()).toThrow(AmError);
    writeMcpJson({ servers: { x: { type: "stdio", command: "x", args: [["-y"]] } } });
    expect(() => adapter.readMcp()).toThrow(AmError);
  });

  it("still coerces scalar args, as env and headers do", () => {
    writeMcpJson({ servers: { x: { type: "stdio", command: "x", args: ["-p", 8080, true] } } });
    expect(adapter.readMcp()["x"]?.args).toEqual(["-p", "8080", "true"]);
  });

  it("refuses to render on top of a non-object document", () => {
    writeMcpJson("[1,2]");
    expect(() => adapter.renderMcp({})).toThrow(AmError);
  });

  it("treats a missing servers key as no servers", () => {
    writeMcpJson({ inputs: [] });
    expect(adapter.readMcp()).toEqual({});
  });

  it("infers the transport when type is absent", () => {
    writeMcpJson({ servers: { a: { command: "x" }, b: { url: "https://b.test" } } });
    expect(adapter.readMcp()).toEqual({
      a: { transport: "stdio", command: "x" },
      b: { transport: "http", url: "https://b.test" },
    });
  });

  it("coerces scalar env values to strings", () => {
    writeMcpJson({ servers: { a: { type: "stdio", command: "x", env: { PORT: 8080 } } } });
    expect(adapter.readMcp()).toEqual({
      a: { transport: "stdio", command: "x", env: { PORT: "8080" } },
    });
  });
});

describe("shared discovery: agents and skills need no work (SPEC §4)", () => {
  function writeAgent(name: string, text: string): void {
    const dir = copilotAgentsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}${VSCODE_AGENT_EXTENSION}`), text);
  }

  it("reads agents from the copilot-cli directory, sorted", () => {
    writeAgent("zeta", "---\nname: zeta\ndescription: Z\ntools: [Read, Grep]\n---\nbody z\n");
    writeAgent("alpha", "---\nname: alpha\ndescription: A\n---\nbody a\n");
    const agents = adapter.readAgents();
    expect(agents.map((a) => a.name)).toEqual(["alpha", "zeta"]);
    expect(agents[1]?.tools).toEqual(["Read", "Grep"]);
  });

  it("falls back to the file name and tolerates a missing description", () => {
    writeAgent("nameless", "no frontmatter here\n");
    expect(adapter.readAgents()[0]?.name).toBe("nameless");
  });

  it("ignores files without the .agent.md extension", () => {
    writeAgent("real", "---\nname: real\ndescription: R\n---\nb\n");
    fs.writeFileSync(path.join(copilotAgentsDir(), "notes.md"), "---\nname: notes\n---\n");
    expect(adapter.readAgents().map((a) => a.name)).toEqual(["real"]);
  });

  it("returns an empty list when the shared directory is missing", () => {
    expect(adapter.readAgents()).toEqual([]);
  });

  it("renders no agent files: copilot-cli owns that directory", () => {
    expect(adapter.renderAgents([{ name: "a", description: "d", body: "b" }])).toEqual([]);
  });

  it("plans no skill work: VS Code discovers the source directly", () => {
    expect(adapter.planSkills([{ name: "s", sourcePath: sourceSkillDirFor("s") }])).toEqual([]);
  });

  it("reports the skill source contents as real directories", () => {
    fs.mkdirSync(path.join(sourceSkillsDir(), "beta"), { recursive: true });
    fs.mkdirSync(path.join(sourceSkillsDir(), "alpha"), { recursive: true });
    const links = adapter.readSkillLinks();
    expect(links.map((l) => l.name)).toEqual(["alpha", "beta"]);
    expect(links.every((l) => l.kind === "directory")).toBe(true);
  });

  it("returns an empty list when the skill source is missing", () => {
    expect(adapter.readSkillLinks()).toEqual([]);
  });

  it("classifies a junction and records its destination", () => {
    const real = path.join(tmp, "real-skill");
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(sourceSkillsDir(), { recursive: true });
    const link = path.join(sourceSkillsDir(), "linked");
    try {
      fs.symlinkSync(real, link, "junction");
    } catch {
      return; // no privilege to create links on this machine
    }
    const found = adapter.readSkillLinks().find((l) => l.name === "linked");
    expect(found?.kind === "junction" || found?.kind === "symlink").toBe(true);
    expect(found?.linkTarget).toBeDefined();
  });
});

function sourceSkillDirFor(name: string): string {
  return path.join(sourceSkillsDir(), name);
}
