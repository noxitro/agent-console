/**
 * A fictional machine for `projects` and `installed`, used when the screen runs
 * without the agent-console server (`npm --prefix ui run dev`).
 *
 * Every name, path, date and count here is invented. The rows are chosen so
 * every state the screen draws appears at least once: a skill shared by a link
 * between both harnesses, a switched-off one, an instruction file imported by
 * another, an `applyTo` file, an MCP server whose approval is unknown, a
 * location that is not confirmed, a plugin declared but not installed, an
 * unreadable file, the parts two plugins brought (one from a marketplace, one
 * switched off), and a name held in two units.
 */

import type {
  InstalledJson,
  InstalledReach,
  InstalledRow,
  ProjectEntry,
  ProjectsActionJson,
  ProjectsJson,
  ScopeKind,
  ScopeTotal,
} from "./scope-contract.js";

// The same fictional home as fixtures.ts.
const HOME = "C:\\home\\user";
const WORK = "D:\\work";

interface ScopeMachine {
  projects: ProjectEntry[];
  added: string[];
}

export function newScopeMachine(): ScopeMachine {
  return {
    added: [],
    projects: [
      { id: "a1b2c3d4e5f6", root: `${WORK}\\orbit-web`, name: "orbit-web", sources: ["claude", "copilot"], lastUsed: "2030-04-02T09:12:00.000Z", worktrees: 2, git: true },
      { id: "b2c3d4e5f6a1", root: `${WORK}\\ledger-api`, name: "ledger-api", sources: ["claude"], lastUsed: "2030-03-28T15:40:00.000Z", worktrees: 0, git: true },
      { id: "c3d4e5f6a1b2", root: `${WORK}\\pixel-forge`, name: "pixel-forge", sources: ["copilot"], lastUsed: "2030-03-11T08:05:00.000Z", worktrees: 0, git: true },
      { id: "d4e5f6a1b2c3", root: `${WORK}\\field-notes`, name: "field-notes", sources: ["claude"], lastUsed: "2030-02-01T12:00:00.000Z", worktrees: 0, git: false },
    ],
  };
}

function sorted(list: ProjectEntry[]): ProjectEntry[] {
  return [...list].sort((a, b) => {
    if ((a.pinned === true) !== (b.pinned === true)) return a.pinned === true ? -1 : 1;
    return (b.lastUsed ?? "").localeCompare(a.lastUsed ?? "");
  });
}

export function fixtureProjects(m: ScopeMachine): ProjectsJson {
  const projects = sorted(m.projects);
  return {
    projects,
    counts: {
      candidates: 23,
      missing: 6,
      excluded: 9,
      nonGit: projects.filter((p) => !p.git).length,
      hidden: projects.filter((p) => p.hidden === true).length,
      worktreesMerged: 2,
      listed: projects.length,
    },
    sources: [
      { label: "claude.json#projects", path: `${HOME}\\.claude.json`, status: "ok", records: 17 },
      { label: "claude.json#githubRepoPaths", path: `${HOME}\\.claude.json`, status: "ok", records: 2 },
      { label: "claude transcripts", path: `${HOME}\\.claude\\projects`, status: "ok", records: 15 },
      { label: "copilot session-state", path: `${HOME}\\.copilot\\session-state`, status: "ok", records: 41 },
    ],
    cache: "hit",
    elapsedMs: 84,
  };
}

export function fixtureProjectAction(m: ScopeMachine, action: string, target: string): ProjectsActionJson {
  let root: string;
  if (action === "add") {
    root = target;
    if (!m.projects.some((p) => p.root.toLowerCase() === target.toLowerCase())) {
      const name = target.split(/[\\/]/).filter(Boolean).pop() ?? target;
      m.projects.push({ id: fakeId(target), root: target, name, sources: ["manual"], worktrees: 0, git: true });
    }
  } else {
    const p = m.projects.find((x) => x.id === target);
    if (p === undefined) throw new Error(`Unknown project id: ${target}`);
    root = p.root;
    if (action === "pin") p.pinned = true;
    if (action === "unpin") delete p.pinned;
    if (action === "hide") p.hidden = true;
    if (action === "unhide") delete p.hidden;
    if (action === "forget") m.projects = m.projects.filter((x) => x !== p || !x.sources.includes("manual"));
  }
  return { action: action as ProjectsActionJson["action"], root, projects: fixtureProjects(m) };
}

