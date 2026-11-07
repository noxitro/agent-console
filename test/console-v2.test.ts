/**
 * SPEC §9 — the engine half of the management console.
 *
 * Every test here pins a defect that was found by review, not a feature that
 * merely happens to work:
 *
 *  - §9.1 manifest v2: a `version: 2` file used to make **every** command exit 2,
 *    and `mcp.exclude` / `agents.exclude` in a v1 file were read by nobody, so
 *    an asset the owner had switched off went on being delivered.
 *  - §9.2 `enable` / `disable` / `remove`: unknown commands, which left the
 *    console's enable toggle and delete button with nothing to call.
 *  - §9.3 inventory arrays: MCP and agents were a bare count, so no console
 *    could list an individual server or agent, let alone derive its state.
 *  - §5 preserve-vs-delete: an unmanaged MCP server (Claude Code registers one
 *    on its own) made `plan` exit 1 forever — SPEC §8's fixed point was
 *    unreachable — and made the GUI's confirmation dialog promise a deletion
 *    that `apply` would never perform.
 *  - §9.6 preview payload: the confirmation dialog could name the files a write
 *    would touch but not what would change inside them.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { bufferIo } from "../src/commands/context.js";
import { collectDiagnostics } from "../src/commands/doctor.js";
import { runPlan } from "../src/commands/plan.js";
import { computeActions } from "../src/commands/plan.js";
import { loadSourceContext } from "../src/commands/context.js";
import { hasChanges, isExecutable } from "../src/core/diff.js";
import { readManifest } from "../src/core/manifest.js";
import type { InventoryJson, PlanJson } from "../src/commands/json.js";
import type { ExcludeReport, RemoveReport } from "../src/commands/assets.js";

/* ------------------------------------------------------------------ */
/* Fake HOME                                                           */
/* ------------------------------------------------------------------ */

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env["AM_HOME"];
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "am-v2-")));
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

