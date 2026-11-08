/**
 * The scope layer against a fictional machine (design §14 「単位」「発見」).
 *
 * Every name, path and count here is made up. The fake HOME holds a Claude
 * record that mixes a real repository, a linked worktree, a vanished folder, a
 * temp folder, the home folder and a folder outside git, plus Copilot sessions
 * whose first line names a folder — and secrets in the keys discovery must not
 * read, which are then looked for in every output.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../cli.js";
import { bufferIo } from "../commands/context.js";
import { copilotInstructionText, copilotSkillText, costOf } from "./cost.js";
import { claudeTranscriptName, discoverProjects, projectId, readProjectSettings } from "./discover.js";
import { findRepo } from "./gitroot.js";
import { readInstalled, type InstalledRow } from "./installed.js";
import { importRefs } from "./readers.js";

let home: string;
let work: string;

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function skill(dir: string, name: string, description: string, extra = ""): void {
  write(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n${extra}---\nbody of ${name}\n`);
}

const SECRETS = ["SECRET-ENV-VALUE", "someone@example.invalid", "oauthAccount", "sk-fake-api-key"];

function seed(): { repoA: string; worktree: string; repoB: string; repoC: string; plain: string } {
  const repoA = path.join(work, "alpha-app");
  const worktree = path.join(work, "alpha-app-wt");
  const repoB = path.join(work, "beta-lib");
  const repoC = path.join(work, "gamma-tool");
  const plain = path.join(work, "loose-notes");
  fs.mkdirSync(path.join(repoA, ".git", "worktrees", "wt"), { recursive: true });
  write(path.join(repoA, ".git", "worktrees", "wt", "commondir"), "../..\n");
  write(path.join(worktree, ".git"), `gitdir: ${path.join(repoA, ".git", "worktrees", "wt")}\n`);
  fs.mkdirSync(path.join(repoB, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repoB, "sub"), { recursive: true });
  fs.mkdirSync(path.join(repoC, ".git"), { recursive: true });
  fs.mkdirSync(plain, { recursive: true });
  const temp = path.join(home, "AppData", "Local", "Temp", "scratch");
  fs.mkdirSync(temp, { recursive: true });

  write(
    path.join(home, ".claude.json"),
    JSON.stringify({
      oauthAccount: { emailAddress: "someone@example.invalid" },
      primaryApiKey: "sk-fake-api-key",
      mcpServers: { "user-mcp": { command: "node", args: ["x.js"], env: { TOKEN: "SECRET-ENV-VALUE" } } },
      projects: {
        [repoA.replace(/\\/g, "/")]: {
          mcpServers: { "local-mcp": { type: "http", url: "http://127.0.0.1:1/", headers: { Authorization: "SECRET-ENV-VALUE" } } },
          enabledMcpjsonServers: ["shared-mcp"],
          lastCost: 1,
        },
        [worktree]: {},
        [path.join(work, "vanished")]: {},
        [temp]: {},
        [home]: {},
        [plain]: {},
      },
      githubRepoPaths: { "example/beta-lib": [repoB] },
    }),
  );
  // Claude's transcript directory for repo A: the newest use.
  const transcript = path.join(home, ".claude", "projects", claudeTranscriptName(repoA), "s.jsonl");
  write(transcript, "{}\n");
  fs.utimesSync(transcript, new Date("2030-01-03T00:00:00Z"), new Date("2030-01-03T00:00:00Z"));

  // Copilot sessions: one with an events file, one with only a workspace.yaml, one with nothing.
  const s1 = path.join(home, ".copilot", "session-state", "s1", "events.jsonl");
  write(s1, `${JSON.stringify({ type: "session.start", data: { context: { cwd: path.join(repoB, "sub"), gitRoot: repoB } } })}\n{"type":"x"}\n`);
  fs.utimesSync(s1, new Date("2030-01-02T00:00:00Z"), new Date("2030-01-02T00:00:00Z"));
  const s2 = path.join(home, ".copilot", "session-state", "s2", "workspace.yaml");
  write(s2, `id: s2\ncwd: ${repoC}\nsummary: |-\n  SECRET-ENV-VALUE should not leak\n`);
  fs.utimesSync(s2, new Date("2030-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z"));
  fs.mkdirSync(path.join(home, ".copilot", "session-state", "s3"), { recursive: true });
  // The file Copilot keeps credentials and trusted folders in. It must never be read.
  write(path.join(home, ".copilot", "config.json"), '{"auth":"SECRET-ENV-VALUE"}');
  return { repoA, worktree, repoB, repoC, plain };
}

function seedAssets(repoA: string): void {
  // user: one skill shared by link between Claude and Copilot, one per harness
  skill(path.join(home, ".agents", "skills"), "linked-skill", "Shared by a link.");
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  fs.symlinkSync(path.join(home, ".agents", "skills", "linked-skill"), path.join(home, ".claude", "skills", "linked-skill"), "junction");
  skill(path.join(home, ".claude", "skills"), "claude-only", "Only for Claude.", "disable-model-invocation: true\n");
  skill(path.join(home, ".claude", "skills"), "quiet-skill", "Hidden by an override.");
  skill(path.join(home, ".claude", "skills", "synced", "bucket-1"), "synced-skill", "From claude.ai.");
  skill(path.join(home, ".copilot", "skills"), "copilot-only", "日本語の説明");
  write(path.join(home, ".claude", "settings.json"), JSON.stringify({ skillOverrides: { "quiet-skill": "off" }, env: { KEY: "SECRET-ENV-VALUE" } }));
  write(path.join(home, ".copilot", "settings.json"), '// JSONC\n{ "disabledSkills": [], "enabledPlugins": { "tool-pack@demo-market": true }, }\n');
  write(path.join(home, ".copilot", "installed-plugins", "demo-market", "tool-pack", "plugin.json"), JSON.stringify({ name: "tool-pack", version: "1.2.3" }));
  skill(path.join(home, ".copilot", "installed-plugins", "demo-market", "tool-pack", "skills"), "pack-skill", "From the pack.");
  write(path.join(home, ".copilot", "mcp-config.json"), JSON.stringify({ mcpServers: { "copilot-mcp": { command: "node", env: { T: "SECRET-ENV-VALUE" } } } }));
  write(path.join(home, ".claude", "CLAUDE.md"), "User rules for Claude.\n@~/.agents/AGENTS.md\n");
  write(path.join(home, ".agents", "AGENTS.md"), "Imported body.\n");
  write(path.join(home, ".copilot", "copilot-instructions.md"), "User rules for Copilot.\n");
  write(path.join(home, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reviews code.\n---\nbody\n");
  write(path.join(home, ".claude", "commands", "ship.md"), "# Ship the build\nsteps\n");

  // project A
  write(path.join(repoA, "CLAUDE.md"), "Project rules.\n@AGENTS.md\n");
  write(path.join(repoA, "AGENTS.md"), "Agents rules.\n");
  write(path.join(repoA, "CLAUDE.local.md"), "Local notes.\n");
  write(path.join(repoA, ".github", "copilot-instructions.md"), "Copilot repo rules.\n");
  write(path.join(repoA, ".github", "instructions", "py.instructions.md"), '---\napplyTo: "**/*.py"\n---\nPython rules.\n');
  write(path.join(repoA, ".github", "instructions", "all.instructions.md"), "Always rules.\n");
  skill(path.join(repoA, ".claude", "skills"), "shared-skill", "Read by both.");
  skill(path.join(repoA, ".github", "skills"), "gh-skill", "Only Copilot.");
  write(path.join(repoA, ".github", "copilot", "settings.json"), JSON.stringify({ disabledSkills: ["gh-skill"] }));
  write(path.join(repoA, ".mcp.json"), JSON.stringify({ mcpServers: { "shared-mcp": { command: "node", env: { X: "SECRET-ENV-VALUE" } } } }));
  write(path.join(repoA, ".github", "mcp.json"), JSON.stringify({ mcpServers: { "shadowed-mcp": { command: "node" } } }));
  write(path.join(repoA, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "declared@demo-market": true } }));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-scope-home-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "ac-scope-work-"));
  process.env["AC_HOME"] = home;
});