function fakeId(s: string): string {
  let h = 0x811c9dc5;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return (h.toString(16).padStart(8, "0") + "0000").slice(0, 12);
}

/* ---- installed --------------------------------------------------------- */

const c = (chars: number): { chars: number; tokens: number } => ({ chars, tokens: Math.round(chars / 2.6) });

function reach(r: InstalledReach): InstalledReach {
  return r;
}

function userRows(): InstalledRow[] {
  return [
    {
      id: "instructions:user:claude-md",
      kind: "instructions",
      name: "CLAUDE.md",
      scope: "user",
      origin: "link",
      path: `${HOME}\\.claude\\CLAUDE.md`,
      realPath: `${HOME}\\.agents\\AGENTS.md`,
      imports: [{ path: `${HOME}\\.agents\\style-notes.md`, chars: 1210 }],
      reach: [reach({ harness: "claude", state: "enabled", via: `${HOME}\\.claude\\CLAUDE.md`, certainty: "official", cost: c(3480), costBasis: "本文 + @import 先の字数(公式 memory)" })],
    },
    {
      id: "instructions:user:copilot",
      kind: "instructions",
      name: "copilot-instructions.md",
      scope: "user",
      origin: "file",
      path: `${HOME}\\.copilot\\copilot-instructions.md`,
      reach: [reach({ harness: "copilot", state: "enabled", via: `${HOME}\\.copilot\\copilot-instructions.md`, certainty: "official+measured", cost: c(912), costBasis: "<custom_instruction> 1 件分(実測)" })],
    },
    {
      id: "skill:user:release-notes",
      kind: "skill",
      name: "release-notes",
      scope: "user",
      origin: "link",
      path: `${HOME}\\.claude\\skills\\release-notes`,
      realPath: `${HOME}\\.agents\\skills\\release-notes`,
      description: "Drafts release notes from merged pull requests and the changelog.",
      reach: [
        reach({ harness: "claude", state: "enabled", via: `${HOME}\\.claude\\skills\\release-notes`, certainty: "official", cost: c(78), costBasis: "名前 + description + when_to_use(公式)" }),
        reach({ harness: "copilot", state: "enabled", via: `${HOME}\\.agents\\skills\\release-notes`, certainty: "official+measured", cost: c(161), costBasis: "<available_skills> 1 件分(実測)" }),
      ],
    },
    {
      id: "skill:user:diagram-kit",
      kind: "skill",
      name: "diagram-kit",
      scope: "user",
      origin: "link",
      path: `${HOME}\\.agents\\skills\\diagram-kit`,
      description: "図表の下書きを Mermaid で作る。",
      reach: [
        reach({ harness: "claude", state: "enabled", via: `${HOME}\\.claude\\skills\\diagram-kit`, certainty: "official", stateSource: `${HOME}\\.claude\\settings.json#skillOverrides`, cost: c(11), costBasis: "名前だけ(skillOverrides: name-only。内訳は推測)" }),
        reach({ harness: "copilot", state: "disabled", via: `${HOME}\\.agents\\skills\\diagram-kit`, certainty: "official+measured", stateSource: `${HOME}\\.copilot\\settings.json#disabledSkills`, cost: c(0) }),
      ],
    },
    {
      id: "skill:user:web-capture",
      kind: "skill",
      name: "web-capture",
      scope: "user",
      origin: "synced",
      path: `${HOME}\\.claude\\skills\\synced\\bucket-7\\web-capture`,
      description: "Captures a page as text for later reading.",
      reach: [reach({ harness: "claude", state: "enabled", via: `${HOME}\\.claude\\skills\\synced\\bucket-7\\web-capture`, certainty: "official", cost: c(55), note: "claude.ai から同期された skill" })],
    },
    {
      id: "agent:user:reviewer",
      kind: "agent",
      name: "reviewer",
      scope: "user",
      origin: "file",
      path: `${HOME}\\.claude\\agents\\reviewer.md`,
      description: "Reviews a change against the project's checklist.",
      reach: [reach({ harness: "claude", state: "enabled", via: `${HOME}\\.claude\\agents\\reviewer.md`, certainty: "official", cost: c(58), costBasis: "名前 + description" })],
    },
    {
      id: "command:user:ship",
      kind: "command",
      name: "ship",
      scope: "user",
      origin: "file",
      path: `${HOME}\\.claude\\commands\\ship.md`,
      reach: [reach({ harness: "claude", state: "enabled", via: `${HOME}\\.claude\\commands\\ship.md`, certainty: "official", cost: c(24), costBasis: "名前 + description(無ければ本文の 1 行目)" })],
    },
    {
      id: "mcp:user:docs-search",
      kind: "mcp",
      name: "docs-search",
      scope: "user",
      origin: "config",
      path: `${HOME}\\.copilot\\mcp-config.json`,
      transport: "http",
      reach: [reach({ harness: "copilot", state: "enabled", via: `${HOME}\\.copilot\\mcp-config.json`, certainty: "official", note: "ツールの定義は起動してみないと分からないので数えていない" })],
    },
    {
      id: "plugin:user:claude:lint-pack",
      kind: "plugin",
      name: "lint-pack@demo-market",
      scope: "user",
      origin: "plugin",
      path: `${HOME}\\.claude\\plugins\\cache\\demo-market\\lint-pack\\0.4.0`,
      version: "0.4.0",
      plugin: LINT_PACK,
      components: { skills: ["lint-pack:fix-style"], commands: ["lint-pack:lint"], agents: [], mcpServers: [] },
      reach: [LINT_REACH],
    },
    part("skill", "fix-style", `${LINT_DIR}\\skills\\fix-style\\SKILL.md`, LINT_PACK, LINT_REACH, "Rewrites a file to the house style."),
    part("command", "lint", `${LINT_DIR}\\commands\\lint.md`, LINT_PACK, LINT_REACH, "Runs the linters on the changed files."),
    {
      id: "plugin:user:copilot:research-kit",
      kind: "plugin",
      name: "research-kit@team-market",
      scope: "user",
      origin: "plugin",
      path: RESEARCH_DIR,
      version: "2.1.0",
      description: "Search, read and cite sources.",
      plugin: RESEARCH_KIT,
      components: { skills: ["research-kit:cite-sources"], commands: [], agents: ["research-kit:fact-checker"], mcpServers: ["paper-search"] },
      reach: [RESEARCH_REACH],
    },
    part("mcp", "paper-search", `${RESEARCH_DIR}\\.mcp.json`, RESEARCH_KIT, RESEARCH_REACH),
    part("skill", "cite-sources", `${RESEARCH_DIR}\\skills\\cite-sources\\SKILL.md`, RESEARCH_KIT, RESEARCH_REACH, "Formats citations for the sources a session read."),
    part("agent", "fact-checker", `${RESEARCH_DIR}\\agents\\fact-checker.agent.md`, RESEARCH_KIT, RESEARCH_REACH, "Checks each claim against a second source."),
  ];
}

