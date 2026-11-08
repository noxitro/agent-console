/**
 * The scope layer (ARCHITECTURE.md「単位とプロジェクト」): project discovery,
 * the project and local listings, and precedence — against a fake HOME and fake
 * repositories, with a positive and a negative control for every rule.
 *
 * Also pinned here: the layer leaves `inventory` alone (the 個人 unit behaves
 * exactly as before), `inventory` writes nothing, `scopes` writes only its
 * cache, and nothing but folder names leaves the record files it reads.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { bufferIo } from "../src/commands/context.js";
import { buildScopes, type ScopesJson } from "../src/commands/scopes.js";
import { cwdLine, discoverProjects, gitRootOf } from "../src/core/projects.js";
import { isWrite, validateArgs } from "../src/server/vocabulary.js";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env["AM_HOME"];
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ac-scopes-")));
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

function writeJson(relative: string, value: unknown): string {
  return write(relative, `${JSON.stringify(value, null, 2)}\n`);
}

/** A git working tree under the fake HOME (`.git` as a directory, as in a clone). */
function repo(relative: string): string {
  const root = path.join(home, ...relative.split("/"));
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  return root;
}

const SECRET = "secret-account@example.invalid";
const PROMPT = "PRIVATE-SESSION-PROMPT-TEXT";

function claudeJson(projects: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
  writeJson(".claude.json", { oauthAccount: { emailAddress: SECRET }, ...extra, projects });
}

function copilotSession(id: string, cwd: string): void {
  write(
    `.copilot/session-state/${id}/workspace.yaml`,
    `id: ${id}\ncwd: ${cwd}\nname: ${PROMPT}\nsummary_count: 0\n`,
  );
}

function vscodeWorkspace(hash: string, folder: string): void {
  writeJson(`AppData/Roaming/Code/User/workspaceStorage/${hash}/workspace.json`, {
    folder: pathToFileURL(folder).href,
  });
}

function runCli(argv: string[]): { code: number; out: string[] } {
  const io = bufferIo();
  const code = main(["node", "ac", ...argv], { io });
  return { code, out: io.lines };
}

function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(`${path.relative(home, full)}:${fs.statSync(full).mtimeMs}`);
    }
  };
  walk(dir);
  return out.sort();
}

/* ------------------------------------------------------------------ */
/* Discovery (S16)                                                     */
/* ------------------------------------------------------------------ */