const SKILL_MD = (name: string, description: string, extra = ""): string =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`;

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

/** A source of truth holding one skill, two MCP servers and one agent. */
function seedSource(manifest?: unknown): void {
  write(
    ".agents-manager/manifest.json",
    `${JSON.stringify(manifest ?? { version: 1, targets: { claude: { enabled: true } } }, null, 2)}\n`,
  );
  write(".agents/skills/demo-skill/SKILL.md", SKILL_MD("demo-skill", "A demo skill."));
  write(
    ".agents-manager/mcp/servers.json",
    `${JSON.stringify(
      {
        servers: {
          docs: { transport: "http", url: "https://example.invalid/mcp" },
          files: { transport: "stdio", command: "npx", args: ["-y", "fs"] },
        },
      },
      null,
      2,
    )}\n`,
  );
  write(
    ".agents-manager/agents/code-reviewer.md",
    "---\nname: code-reviewer\ndescription: Reviews changes.\nmodel: sonnet\n---\n\nBody.\n",
  );
}

/* ------------------------------------------------------------------ */
/* §9.1 — manifest v2                                                  */
/* ------------------------------------------------------------------ */

describe("SPEC §9.1 manifest v2", () => {
  it("accepts a version 2 manifest instead of failing every command with exit 2", () => {
    seedSource({
      version: 2,
      targets: { claude: { enabled: true } },
      skills: { linkMode: "junction", exclude: [] },
      mcp: { exclude: [] },
      agents: { exclude: [] },
    });

    expect(run("inventory").code).toBe(0);
    expect(run("doctor").code).toBe(0);
  });

  it("still accepts a v1 manifest and completes it with empty exclude lists", () => {
    seedSource({ version: 1, targets: { claude: { enabled: true } } });

    const manifest = readManifest();
    expect(manifest.version).toBe(1);
    expect(manifest.mcp).toEqual({ exclude: [] });
    expect(manifest.agents).toEqual({ exclude: [] });
    expect(run("inventory").code).toBe(0);
  });

  it("rejects a version it does not know, rather than guessing", () => {
    // SPEC §10.5 promoted 3 to a version this build reads; 4 is the next
    // unknown one, and it must still stop every command rather than be guessed.
    seedSource({ version: 4, targets: { claude: { enabled: true } } });
    expect(run("inventory").code).toBe(2);
  });

  it("honours mcp.exclude / agents.exclude written into a v1 file", () => {
    // The regression: these keys used to be dropped on the floor, so an asset
    // the owner had switched off went on being delivered to every target.
    seedSource({
      version: 1,
      targets: { claude: { enabled: true } },
      mcp: { exclude: ["docs"] },
      agents: { exclude: ["code-reviewer"] },
    });

    const ctx = loadSourceContext();
    expect(Object.keys(ctx.servers)).toEqual(["files"]);
    expect(ctx.agents).toEqual([]);
  });

  it("writes the current version with every new key once something edits the manifest", () => {
    seedSource({ version: 1, targets: { claude: { enabled: true } } });

    expect(run("disable", "skill", "demo-skill").code).toBe(0);

    const written = JSON.parse(read(".agents-manager/manifest.json")) as Record<string, unknown>;
    // SPEC §10.5: a write always emits the version this build fills in, so the
    // number never claims less than the content.
    expect(written["version"]).toBe(3);
    expect(written["skills"]).toEqual({ linkMode: "junction", exclude: ["demo-skill"] });
    expect(written["mcp"]).toEqual({ exclude: [] });
    expect(written["agents"]).toEqual({ exclude: [] });
    expect(written["commands"]).toEqual({ exclude: [] });
  });
});

/* ------------------------------------------------------------------ */
/* §9.2 — enable / disable / remove                                    */
/* ------------------------------------------------------------------ */

describe("SPEC §9.2 enable / disable / remove", () => {
  beforeEach(() => {
    seedSource();
  });

  it("disables and re-enables each asset kind through the manifest", () => {
    for (const [kind, name] of [
      ["skill", "demo-skill"],
      ["mcp", "docs"],
      ["agent", "code-reviewer"],
    ] as const) {
      const off = cli<ExcludeReport>("disable", kind, name, "--json");
      expect(off.code).toBe(0);
      expect(off.payload.changed).toBe(true);
      expect(off.payload.excluded).toContain(name);

      // Idempotent: asking for a state that already holds is a success.
      const again = cli<ExcludeReport>("disable", kind, name, "--json");
      expect(again.code).toBe(0);
      expect(again.payload.changed).toBe(false);

      const on = cli<ExcludeReport>("enable", kind, name, "--json");
      expect(on.code).toBe(0);
      expect(on.payload.changed).toBe(true);
      expect(on.payload.excluded).not.toContain(name);
    }
  });

  it("stops delivering a disabled asset without touching the asset itself", () => {
    expect(run("disable", "mcp", "docs").code).toBe(0);

    const ctx = loadSourceContext();
    expect(Object.keys(ctx.servers)).toEqual(["files"]);
    // SPEC §9.1: the definition of "disabled" is exclusion, not deletion.
    expect(read(".agents-manager/mcp/servers.json")).toContain("docs");
  });

  it("backs the manifest up before changing it", () => {
    write(".agents-manager/manifest.json", read(".agents-manager/manifest.json"));
    expect(run("disable", "skill", "demo-skill").code).toBe(0);

    const backups = path.join(home, ".agents-manager", "backups");
    const stamps = fs.readdirSync(backups);
    expect(stamps.length).toBe(1);
    const saved = path.join(backups, stamps[0] ?? "", ".agents-manager", "manifest.json");
    expect(fs.existsSync(saved)).toBe(true);
    // The copy is the *previous* content, not the one just written.
    expect(fs.readFileSync(saved, "utf8")).not.toContain("demo-skill");
  });

  it("refuses an unknown asset name with exit 2 rather than succeeding at nothing", () => {
    expect(run("disable", "skill", "no-such-skill").code).toBe(2);
    expect(run("enable", "mcp", "no-such-server").code).toBe(2);
    expect(run("remove", "agent", "no-such-agent", "--yes").code).toBe(2);
    // Nothing was written.
    expect(exists(".agents-manager/backups")).toBe(false);
  });

  it("refuses an unknown asset kind with exit 2", () => {
    expect(run("disable", "widget", "demo-skill").code).toBe(2);
  });

  it("removes a skill only after --yes, and backs it up first", () => {
    const refused = run("remove", "skill", "demo-skill");
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("demo-skill");
    expect(exists(".agents/skills/demo-skill/SKILL.md")).toBe(true);

    const done = cli<RemoveReport>("remove", "skill", "demo-skill", "--yes", "--json");
    expect(done.code).toBe(0);
    expect(done.payload.removed).toEqual([
      { assetType: "skill", asset: "demo-skill", path: path.join(home, ".agents", "skills", "demo-skill") },
    ]);
    expect(exists(".agents/skills/demo-skill")).toBe(false);

    const backupDir = done.payload.backupDir ?? "";
    expect(fs.existsSync(path.join(backupDir, ".agents", "skills", "demo-skill", "SKILL.md"))).toBe(
      true,
    );
  });

  it("removes an MCP server as a rewrite of the shared document", () => {
    const done = cli<RemoveReport>("remove", "mcp", "docs", "--yes", "--json");
    expect(done.code).toBe(0);

    const stored = JSON.parse(read(".agents-manager/mcp/servers.json")) as {
      servers: Record<string, unknown>;
    };
    // The neighbour survives; only the named entry is gone.
    expect(Object.keys(stored.servers)).toEqual(["files"]);
    expect(
      fs.existsSync(
        path.join(done.payload.backupDir ?? "", ".agents-manager", "mcp", "servers.json"),
      ),
    ).toBe(true);
  });

  it("removes an agent file", () => {
    expect(run("remove", "agent", "code-reviewer", "--yes").code).toBe(0);
    expect(exists(".agents-manager/agents/code-reviewer.md")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* §9.3 — inventory arrays                                             */
/* ------------------------------------------------------------------ */

describe("SPEC §9.3 inventory lists assets, not counts", () => {
  it("emits SourceMcp / SourceAgent arrays with an enabled flag", () => {
    seedSource();
    expect(run("disable", "mcp", "docs").code).toBe(0);

    const { payload } = cli<InventoryJson>("inventory", "--json");

    expect(payload.source.mcp.map((m) => [m.name, m.transport, m.enabled])).toEqual([
      ["docs", "http", false],
      ["files", "stdio", true],
    ]);
    expect(payload.source.agents.map((a) => [a.name, a.description, a.enabled])).toEqual([
      ["code-reviewer", "Reviews changes.", true],
    ]);
    // A disabled asset is still *listed* — otherwise the console could never
    // offer to switch it back on.
    expect(payload.source.mcp).toHaveLength(2);
  });

  it("omits version and origin entirely rather than inventing them", () => {
    seedSource();
    const { payload } = cli<InventoryJson>("inventory", "--json");

    const skill = payload.source.skills[0];
    expect(skill?.name).toBe("demo-skill");
    expect(skill?.description).toBe("A demo skill.");
    expect(skill).not.toHaveProperty("version");
    expect(skill).not.toHaveProperty("origin");
    // `modified` is the SKILL.md mtime, present because the file exists.
    expect(typeof skill?.modified).toBe("string");
  });

  it("reports version and origin when the skill really has them", () => {
    seedSource();
    write(
      ".agents/skills/demo-skill/SKILL.md",
      SKILL_MD("demo-skill", "A demo skill.", "version: 1.4.0\n"),
    );
    // The real lock file: ONE document beside `skills/`, keyed by skill name.
    // Reading `~/.agents/skills/<name>/.skill-lock.json` instead — as the
    // engine used to — finds nothing on any real machine, so `origin` could
    // never be filled and the console's 「提供元」 row was unreachable.
    writeSkillLock({
      "demo-skill": {
        source: "example-org/example-skills",
        sourceType: "github",
        sourceUrl: "https://example.invalid/example-skills.git",
        skillPath: "skills/demo-skill/SKILL.md",
        skillFolderHash: "0000000000000000000000000000000000000000",
        installedAt: "2000-01-01T00:00:00.000Z",
        updatedAt: "2000-01-01T00:00:00.000Z",
      },
    });

    const { payload } = cli<InventoryJson>("inventory", "--json");
    const skill = payload.source.skills[0];
    expect(skill?.version).toBe("1.4.0");
    expect(skill?.origin).toEqual({
      source: "example-org/example-skills",
      sourceUrl: "https://example.invalid/example-skills.git",
    });
  });

  it("ignores a lock file written inside the skill directory", () => {
    seedSource();
    // The shape the engine used to look for. It is not what any installer
    // writes, and honouring it would resurrect the fiction.
    write(
      ".agents/skills/demo-skill/.skill-lock.json",
      `${JSON.stringify({ name: "demo-skill", source: "agentskills.io" })}\n`,
    );

    const { payload } = cli<InventoryJson>("inventory", "--json");
    expect(payload.source.skills[0]).not.toHaveProperty("origin");
  });

  it("omits origin for a skill the shared lock does not record", () => {
    seedSource();
    write(".agents/skills/hand-made/SKILL.md", SKILL_MD("hand-made", "Installed by hand."));
    writeSkillLock({
      "demo-skill": { source: "example-org/example-skills" },
    });

    const { payload } = cli<InventoryJson>("inventory", "--json");
    const byName = new Map(payload.source.skills.map((s) => [s.name, s]));
    expect(byName.get("demo-skill")?.origin).toEqual({ source: "example-org/example-skills" });
    expect(byName.get("hand-made")).not.toHaveProperty("origin");
  });
});

/* ------------------------------------------------------------------ */
/* .skill-lock.json — doctor                                           */
/* ------------------------------------------------------------------ */

/** Write `~/.agents/.skill-lock.json` in the v3 shape `npx skills` produces. */
function writeSkillLock(skills: Record<string, unknown>): void {
  write(
    ".agents/.skill-lock.json",
    `${JSON.stringify({ version: 3, skills, dismissed: {} }, null, 2)}\n`,
  );
}

describe("doctor checks the shared .skill-lock.json", () => {
  const codes = (): string[] => collectDiagnostics().map((d) => d.code);

  it("is silent when the lock matches the installed skills", () => {
    seedSource();
    writeSkillLock({
      "demo-skill": {
        source: "example-org/example-skills",
        skillFolderHash: "0000000000000000000000000000000000000000",
      },
    });
    expect(codes().filter((c) => c.startsWith("skill.lock-"))).toEqual([]);
  });

  it("reports an unparseable lock file", () => {
    seedSource();
    write(".agents/.skill-lock.json", "{ not json");
    expect(codes()).toContain("skill.lock-unparseable");
  });

  it("reports a lock file whose skills map is not an object", () => {
    seedSource();
    write(".agents/.skill-lock.json", `${JSON.stringify({ version: 3, skills: [] })}\n`);
    expect(codes()).toContain("skill.lock-invalid");
  });

  it("reports a lock entry that is not an object", () => {
    seedSource();
    writeSkillLock({ "demo-skill": "example-org/example-skills" });
    const found = collectDiagnostics().find((d) => d.code === "skill.lock-invalid");
    expect(found?.asset).toBe("demo-skill");
    expect(found?.level).toBe("error");
  });

  it("warns about a skill the lock records but the source does not have", () => {
    seedSource();
    writeSkillLock({
      "demo-skill": { source: "example-org/example-skills" },
      "removed-skill": { source: "example-org/example-skills" },
    });
    const found = collectDiagnostics().filter((d) => d.code === "skill.lock-orphan");
    expect(found.map((d) => d.asset)).toEqual(["removed-skill"]);
    expect(found[0]?.level).toBe("warn");
  });

  it("does not look for a lock file inside the skill directory", () => {
    seedSource();
    write(".agents/skills/demo-skill/.skill-lock.json", "{ not json");
    expect(codes().filter((c) => c.startsWith("skill.lock-"))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* §5 — preserve is not delete                                         */
/* ------------------------------------------------------------------ */

describe("an unmanaged target asset is preserved, not planned for deletion", () => {
  beforeEach(() => {
    seedSource();
    // Exactly the real-world trigger: Claude Code registers one MCP server of
    // its own in `~/.claude.json`, which `am` does not manage.
    write(
      ".claude.json",
      `${JSON.stringify(
        {
          numStartups: 3,
          mcpServers: { theirs: { type: "stdio", command: "node", args: ["their-server.js"] } },
        },
        null,
        2,
      )}\n`,
    );
  });

  it("reaches the SPEC §8 fixed point instead of exiting 1 forever", () => {
    expect(main(["node", "cli.js", "apply"], { io: bufferIo() })).toBe(0);

    // The re-plan is the whole assertion: it used to exit 1 permanently.
    expect(runPlan({ io: bufferIo() })).toBe(0);
    // …twice, to be sure it is a fixed point and not an alternation.
    expect(runPlan({ io: bufferIo() })).toBe(0);

    // And the unmanaged server is still there — preserved means preserved.
    const claude = JSON.parse(read(".claude.json")) as {
      mcpServers: Record<string, unknown>;
      numStartups: number;
    };
    expect(Object.keys(claude.mcpServers).sort()).toEqual(["docs", "files", "theirs"]);
    expect(claude.numStartups).toBe(3);
  });

  it("marks it `preserve`, and `preserve` is neither a change nor executable", () => {
    expect(main(["node", "cli.js", "apply"], { io: bufferIo() })).toBe(0);

    const actions = computeActions(loadSourceContext());
    const theirs = actions.filter((a) => a.name === "theirs");
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.kind).toBe("preserve");
    expect(theirs[0]?.detail).toContain("--prune");

    // The two properties that were previously in conflict: the GUI's dialog is
    // built from `isExecutable`, and the exit code is built from `hasChanges`.
    // A `preserve` action must fail both, or the dialog promises a deletion
    // `apply` will not perform.
    expect(isExecutable(theirs[0]!, { prune: false })).toBe(false);
    expect(isExecutable(theirs[0]!, { prune: true })).toBe(false);
    expect(hasChanges(actions)).toBe(false);
  });

  it("turns into a real `delete` under --prune, and only then", () => {
    expect(main(["node", "cli.js", "apply"], { io: bufferIo() })).toBe(0);

    const pruned = computeActions(loadSourceContext(), { prune: true });
    const theirs = pruned.find((a) => a.name === "theirs");
    expect(theirs?.kind).toBe("delete");
    expect(isExecutable(theirs!, { prune: true })).toBe(true);
    expect(hasChanges(pruned)).toBe(true);
    expect(runPlan({ io: bufferIo(), prune: true })).toBe(1);
  });

  it("never emits a delete action from a plan that is not pruning", () => {
    const actions = computeActions(loadSourceContext());
    expect(actions.filter((a) => a.kind === "delete")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* §9.6 — content preview                                              */
/* ------------------------------------------------------------------ */

describe("SPEC §9.6 plan --json carries the content preview", () => {
  it("gives an update action both sides of the change", () => {
    seedSource();
    expect(main(["node", "cli.js", "apply"], { io: bufferIo() })).toBe(0);

    // Edit the source so the next plan has a genuine content difference.
    write(
      ".agents-manager/agents/code-reviewer.md",
      "---\nname: code-reviewer\ndescription: Reviews changes very carefully.\nmodel: sonnet\n---\n\nBody.\n",
    );

    const { payload } = cli<PlanJson>("plan", "--json");
    const update = payload.actions.find((a) => a.kind === "update" && a.assetType === "agent");

    expect(update).toBeDefined();
    expect(update?.before).toContain("Reviews changes.");
    expect(update?.after).toContain("Reviews changes very carefully.");
  });

  it("has no `before` for a create — there is nothing there yet", () => {
    seedSource();

    const { payload } = cli<PlanJson>("plan", "--json");
    const create = payload.actions.find((a) => a.kind === "create");

    expect(create).toBeDefined();
    expect(create).not.toHaveProperty("before");
    expect(typeof create?.after).toBe("string");
  });
});