const LINT_DIR = `${HOME}\\.claude\\plugins\\cache\\demo-market\\lint-pack\\0.4.0`;
const LINT_PACK = { id: "lint-pack@demo-market", name: "lint-pack", marketplace: "demo-market" };
const LINT_REACH = reach({ harness: "claude", state: "disabled", via: `${HOME}\\.claude\\plugins\\installed_plugins.json`, certainty: "official", stateSource: `${HOME}\\.claude\\settings.json#enabledPlugins`, cost: c(0), costBasis: "部品(skill・command・agent)の名前 + description の合計" });

const RESEARCH_DIR = `${HOME}\\.copilot\\installed-plugins\\team-market\\research-kit`;
const RESEARCH_KIT = { id: "research-kit@team-market", name: "research-kit", marketplace: "team-market" };
const RESEARCH_REACH = reach({ harness: "copilot", state: "enabled", via: RESEARCH_DIR, certainty: "official", stateSource: `${HOME}\\.copilot\\settings.json#enabledPlugins`, cost: c(214), costBasis: "部品(skill・agent)の 1 件分の合計(skill の location は推測)" });

/** A row a plugin brought, the way the engine writes it (`putPluginParts`). */
function part(kind: InstalledRow["kind"], name: string, file: string, plugin: { id: string; name: string; marketplace?: string }, parent: InstalledReach, description?: string): InstalledRow {
  const row: InstalledRow = {
    id: `${kind}:user:plugin:${parent.harness}:${plugin.id}:${name}`,
    kind,
    name,
    scope: "user",
    origin: "plugin",
    path: file,
    plugin,
    reach: [
      {
        harness: parent.harness,
        state: parent.state,
        via: file,
        certainty: parent.certainty,
        ...(parent.stateSource !== undefined ? { stateSource: parent.stateSource } : {}),
        note: `プラグイン ${plugin.id} の部品。有効・無効はプラグインごとに決まり、常時コストはプラグインの行で数える`,
      },
    ],
  };
  if (description !== undefined) row.description = description;
  return row;
}