afterEach(() => {
  delete process.env["AC_HOME"];
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

describe("findRepo", () => {
  it("finds the top level from a subfolder, and folds a worktree into its main checkout", () => {
    const { repoA, worktree, repoB } = seed();
    expect(findRepo(path.join(repoB, "sub"))).toEqual({ root: repoB, mainRoot: repoB, isWorktree: false });
    expect(findRepo(worktree)).toEqual({ root: worktree, mainRoot: repoA, isWorktree: true });
  });

  it("treats a .git file without commondir (a submodule) as its own repository", () => {
    const sub = path.join(work, "outer", "mod");
    fs.mkdirSync(path.join(work, "outer", ".git", "modules", "mod"), { recursive: true });
    write(path.join(sub, ".git"), "gitdir: ../.git/modules/mod\n");
    expect(findRepo(sub)).toEqual({ root: sub, mainRoot: sub, isWorktree: false });
  });

  it("returns null outside git (negative control)", () => {
    fs.mkdirSync(path.join(work, "x"));
    // The temp root itself may sit inside a repository on some machines; only claim what we see.
    const found = findRepo(path.join(work, "x"));
    if (found !== null) expect(found.root.startsWith(work)).toBe(false);
  });
});

describe("project discovery", () => {
  it("narrows the records as design §5.1 says", () => {
    const { repoA, repoB, repoC, plain } = seed();
    const r = discoverProjects();
    const byRoot = new Map(r.projects.map((p) => [p.root, p]));
    expect([...byRoot.keys()].sort()).toEqual([repoA, repoB, repoC, plain].sort());
    expect(byRoot.get(repoA)!.worktrees).toBe(1);
    expect(byRoot.get(repoB)!.sources).toEqual(["claude", "copilot"]);
    expect(byRoot.get(repoC)!.sources).toEqual(["copilot"]);
    expect(byRoot.get(plain)!.git).toBe(false);
    expect(r.counts).toMatchObject({ missing: 1, excluded: 2, nonGit: 1, worktreesMerged: 1, listed: 4 });
    // 6 project keys + 1 githubRepoPaths + 2 Copilot folders (repoB is named twice).
    expect(r.counts.candidates).toBe(8);
    // Newest first: A (2030-01-03) > B (01-02) > C (01-01) > the folder with no recorded use.
    expect(r.projects.map((p) => p.root)).toEqual([repoA, repoB, repoC, plain]);
    expect(byRoot.get(repoA)!.lastUsed).toBe("2030-01-03T00:00:00.000Z");
    expect(byRoot.get(repoA)!.id).toBe(projectId(repoA));
  });

  it("uses the cache on the second run and rereads with --refresh", () => {
    seed();
    expect(discoverProjects().cache).toBe("miss");
    expect(discoverProjects().cache).toBe("hit");
    expect(discoverProjects({ refresh: true }).cache).toBe("miss");
    expect(fs.existsSync(path.join(home, ".agent-console", "cache", "projects.json"))).toBe(true);
  });

  it("keeps pins on top, hides on request, and adds a folder by hand", () => {
    const { repoC, plain } = seed();
    const io = bufferIo();
    expect(main(["node", "ac", "projects", "pin", projectId(repoC), "--json"], { io })).toBe(0);
    const extra = path.join(work, "by-hand");
    fs.mkdirSync(extra);
    expect(main(["node", "ac", "projects", "add", extra, "--json"], { io: bufferIo() })).toBe(0);
    expect(main(["node", "ac", "projects", "hide", projectId(plain), "--json"], { io: bufferIo() })).toBe(0);
    const r = discoverProjects();
    expect(r.projects[0]!.root).toBe(repoC);
    expect(r.projects[0]!.pinned).toBe(true);
    expect(r.projects.find((p) => p.root === extra)!.sources).toEqual(["manual"]);
    expect(r.projects.find((p) => p.root === plain)!.hidden).toBe(true);
    expect(readProjectSettings()).toMatchObject({ version: 1, pinned: [repoC], added: [extra], hidden: [plain] });
  });

  it("refuses to overwrite a projects.json it cannot read (SPEC §6.3)", () => {
    const { repoC } = seed();
    write(path.join(home, ".agent-console", "projects.json"), "{ not json");
    const io = bufferIo();
    expect(main(["node", "ac", "projects", "pin", projectId(repoC)], { io })).toBe(2);
    expect(fs.readFileSync(path.join(home, ".agent-console", "projects.json"), "utf8")).toBe("{ not json");
    expect(discoverProjects().settingsError).toMatch(/projects\.json/);
  });

  it("never puts the keys it must not read into its output, and never reads config.json", () => {
    seed();
    const io = bufferIo();
    expect(main(["node", "ac", "projects", "--json"], { io })).toBe(0);
    const out = io.text() + io.errors.join("\n") + fs.readFileSync(path.join(home, ".agent-console", "cache", "projects.json"), "utf8");
    for (const s of SECRETS) expect(out).not.toContain(s);
  });
});

describe("Installed", () => {
  function rows(): { all: InstalledRow[]; find: (kind: string, name: string, scope?: string) => InstalledRow } {
    const { repoA } = seed();
    seedAssets(repoA);
    discoverProjects();
    const r = readInstalled({ root: repoA });
    return {
      all: r.rows,
      find: (kind, name, scope) => {
        const row = r.rows.find((x) => x.kind === kind && x.name === name && (scope === undefined || x.scope === scope));
        if (row === undefined) throw new Error(`no row ${kind} ${name} ${scope ?? ""}`);
        return row;
      },
    };
  }
  const reach = (row: InstalledRow, h: string) => row.reach.find((r) => r.harness === h);

  it("puts a skill shared by a link into one row that both harnesses reach", () => {
    const { find, all } = rows();
    const linked = find("skill", "linked-skill", "user");
    expect(linked.reach.map((r) => r.harness).sort()).toEqual(["claude", "copilot"]);
    expect(linked.realPath).toBeDefined();
    expect(all.filter((r) => r.name === "linked-skill")).toHaveLength(1);
    expect(reach(find("skill", "shared-skill", "project"), "copilot")!.state).toBe("enabled");
    expect(reach(find("skill", "shared-skill", "project"), "claude")!.state).toBe("enabled");
  });

  it("applies the switches: skillOverrides, disable-model-invocation, disabledSkills", () => {
    const { find } = rows();
    expect(reach(find("skill", "quiet-skill"), "claude")).toMatchObject({ state: "disabled", cost: { chars: 0 } });
    expect(reach(find("skill", "claude-only"), "claude")!.cost!.chars).toBe(0);
    expect(reach(find("skill", "gh-skill", "project"), "copilot")).toMatchObject({ state: "disabled" });
    expect(reach(find("skill", "gh-skill", "project"), "copilot")!.stateSource).toContain("settings.json#disabledSkills");
    expect(find("skill", "synced-skill").origin).toBe("synced");
  });

  it("counts Copilot's skill cost in the measured shape, Japanese by code point", () => {
    const { find } = rows();
    const r = reach(find("skill", "copilot-only"), "copilot")!;
    expect(r.cost).toEqual(costOf(copilotSkillText("copilot-only", "日本語の説明", "user")));
    expect(costOf("日本語abc")).toEqual({ chars: 6, tokens: 4 });
  });

  it("reads the instruction files each harness loads, with imports and applyTo", () => {
    const { find } = rows();
    const user = find("instructions", "CLAUDE.md", "user");
    expect(user.imports).toHaveLength(1);
    expect(reach(user, "claude")!.cost!.chars).toBe(costOf("User rules for Claude.\n@~/.agents/AGENTS.md\n\nImported body.\n").chars);
    const agents = find("instructions", "AGENTS.md", "project");
    expect(reach(agents, "claude")!.state).toBe("via-import");
    expect(reach(agents, "copilot")!.state).toBe("enabled");
    expect(reach(find("instructions", "py.instructions.md"), "copilot")!.state).toBe("conditional");
    expect(reach(find("instructions", "all.instructions.md"), "copilot")!.state).toBe("enabled");
    const local = find("instructions", "CLAUDE.local.md", "local");
    expect(reach(local, "claude")!.state).toBe("enabled");
    expect(reach(local, "copilot")!.state).toBe("not-loaded");
  });

  it("reads MCP by name and transport only, per unit, with each harness's state", () => {
    const { find } = rows();
    const shared = find("mcp", "shared-mcp", "project");
    expect(reach(shared, "claude")!.state).toBe("enabled");
    expect(reach(shared, "copilot")!.state).toBe("unknown");
    expect(reach(find("mcp", "shadowed-mcp", "project"), "copilot")!.state).toBe("not-loaded");
    expect(find("mcp", "local-mcp", "local").transport).toBe("http");
    expect(find("mcp", "user-mcp", "user").transport).toBe("stdio");
    expect(find("mcp", "copilot-mcp", "user").reach[0]!.harness).toBe("copilot");
  });

  it("reads plugins from the install records and the settings that declare them", () => {
    const { find } = rows();
    const pack = find("plugin", "tool-pack@demo-market", "user");
    expect(pack).toMatchObject({ version: "1.2.3", components: { skills: ["tool-pack:pack-skill"] } });
    expect(reach(pack, "copilot")!.state).toBe("enabled");
    const declared = find("plugin", "declared@demo-market", "project");
    expect(declared.findings![0]!.code).toBe("plugin.enabled-not-installed");
  });

  it("sums the totals from the enabled reaches only", () => {
    const { repoA } = seed();
    seedAssets(repoA);
    const r = readInstalled({ root: repoA });
    for (const t of r.totals) {
      const expected = r.rows
        .filter((row) => row.scope === t.scope)
        .flatMap((row) => row.reach.filter((x) => x.harness === t.harness && x.state === "enabled" && x.cost !== undefined))
        .reduce((n, x) => n + x.cost!.chars, 0);
      expect(t.chars, `${t.scope}/${t.harness}`).toBe(expected);
    }
    expect(r.totals.find((t) => t.scope === "project" && t.harness === "copilot")!.conditional).toBe(1);
  });

  it("shows only the user unit without a project", () => {
    seed();
    const r = readInstalled();
    expect(r.scopes).toEqual(["user"]);
    expect(r.rows.every((row) => row.scope === "user")).toBe(true);
  });

  it("leaks no secret, never reads config.json, and writes nothing in the harness directories", () => {
    const { repoA } = seed();
    seedAssets(repoA);
    discoverProjects();
    const snapshot = (dir: string): string[] =>
      fs.readdirSync(dir, { recursive: true, withFileTypes: true }).map((e) => {
        const p = path.join(e.parentPath, e.name);
        return `${p}:${fs.lstatSync(p).mtimeMs}`;
      });
    const before = [...snapshot(path.join(home, ".claude")), ...snapshot(path.join(home, ".copilot")), ...snapshot(repoA)];
    const io = bufferIo();
    expect(main(["node", "ac", "installed", "--project", projectId(repoA), "--json"], { io })).toBe(0);
    const out = io.text();
    for (const s of SECRETS) expect(out).not.toContain(s);
    const payload = JSON.parse(out) as { sources: { path: string }[] };
    expect(payload.sources.some((s) => path.basename(s.path) === "config.json")).toBe(false);
    const after = [...snapshot(path.join(home, ".claude")), ...snapshot(path.join(home, ".copilot")), ...snapshot(repoA)];
    expect(after).toEqual(before);
  });

  it("refuses an unknown project id (exit 2)", () => {
    seed();
    expect(main(["node", "ac", "installed", "--project", "0123456789ab", "--json"], { io: bufferIo() })).toBe(2);
  });
});

describe("@import references", () => {
  it("takes paths and skips mentions and code", () => {
    expect(importRefs("see @AGENTS.md and @~/x/y.md\n`@not/this.md`\n```\n@nor/this.md\n```\nmail @someone")).toEqual([
      "AGENTS.md",
      "~/x/y.md",
    ]);
  });
});

describe("static guards", () => {
  it("the scope layer never names ~/.copilot/config.json and never starts a process", () => {
    const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      expect(text, f).not.toMatch(/copilotSelfManagedConfigPath|child_process/);
    }
  });
});

describe("review fixes (L2)", () => {
  it("never quotes ~/.claude.json's text in a parse error", () => {
    write(path.join(home, ".claude.json"), '{"primaryApiKey": sk-fake-api-key-UNQUOTED, "projects": {}}');
    const r = discoverProjects();
    const s = r.sources.find((x) => x.label === "claude.json#projects")!;
    expect(s.status).toBe("unreadable");
    expect(JSON.stringify(r)).not.toContain("sk-fake");
    expect(s.detail).toMatch(/^JSON の構文エラー/);
  });

  it("does not count an instruction file whose frontmatter is broken, and marks the row", () => {
    const { repoA } = seed();
    write(path.join(repoA, ".github", "instructions", "bad.instructions.md"), '---\napplyTo: "**/*.ts\nx: [\n---\n' + "y".repeat(500) + "\n");
    write(path.join(repoA, ".claude", "rules", "bad.md"), "---\npaths: [src/\n---\nrule body\n");
    const r = readInstalled({ root: repoA });
    for (const name of ["bad.instructions.md", "bad.md"]) {
      const row = r.rows.find((x) => x.name === name)!;
      expect(row.unreadable, name).toBeDefined();
      expect(row.reach[0]!.state, name).toBe("unknown");
    }
    expect(r.totals.find((t) => t.scope === "project" && t.harness === "copilot")!.chars).toBe(0);
    expect(r.totals.find((t) => t.scope === "project" && t.harness === "claude")!.chars).toBe(0);
  });

  it("counts a skill reached through two paths by the same harness once", () => {
    seed();
    skill(path.join(home, ".agents", "skills"), "twice", "Linked into ~/.copilot/skills too.");
    fs.mkdirSync(path.join(home, ".copilot", "skills"), { recursive: true });
    fs.symlinkSync(path.join(home, ".agents", "skills", "twice"), path.join(home, ".copilot", "skills", "twice"), "junction");
    const r = readInstalled();
    const row = r.rows.find((x) => x.name === "twice")!;
    expect(row.reach.filter((x) => x.harness === "copilot")).toHaveLength(2);
    const one = row.reach.find((x) => x.harness === "copilot")!.cost!.chars;
    expect(r.totals.find((t) => t.harness === "copilot")!.chars).toBe(one);
  });

  it("reads a session again once a file that named no folder has been written", () => {
    seed();
    const events = path.join(home, ".copilot", "session-state", "late", "events.jsonl");
    write(events, "");
    fs.utimesSync(events, new Date("2030-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z"));
    discoverProjects();
    const repo = path.join(work, "late-repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    write(events, `${JSON.stringify({ type: "session.start", data: { context: { cwd: repo } } })}\n`);
    expect(discoverProjects().projects.some((p) => p.root === repo)).toBe(true);
  });

  it("counts Copilot's imports in the measured shape (the imported file is also loaded on its own)", () => {
    const { repoA } = seed();
    seedAssets(repoA);
    const r = readInstalled({ root: repoA });
    const claudeMd = r.rows.find((x) => x.kind === "instructions" && x.scope === "project" && x.path === path.join(repoA, "CLAUDE.md"))!;
    const expected = costOf(
      copilotInstructionText("Project rules.\n@AGENTS.md\n", [{ path: path.join(repoA, "AGENTS.md"), text: "Agents rules.\n" }]),
    );
    expect(claudeMd.reach.find((x) => x.harness === "copilot")!.cost).toEqual(expected);
  });

  it("refuses a network path and an excluded folder for `projects add`", () => {
    seed();
    expect(main(["node", "ac", "projects", "add", "\\\\server\\share"], { io: bufferIo() })).toBe(2);
    expect(main(["node", "ac", "projects", "add", "//server/share"], { io: bufferIo() })).toBe(2);
    expect(main(["node", "ac", "projects", "add", home], { io: bufferIo() })).toBe(2);
    expect(fs.existsSync(path.join(home, ".agent-console", "projects.json"))).toBe(false);
  });
});