describe("project discovery", () => {
  it("collects the folders the three harnesses recorded and keeps the git working trees", () => {
    const web = repo("work/web");
    const api = repo("work/api");
    fs.mkdirSync(path.join(api, "src"), { recursive: true });
    const notGit = path.join(home, "work/plain");
    fs.mkdirSync(notGit, { recursive: true });

    claudeJson({ [web.split(path.sep).join("/")]: {}, [notGit]: {} });
    // A session in a subfolder belongs to the tree above it.
    copilotSession("s1", path.join(api, "src"));
    copilotSession("s2", path.join(home, "work/gone"));
    vscodeWorkspace("h1", web);

    const result = discoverProjects();
    expect(result.projects.map((p) => p.root).sort()).toEqual([api, web].sort());
    expect(result.projects.find((p) => p.root === web)?.sources).toEqual(["claude", "vscode"]);
    expect(result.projects.find((p) => p.root === api)?.sources).toEqual(["copilot-cli"]);
    // Negative controls, counted rather than dropped silently.
    expect(result.missing).toBe(1);
    expect(result.outsideGit).toBe(1);
    expect(result.faults).toEqual([]);
  });

  it("accepts a `.git` file (a linked worktree) and finds the root from below", () => {
    const root = path.join(home, "wt");
    fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git"), "gitdir: ../main/.git/worktrees/wt\n");
    expect(gitRootOf(path.join(root, "a", "b"))).toBe(root);
  });

  it("reads only the top-level cwd line of a session file", () => {
    expect(cwdLine("id: x\ncwd: E:\\dev\\repo\nname: whatever\n")).toBe("E:\\dev\\repo");
    expect(cwdLine("cwd: 'C:\\a b\\c'\n")).toBe("C:\\a b\\c");
    // An indented `cwd:` inside another block is not the session's folder.
    expect(cwdLine("summary: |\n  cwd: /not/this\n")).toBeUndefined();
    expect(cwdLine("name: no folder here\n")).toBeUndefined();
  });

  it("reports an unreadable ~/.claude.json instead of treating it as empty", () => {
    write(".claude.json", "{ not json");
    const result = discoverProjects();
    expect(result.faults).toHaveLength(1);
    expect(result.faults[0]?.source).toBe("claude");
    expect(result.cached).toBe(false);
  });

  it("answers from the cache when nothing changed, and opens only new sessions when one is added", () => {
    const a = repo("work/a");
    const b = repo("work/b");
    copilotSession("s1", a);

    const cold = discoverProjects();
    expect(cold.cached).toBe(false);
    expect(fs.existsSync(path.join(home, ".agent-console", "projects-cache.json"))).toBe(true);

    const warm = discoverProjects();
    expect(warm.cached).toBe(true);
    expect(warm.projects.map((p) => p.root)).toEqual([a]);

    // A recorded session's folder never changes, so a damaged old entry in the
    // session directory is not reread — but a new one is.
    copilotSession("s2", b);
    const next = discoverProjects();
    expect(next.cached).toBe(false);
    expect(next.projects.map((p) => p.root).sort()).toEqual([a, b].sort());
  });

  it("rebuilds from the records when the cache is damaged", () => {
    const a = repo("work/a");
    copilotSession("s1", a);
    write(".agent-console/projects-cache.json", "garbage");
    const result = discoverProjects();
    expect(result.cached).toBe(false);
    expect(result.projects.map((p) => p.root)).toEqual([a]);
  });

  it("keeps no account data or session text, in the payload or in the cache", () => {
    const a = repo("work/a");
    claudeJson({ [a]: { allowedTools: [], history: [PROMPT] } });
    copilotSession("s1", a);
    const payload = JSON.stringify(buildScopes());
    const cache = fs.readFileSync(path.join(home, ".agent-console", "projects-cache.json"), "utf8");
    for (const text of [payload, cache]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(PROMPT);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Listing and precedence                                              */
/* ------------------------------------------------------------------ */

function byName(result: ScopesJson, name: string, scope?: string) {
  return result.assets.filter((a) => a.name === name && (scope === undefined || a.scope === scope));
}

describe("the project and local scopes", () => {
  let root: string;

  beforeEach(() => {
    root = repo("work/proj");
    claudeJson({
      [root.split(path.sep).join("/")]: {
        mcpServers: { db: { command: "local-db" } },
      },
    });
  });

  it("lists one row per place, with every target documented to read it", () => {
    write("work/proj/.claude/skills/fmt/SKILL.md", "---\nname: fmt\ndescription: Format\n---\nbody\n");
    write("work/proj/.github/agents/rev.agent.md", "---\nname: rev\ndescription: Review\n---\nbody\n");
    writeJson("work/proj/.mcp.json", { mcpServers: { db: { command: "db" }, web: { type: "http", url: "https://x.invalid" } } });
    write("work/proj/.vscode/mcp.json", '// comment\n{ "servers": { "lint": { "type": "stdio", "command": "lint" }, } }\n');

    const result = buildScopes();
    expect(byName(result, "fmt")[0]?.readers.map((r) => r.target)).toEqual(["claude", "copilot-cli", "vscode"]);
    expect(byName(result, "fmt")[0]?.description).toBe("Format");
    expect(byName(result, "rev")[0]?.readers.map((r) => r.target)).toEqual(["copilot-cli", "vscode"]);
    expect(byName(result, "web")[0]?.kindNote).toBe("http");
    // `.vscode/mcp.json` is JSONC, and VS Code's alone (Copilot CLI 1.0.22 dropped it).
    expect(byName(result, "lint")[0]?.readers.map((r) => r.target)).toEqual(["vscode"]);
    // The local scope: ~/.claude.json projects[<path>].mcpServers.
    const local = byName(result, "db", "local")[0];
    expect(local?.entry).toContain("projects[");
    expect(local?.readers.map((r) => r.target)).toEqual(["claude"]);
    expect(result.projects.map((p) => p.root)).toEqual([root]);
  });

  it("skips a directory without SKILL.md, and does not invent a skill for it", () => {
    fs.mkdirSync(path.join(root, ".claude", "skills", "empty"), { recursive: true });
    expect(byName(buildScopes(), "empty")).toEqual([]);
  });

  it("marks a place whose reading is only reported as unverified", () => {
    write("work/proj/.claude/agents/helper.md", "---\nname: helper\ndescription: Help\n---\n");
    const readers = byName(buildScopes(), "helper")[0]?.readers ?? [];
    expect(readers.find((r) => r.target === "copilot-cli")?.unverified).toBe(true);
    // Negative control: Claude and VS Code document it.
    expect(readers.find((r) => r.target === "claude")?.unverified).toBeUndefined();
    expect(readers.find((r) => r.target === "vscode")?.unverified).toBeUndefined();
  });

  it("Claude MCP: local outranks project, and only for Claude", () => {
    writeJson("work/proj/.mcp.json", { mcpServers: { db: { command: "db" } } });
    const project = byName(buildScopes(), "db", "project")[0];
    expect(project?.readers.find((r) => r.target === "claude")?.shadowedBy?.scope).toBe("local");
    // Copilot CLI has no local scope, so its reading of the same file stands.
    expect(project?.readers.find((r) => r.target === "copilot-cli")?.shadowedBy).toBeUndefined();
  });

  it("Claude skills: the user's own skill outranks the project's", () => {
    write("work/proj/.claude/skills/fmt/SKILL.md", "---\nname: fmt\ndescription: Format\n---\n");
    write(".claude/skills/fmt/SKILL.md", "---\nname: fmt\ndescription: Mine\n---\n");
    const readers = byName(buildScopes(), "fmt")[0]?.readers ?? [];
    expect(readers.find((r) => r.target === "claude")?.shadowedBy?.scope).toBe("user");
    // Negative control: Copilot CLI's skill precedence is changelog-only (既報),
    // so nothing is claimed for it even though ~/.copilot/skills is empty anyway.
    expect(readers.find((r) => r.target === "copilot-cli")?.shadowedBy).toBeUndefined();
  });

  it("Claude skills: without a user skill of that name, the project's stands", () => {
    write("work/proj/.claude/skills/fmt/SKILL.md", "---\nname: fmt\ndescription: Format\n---\n");
    write(".claude/skills/other/SKILL.md", "---\nname: other\ndescription: x\n---\n");
    const readers = byName(buildScopes(), "fmt")[0]?.readers ?? [];
    expect(readers.some((r) => r.shadowedBy !== undefined)).toBe(false);
  });

  it("Claude agents: the project's outranks the user's, which is reported as overridden", () => {
    write("work/proj/.claude/agents/rev.md", "---\nname: rev\ndescription: Project\n---\n");
    write(".claude/agents/rev.md", "---\nname: rev\ndescription: Mine\n---\n");
    const result = buildScopes();
    expect(byName(result, "rev")[0]?.readers.find((r) => r.target === "claude")?.shadowedBy).toBeUndefined();
    expect(result.shadows).toEqual([
      expect.objectContaining({ target: "claude", assetType: "agent", name: "rev", project: root }),
    ]);
  });

  it("Copilot CLI agents: the user's outranks the repository's — the other way round", () => {
    write("work/proj/.github/agents/rev.agent.md", "---\nname: rev\ndescription: Project\n---\n");
    write(".copilot/agents/rev.agent.md", "---\nname: rev\ndescription: Mine\n---\n");
    const readers = byName(buildScopes(), "rev")[0]?.readers ?? [];
    expect(readers.find((r) => r.target === "copilot-cli")?.shadowedBy?.scope).toBe("user");
    // VS Code documents no collision rule: no claim.
    expect(readers.find((r) => r.target === "vscode")?.shadowedBy).toBeUndefined();
  });

  it("reports an unreadable project file and still lists the rest", () => {
    write("work/proj/.mcp.json", "{ broken");
    write("work/proj/.claude/skills/fmt/SKILL.md", "---\nname: fmt\ndescription: Format\n---\n");
    const result = buildScopes();
    expect(result.faults.some((f) => f.path.endsWith(".mcp.json"))).toBe(true);
    expect(byName(result, "fmt")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* The 個人 unit is unchanged; writes are confined                       */
/* ------------------------------------------------------------------ */

describe("the scope layer leaves the user level alone", () => {
  it("inventory --json is byte-identical with and without projects to discover", () => {
    write(".agents/skills/demo/SKILL.md", "---\nname: demo\ndescription: d\n---\n");
    const before = runCli(["inventory", "--json"]);
    const root = repo("work/proj");
    write("work/proj/.claude/skills/demo/SKILL.md", "---\nname: demo\ndescription: p\n---\n");
    copilotSession("s1", root);
    const after = runCli(["inventory", "--json"]);
    expect(after.code).toBe(0);
    // Positive control first: there is a payload to compare, and it lists the skill.
    expect(before.out).toHaveLength(1);
    expect(before.out[0]).toContain('"demo"');
    expect(after.out).toEqual(before.out);
  });

  it("inventory writes nothing; scopes writes only its cache", () => {
    const root = repo("work/proj");
    copilotSession("s1", root);
    const start = listTree(home);
    runCli(["inventory", "--json"]);
    expect(listTree(home)).toEqual(start);

    const result = runCli(["scopes", "--json"]);
    expect(result.code).toBe(0);
    expect(result.out).toHaveLength(1);
    const added = listTree(home).filter((entry) => !start.includes(entry));
    expect(added.map((e) => e.split(":")[0])).toEqual([path.join(".agent-console", "projects-cache.json")]);
  });

  it("is in the API vocabulary as a read", () => {
    expect(validateArgs(["scopes"]).ok).toBe(true);
    expect(isWrite(["scopes"])).toBe(false);
  });
});