function projectRows(root: string): InstalledRow[] {
  const j = (...p: string[]): string => [root, ...p].join("\\");
  return [
    {
      id: "instructions:project:claude-md",
      kind: "instructions",
      name: "CLAUDE.md",
      scope: "project",
      origin: "file",
      path: j("CLAUDE.md"),
      imports: [{ path: j("AGENTS.md"), chars: 1640 }],
      reach: [
        reach({ harness: "claude", state: "enabled", via: j("CLAUDE.md"), certainty: "official", cost: c(2210), costBasis: "本文 + @import 先の字数(公式 memory)" }),
        reach({ harness: "copilot", state: "enabled", via: j("CLAUDE.md"), certainty: "official+measured", cost: c(2251), costBasis: "<custom_instruction> 1 件分(実測)" }),
      ],
    },
    {
      id: "instructions:project:agents-md",
      kind: "instructions",
      name: "AGENTS.md",
      scope: "project",
      origin: "file",
      path: j("AGENTS.md"),
      reach: [
        reach({ harness: "claude", state: "via-import", via: j("AGENTS.md"), certainty: "official", cost: c(1640), note: "CLAUDE.md の @import として読まれる(字数はそちらに含めた)" }),
        reach({ harness: "copilot", state: "enabled", via: j("AGENTS.md"), certainty: "official+measured", cost: c(1681), costBasis: "<custom_instruction> 1 件分(実測)" }),
      ],
    },
    {
      id: "instructions:project:dot-claude",
      kind: "instructions",
      name: "CLAUDE.md",
      scope: "project",
      origin: "file",
      path: j(".claude", "CLAUDE.md"),
      reach: [
        reach({ harness: "claude", state: "enabled", via: j(".claude", "CLAUDE.md"), certainty: "official", cost: c(320), costBasis: "本文 + @import 先の字数(公式 memory)" }),
        reach({ harness: "copilot", state: "unconfirmed", via: j(".claude", "CLAUDE.md"), certainty: "unconfirmed", note: "公式文書は読むとするが、1.0.107 の実測では読まれなかった" }),
      ],
    },
    {
      id: "instructions:project:py",
      kind: "instructions",
      name: "python.instructions.md",
      scope: "project",
      origin: "file",
      path: j(".github", "instructions", "python.instructions.md"),
      reach: [reach({ harness: "copilot", state: "conditional", via: j(".github", "instructions", "python.instructions.md"), certainty: "official+measured", cost: c(52), costBasis: "一覧表の 1 行(実測)", note: "applyTo「**/*.py」に当たるファイルを扱うときだけ本文が入る。常時は表の 1 行だけ" })],
    },
    {
      id: "skill:project:schema-check",
      kind: "skill",
      name: "schema-check",
      scope: "project",
      origin: "file",
      path: j(".claude", "skills", "schema-check"),
      description: "Validates the API schema files before a commit.",
      reach: [
        reach({ harness: "claude", state: "enabled", via: j(".claude", "skills", "schema-check"), certainty: "official", cost: c(63), costBasis: "名前 + description + when_to_use(公式)" }),
        reach({ harness: "copilot", state: "enabled", via: j(".claude", "skills", "schema-check"), certainty: "official+measured", cost: c(149), costBasis: "<available_skills> 1 件分(実測)" }),
      ],
    },
    {
      id: "skill:project:broken",
      kind: "skill",
      name: "deploy-notes",
      scope: "project",
      origin: "file",
      path: j(".github", "skills", "deploy-notes"),
      unreadable: `${j(".github", "skills", "deploy-notes", "SKILL.md")}: frontmatter の YAML が読めない`,
      reach: [reach({ harness: "copilot", state: "unknown", via: j(".github", "skills", "deploy-notes"), certainty: "official+measured", note: "SKILL.md が読めない" })],
    },
    {
      id: "agent:project:triage",
      kind: "agent",
      name: "triage",
      scope: "project",
      origin: "file",
      path: j(".github", "agents", "triage.agent.md"),
      description: "Sorts new issues by area and urgency.",
      reach: [reach({ harness: "copilot", state: "enabled", via: j(".github", "agents", "triage.agent.md"), certainty: "official+measured", cost: c(52), costBasis: "task ツールの説明の 1 行(実測)" })],
    },
    {
      id: "agent:project:reviewer",
      kind: "agent",
      name: "reviewer",
      scope: "project",
      origin: "file",
      path: j(".claude", "agents", "reviewer.md"),
      description: "Reviews a change against this repository's checklist.",
      reach: [reach({ harness: "claude", state: "enabled", via: j(".claude", "agents", "reviewer.md"), certainty: "official", cost: c(61), costBasis: "名前 + description" })],
    },
    {
      id: "mcp:project:db-read",
      kind: "mcp",
      name: "db-read",
      scope: "project",
      origin: "config",
      path: j(".mcp.json"),
      transport: "stdio",
      reach: [
        reach({ harness: "claude", state: "enabled", via: j(".mcp.json"), certainty: "official", stateSource: "~/.claude.json#projects[root].enabledMcpjsonServers", note: "ツールの定義は起動してみないと分からないので数えていない" }),
        reach({ harness: "copilot", state: "unknown", via: j(".mcp.json"), certainty: "official+measured", note: "信頼済みのフォルダなら読む(信頼の記録は読まない)" }),
      ],
    },
    {
      id: "plugin:project:claude:design-kit",
      kind: "plugin",
      name: "design-kit@demo-market",
      scope: "project",
      origin: "config",
      path: j(".claude", "settings.json"),
      plugin: { id: "design-kit@demo-market", name: "design-kit", marketplace: "demo-market" },
      reach: [reach({ harness: "claude", state: "enabled", via: `${j(".claude", "settings.json")}#enabledPlugins`, certainty: "official", stateSource: `${j(".claude", "settings.json")}#enabledPlugins`, note: "導入の記録が無い(この単位で宣言だけされている)" })],
      findings: [{ code: "plugin.enabled-not-installed", level: "warn", detail: "enabledPlugins にあるが、導入の記録が無い" }],
    },
    {
      id: "instructions:local:claude-local",
      kind: "instructions",
      name: "CLAUDE.local.md",
      scope: "local",
      origin: "file",
      path: j("CLAUDE.local.md"),
      reach: [
        reach({ harness: "claude", state: "enabled", via: j("CLAUDE.local.md"), certainty: "official", cost: c(410), costBasis: "本文 + @import 先の字数(公式 memory)" }),
        reach({ harness: "copilot", state: "not-loaded", via: j("CLAUDE.local.md"), certainty: "measured", note: "Copilot CLI 1.0.107 は読まなかった(実測)" }),
      ],
    },
    {
      id: "mcp:local:scratch-db",
      kind: "mcp",
      name: "scratch-db",
      scope: "local",
      origin: "config",
      path: `${HOME}\\.claude.json#projects`,
      transport: "stdio",
      reach: [reach({ harness: "claude", state: "enabled", via: `${HOME}\\.claude.json#projects[root].mcpServers`, certainty: "official", note: "ツールの定義は起動してみないと分からないので数えていない" })],
    },
  ];
}

/** The engine's `markAlsoIn`: the same kind and name in more than one unit (instruction files aside). */
function markAlsoIn(rows: InstalledRow[]): InstalledRow[] {
  return rows.map((row) => {
    if (row.kind === "instructions") return row;
    const units = [...new Set(rows.filter((r) => r.kind === row.kind && r.name.toLowerCase() === row.name.toLowerCase()).map((r) => r.scope))];
    return units.length < 2 ? row : { ...row, alsoIn: units.filter((u) => u !== row.scope) };
  });
}

function totals(rows: InstalledRow[], scopes: ScopeKind[]): ScopeTotal[] {
  const out: ScopeTotal[] = [];
  for (const scope of scopes) {
    for (const harness of ["claude", "copilot"] as const) {
      const t: ScopeTotal = { scope, harness, chars: 0, tokens: 0, rows: 0, conditional: 0, unmeasured: 0 };
      for (const row of rows.filter((r) => r.scope === scope && !(r.kind !== "plugin" && r.plugin !== undefined))) {
        const rs = row.reach.filter((r) => r.harness === harness);
        if (rs.length === 0) continue;
        t.rows++;
        for (const r of rs) {
          if (r.state === "enabled") {
            if (r.cost === undefined) t.unmeasured++;
            else {
              t.chars += r.cost.chars;
              t.tokens += r.cost.tokens;
            }
          } else if (r.state === "conditional") t.conditional++;
        }
      }
      out.push(t);
    }
  }
  return out;
}

export function fixtureInstalled(m: ScopeMachine, projectId: string | undefined): InstalledJson {
  const project = projectId === undefined ? undefined : m.projects.find((p) => p.id === projectId);
  if (projectId !== undefined && project === undefined) throw new Error(`Unknown project id: ${projectId} (run \`ac projects\` first)`);
  const scopes: ScopeKind[] = project === undefined ? ["user"] : ["user", "project", "local"];
  // Only the first project carries project-level assets; the others are bare, which is common.
  const rows = markAlsoIn([...userRows(), ...(project !== undefined && project.id === "a1b2c3d4e5f6" ? projectRows(project.root) : [])]);
  const result: InstalledJson = {
    scopes,
    rows,
    totals: totals(rows, scopes),
    unsupported: [
      { harness: "codex", reason: "P6 で読み取りを足す予定(まだ読んでいない)" },
      { harness: "opencode", reason: "P6 で読み取りを足す予定(配布のターゲットとしては対応済み)" },
    ],
    notes: [
      "常時コストは静的な見積もり(字数)。トークンは推測の換算。MCP サーバーのツール定義と、ハーネス自身のシステムプロンプトは数えていない。",
      "Copilot の組み込みプラグイン(computer-use など)は状態ファイルに無いので表示していない。",
      "Copilot がプロジェクトの MCP を読むのは信頼済みのフォルダだけ。信頼の記録は ~/.copilot/config.json にあり、読まないので「不明」と表示する。",
    ],
    sources: [
      { path: `${HOME}\\.claude\\settings.json`, status: "ok" },
      { path: `${HOME}\\.copilot\\settings.json`, status: "ok" },
      { path: `${HOME}\\.claude.json`, status: "ok" },
      { path: `${HOME}\\.claude\\rules`, status: "missing" },
      ...(project !== undefined
        ? [
            { path: `${project.root}\\.claude\\settings.local.json`, status: "missing" as const },
            { path: `${project.root}\\.github\\skills\\deploy-notes\\SKILL.md`, status: "unreadable" as const, detail: "frontmatter の YAML が読めない" },
          ]
        : []),
    ],
    elapsedMs: 37,
  };
  if (project !== undefined) result.project = { id: project.id, root: project.root, name: project.name };
  return result;
}
