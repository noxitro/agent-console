/**
 * The scope layer (ARCHITECTURE.md「フェーズとゲート」P2「単位とプロジェクト」).
 *
 * The existing engine answers one question about one place: what the *user*
 * (個人) level of each target holds. This module adds the other two places a
 * harness reads from — a project's own files (プロジェクト) and the per-project
 * entries the harness keeps for itself outside the repository (ローカル) — and
 * says, per name, which of the places actually wins.
 *
 * It is read-only in the strictest sense: nothing here writes, and the adapters
 * it borrows are asked only for what they already read. The single file the
 * scope layer writes is the discovery cache (`projects.ts`).
 *
 * Two rules carry over from PRODUCT, and they shape the table below:
 *
 *  - **Every location is labelled with how it is known.** The table is the
 *    result of spikes S11 / S12: each row says whether an official document
 *    states it (公式) or not. A location that is not officially documented is
 *    still listed, because the files are real, but every asset found there is
 *    marked `unverified` and the console draws it 未確認 — it never claims a
 *    harness reads something nobody has confirmed it reads.
 *  - **Precedence is only applied where it is documented.** A row is called
 *    shadowed (上書きされて効いていない) only when the precedence that makes it so
 *    is official. Where it is not, nothing is claimed either way.
 */

import * as path from "node:path";

import { parse as parseJsonc, type ParseError } from "jsonc-parser";

import { isUnsupported, type Adapter } from "../adapters/types.js";
import type { AssetKind } from "./diff.js";
import { listDirNames, listFiles, readTextFile } from "./fsops.js";
import { parseFrontmatter } from "./frontmatter.js";
import type { TargetId } from "./model.js";
import {
  claudeJsonPath,
  projectClaudeAgentsDir,
  projectClaudeSkillsDir,
  projectAgentsSkillsDir,
  projectGithubAgentsDir,
  projectGithubMcpPath,
  projectGithubSkillsDir,
  projectRootMcpPath,
  projectVscodeMcpPath,
  skillManifestPath,
} from "./paths.js";
import { folderKey, gitRootOf, type DiscoveredProject } from "./projects.js";

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/** 個人 / プロジェクト / ローカル. */
export type Scope = "user" | "project" | "local";

export const SCOPES: readonly Scope[] = ["user", "project", "local"];

/**
 * How a location or a precedence rule is known (the spikes' 確度).
 *
 *  - 公式: an official document of the harness states it;
 *  - 実測: measured on a real machine, not documented;
 *  - 既報: reported elsewhere (changelog, issue), not in the documentation;
 *  - 推測: inferred.
 *
 * Only 公式 counts as verified. The others are kept in the table so the reason
 * for a 未確認 mark can be read off it.
 */
export type Confidence = "公式" | "実測" | "既報" | "推測";

/** What kind of file a location is, and therefore how it is read. */
type LocationReader =
  | { kind: "skills-dir" }
  | { kind: "agents-dir" }
  | { kind: "mcp-file"; key: "mcpServers" | "servers"; jsonc: boolean }
  | { kind: "claude-local-mcp" };

export interface ScopeLocation {
  target: TargetId;
  assetType: AssetKind;
  scope: Exclude<Scope, "user">;
  /** How the location is spelled for a person, root-relative. */
  label: string;
  confidence: Confidence;
  /** The document (or note) the confidence rests on. */
  basis: string;
  reader: LocationReader;
  /** The directory or file for one project. */
  at(root: string): string;
}

export interface PrecedenceRule {
  target: TargetId;
  assetType: AssetKind;
  /** Highest first: the first scope that holds a name is the one that applies. */
  order: readonly Scope[];
  confidence: Confidence;
  basis: string;
}

/* ------------------------------------------------------------------ */
/* The table (S11 / S12 — docs/ARCHITECTURE.md「単位の置き場所」)       */
/* ------------------------------------------------------------------ */

const CLAUDE_MCP_DOC = "https://code.claude.com/docs/en/mcp";
const CLAUDE_SKILLS_DOC = "https://code.claude.com/docs/en/skills";
const CLAUDE_AGENTS_DOC = "https://code.claude.com/docs/en/sub-agents";
const COPILOT_SKILLS_DOC =
  "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills";
const COPILOT_AGENTS_DOC =
  "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli";
const COPILOT_MCP_DOC =
  "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers";
const COPILOT_CHANGELOG = "https://github.com/github/copilot-cli/blob/main/changelog.md";
const VSCODE_MCP_DOC = "https://code.visualstudio.com/docs/agents/reference/mcp-configuration";
const VSCODE_AGENTS_DOC =
  "https://code.visualstudio.com/docs/agents/reference/custom-agent-file-reference";
const VSCODE_SKILLS_DOC = "https://code.visualstudio.com/docs/agent-customization/agent-skills";

type LocationRow = Omit<ScopeLocation, "target" | "confidence" | "basis"> & {
  readers: readonly { target: TargetId; confidence: Confidence; basis: string }[];
};

/**
 * One row per *place*; `readers` are the targets documented (or reported) to
 * read it. `.claude/skills` is read by all three harnesses, and is one place.
 */
const LOCATION_ROWS: readonly LocationRow[] = [
  {
    assetType: "skill",
    scope: "project",
    label: ".claude/skills/<name>/SKILL.md",
    reader: { kind: "skills-dir" },
    at: projectClaudeSkillsDir,
    readers: [
      { target: "claude", confidence: "公式", basis: CLAUDE_SKILLS_DOC },
      { target: "copilot-cli", confidence: "公式", basis: COPILOT_SKILLS_DOC },
      { target: "vscode", confidence: "公式", basis: VSCODE_SKILLS_DOC },
    ],
  },
  {
    assetType: "skill",
    scope: "project",
    label: ".github/skills/<name>/SKILL.md",
    reader: { kind: "skills-dir" },
    at: projectGithubSkillsDir,
    readers: [
      { target: "copilot-cli", confidence: "公式", basis: COPILOT_SKILLS_DOC },
      { target: "vscode", confidence: "公式", basis: VSCODE_SKILLS_DOC },
    ],
  },
  {
    assetType: "skill",
    scope: "project",
    label: ".agents/skills/<name>/SKILL.md",
    reader: { kind: "skills-dir" },
    at: projectAgentsSkillsDir,
    readers: [
      { target: "copilot-cli", confidence: "公式", basis: COPILOT_SKILLS_DOC },
      { target: "vscode", confidence: "公式", basis: VSCODE_SKILLS_DOC },
    ],
  },
  {
    assetType: "agent",
    scope: "project",
    label: ".claude/agents/<name>.md",
    reader: { kind: "agents-dir" },
    at: projectClaudeAgentsDir,
    readers: [
      { target: "claude", confidence: "公式", basis: CLAUDE_AGENTS_DOC },
      // Documented only in the CLI's changelog, not in its manual.
      { target: "copilot-cli", confidence: "既報", basis: COPILOT_CHANGELOG },
      { target: "vscode", confidence: "公式", basis: VSCODE_AGENTS_DOC },
    ],
  },
  {
    assetType: "agent",
    scope: "project",
    label: ".github/agents/<name>.agent.md",
    reader: { kind: "agents-dir" },
    at: projectGithubAgentsDir,
    readers: [
      { target: "copilot-cli", confidence: "公式", basis: COPILOT_AGENTS_DOC },
      { target: "vscode", confidence: "公式", basis: VSCODE_AGENTS_DOC },
    ],
  },
  {
    assetType: "mcp",
    scope: "project",
    label: ".mcp.json (mcpServers)",
    reader: { kind: "mcp-file", key: "mcpServers", jsonc: false },
    at: projectRootMcpPath,
    readers: [
      { target: "claude", confidence: "公式", basis: CLAUDE_MCP_DOC },
      { target: "copilot-cli", confidence: "公式", basis: COPILOT_MCP_DOC },
      { target: "vscode", confidence: "公式", basis: VSCODE_MCP_DOC },
    ],
  },
  {
    assetType: "mcp",
    scope: "project",
    label: ".github/mcp.json (mcpServers)",
    reader: { kind: "mcp-file", key: "mcpServers", jsonc: false },
    at: projectGithubMcpPath,
    readers: [{ target: "copilot-cli", confidence: "公式", basis: COPILOT_MCP_DOC }],
  },
  {
    assetType: "mcp",
    scope: "project",
    label: ".vscode/mcp.json (servers)",
    reader: { kind: "mcp-file", key: "servers", jsonc: true },
    at: projectVscodeMcpPath,
    // Copilot CLI stopped reading it in 1.0.22 (changelog), so it is VS Code's alone.
    readers: [{ target: "vscode", confidence: "公式", basis: VSCODE_MCP_DOC }],
  },
  {
    assetType: "mcp",
    scope: "local",
    label: "~/.claude.json projects[<path>].mcpServers",
    reader: { kind: "claude-local-mcp" },
    at: () => claudeJsonPath(),
    readers: [{ target: "claude", confidence: "公式", basis: CLAUDE_MCP_DOC }],
  },
];

export const SCOPE_LOCATIONS: readonly ScopeLocation[] = LOCATION_ROWS.flatMap(
  ({ readers, ...place }) => readers.map((reader) => ({ ...place, ...reader })),
);

/**
 * Which place wins on a name collision. Only rows marked 公式 are applied (see
 * the module comment); the others are recorded so the table can be read whole.
 */
export const PRECEDENCE_RULES: readonly PrecedenceRule[] = [
  { target: "claude", assetType: "mcp", order: ["local", "project", "user"], confidence: "公式", basis: CLAUDE_MCP_DOC },
  // 「enterprise > personal > project」: the user's own skill wins.
  { target: "claude", assetType: "skill", order: ["user", "project"], confidence: "公式", basis: CLAUDE_SKILLS_DOC },
  // The other way round for subagents: the project's definition wins.
  { target: "claude", assetType: "agent", order: ["project", "user"], confidence: "公式", basis: CLAUDE_AGENTS_DOC },
  { target: "copilot-cli", assetType: "mcp", order: ["project", "user"], confidence: "公式", basis: COPILOT_MCP_DOC },
  // The CLI's agents: the user-level file wins over the repository's.
  { target: "copilot-cli", assetType: "agent", order: ["user", "project"], confidence: "公式", basis: COPILOT_AGENTS_DOC },
  // Stated in the changelog (1.0.55) only, so recorded and not applied.
  { target: "copilot-cli", assetType: "skill", order: ["project", "user"], confidence: "既報", basis: COPILOT_CHANGELOG },
];

export function precedenceFor(target: TargetId, assetType: AssetKind): PrecedenceRule | undefined {
  return PRECEDENCE_RULES.find((r) => r.target === target && r.assetType === assetType);
}

/* ------------------------------------------------------------------ */
/* What a listing holds                                                */
/* ------------------------------------------------------------------ */

/** Where an asset was found — the place a person would open to look at it. */
export interface ScopePlace {
  scope: Scope;
  /** The directory (skill), file (agent, MCP config) or state file (local). */
  path: string;
  /** The key inside `path` that holds it, when the file holds many projects. */
  entry?: string;
}

/** One target that reads a scoped asset, and how that is known. */
export interface ScopedReader {
  target: TargetId;
  /** The location is not officially documented for this target (S11 / S12). */
  unverified?: true;
  /** A higher-precedence place holds the same name for this target. */
  shadowedBy?: ScopePlace;
}

export interface ScopedAsset {
  assetType: AssetKind;
  name: string;
  scope: Exclude<Scope, "user">;
  /** The project's root (git working tree). */
  project: string;
  path: string;
  entry?: string;
  readers: ScopedReader[];
  description?: string;
  /** MCP transport, or an agent's model — the table's second column. */
  kindNote?: string;
  /** The file is there and could not be read; its other fields are absent. */
  unreadable?: string;
}

/** A user-level asset that a project or local entry overrides, per target. */
export interface UserShadow {
  target: TargetId;
  assetType: AssetKind;
  name: string;
  project: string;
  by: ScopePlace;
}

/** A location that exists and could not be listed. Reported, never read as empty. */
export interface ScopeFault {
  target: TargetId;
  assetType: AssetKind;
  scope: Exclude<Scope, "user">;
  project: string;
  path: string;
  message: string;
}

export interface ScopeListing {
  assets: ScopedAsset[];
  shadows: UserShadow[];
  faults: ScopeFault[];
}

/** The user-level names each target holds right now, for the precedence check. */
export type UserNames = Partial<Record<TargetId, Partial<Record<AssetKind, ReadonlySet<string>>>>>;

/* ------------------------------------------------------------------ */
/* Reading one location                                                */
/* ------------------------------------------------------------------ */

interface Found {
  name: string;
  path: string;
  entry?: string;
  description?: string;
  kindNote?: string;
  unreadable?: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readSkillsDir(dir: string): Found[] {
  const found: Found[] = [];
  for (const name of listDirNames(dir)) {
    const skillDir = path.join(dir, name);
    let text: string | null;
    try {
      text = readTextFile(skillManifestPath(skillDir));
    } catch (err) {
      found.push({ name, path: skillDir, unreadable: message(err) });
      continue;
    }
    // A directory without SKILL.md is not a skill any harness loads.
    if (text === null) continue;
    try {
      const { data } = parseFrontmatter(text, skillManifestPath(skillDir));
      const description = data["description"];
      found.push({
        name,
        path: skillDir,
        ...(typeof description === "string" ? { description } : {}),
      });
    } catch (err) {
      found.push({ name, path: skillDir, unreadable: message(err) });
    }
  }
  return found;
}

function readAgentsDir(dir: string): Found[] {
  const found: Found[] = [];
  for (const file of listFiles(dir, ".md")) {
    // Both spellings are agent files (`<name>.agent.md` and `<name>.md`); the
    // name is the frontmatter `name` when there is one, the stem otherwise.
    const stem = file.endsWith(".agent.md") ? file.slice(0, -".agent.md".length) : file.slice(0, -".md".length);
    const full = path.join(dir, file);
    try {
      const text = readTextFile(full) ?? "";
      const { data } = parseFrontmatter(text, full);
      const name = typeof data["name"] === "string" && data["name"] !== "" ? data["name"] : stem;
      const description = data["description"];
      const model = data["model"];
      found.push({
        name,
        path: full,
        ...(typeof description === "string" ? { description } : {}),
        ...(typeof model === "string" ? { kindNote: model } : {}),
      });
    } catch (err) {
      found.push({ name: stem, path: full, unreadable: message(err) });
    }
  }
  return found;
}

/**
 * The transport a server entry *states*. A stdio server may leave `type` out
 * (both dialects default it); a remote one with no `type` is left blank rather
 * than guessed between http and sse.
 */
function transportOf(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record["type"] === "string") return record["type"];
  if (typeof record["command"] === "string") return "stdio";
  return undefined;
}

function serversIn(doc: unknown, key: string): Record<string, unknown> {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return {};
  const servers = (doc as Record<string, unknown>)[key];
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return {};
  return servers as Record<string, unknown>;
}

function parseConfig(file: string, jsonc: boolean): unknown {
  const text = readTextFile(file);
  if (text === null) return null;
  if (!jsonc) {
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`JSON として読めません: ${file} (${message(err)})`);
    }
  }
  const errors: ParseError[] = [];
  const doc: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error(`JSONC として読めません: ${file}`);
  return doc;
}

function readMcpFile(file: string, key: string, jsonc: boolean): Found[] {
  const doc = parseConfig(file, jsonc);
  if (doc === null) return [];
  const servers = serversIn(doc, key);
  return Object.keys(servers)
    .sort()
    .map((name) => {
      const transport = transportOf(servers[name]);
      return { name, path: file, ...(transport !== undefined ? { kindNote: transport } : {}) };
    });
}

/**
 * `~/.claude.json` `projects[<folder>].mcpServers` for every recorded folder in
 * this project's working tree.
 *
 * The file is parsed once per listing (by the caller) and only the
 * `mcpServers` of matching keys are looked at; account and usage state in the
 * same document is never copied out.
 */
function readClaudeLocalMcp(root: string, claudeProjects: Record<string, unknown> | null): Found[] {
  if (claudeProjects === null) return [];
  const found: Found[] = [];
  const rootKey = folderKey(root);
  for (const folder of Object.keys(claudeProjects).sort()) {
    // Servers first: most recorded folders have none, and the git walk is the
    // expensive half (it runs once per folder per project otherwise).
    const servers = serversIn(claudeProjects[folder], "mcpServers");
    if (Object.keys(servers).length === 0) continue;
    const gitRoot = gitRootOf(folder);
    if (gitRoot === null || folderKey(gitRoot) !== rootKey) continue;
    for (const name of Object.keys(servers).sort()) {
      const transport = transportOf(servers[name]);
      found.push({
        name,
        path: claudeJsonPath(),
        entry: `projects["${folder}"].mcpServers`,
        ...(transport !== undefined ? { kindNote: transport } : {}),
      });
    }
  }
  return found;
}

/** The `projects` map of `~/.claude.json`, or null when there is none to read. */
export function readClaudeProjectsMap(): { map: Record<string, unknown> | null; error?: string } {
  let text: string | null;
  try {
    text = readTextFile(claudeJsonPath());
  } catch (err) {
    return { map: null, error: message(err) };
  }
  if (text === null) return { map: null };
  try {
    const doc: unknown = JSON.parse(text);
    const projects =
      typeof doc === "object" && doc !== null ? (doc as Record<string, unknown>)["projects"] : undefined;
    if (typeof projects !== "object" || projects === null || Array.isArray(projects)) return { map: null };
    return { map: projects as Record<string, unknown> };
  } catch (err) {
    return { map: null, error: `JSON として読めません: ${claudeJsonPath()} (${message(err)})` };
  }
}

/* ------------------------------------------------------------------ */
/* User-level names (borrowed from the adapters)                       */
/* ------------------------------------------------------------------ */

/**
 * What each target holds at the user level, as names. The adapters are the
 * only readers of those places, so they are asked; one that cannot be read
 * contributes nothing, and nothing is then claimed about precedence over it.
 */
export function userNamesFrom(adapters: readonly Adapter[]): UserNames {
  const names: UserNames = {};
  for (const adapter of adapters) {
    const kinds: Partial<Record<AssetKind, ReadonlySet<string>>> = {};
    try {
      const links = adapter.readSkillLinks();
      if (!isUnsupported(links)) {
        kinds.skill = new Set(links.filter((l) => l.kind !== "missing").map((l) => l.name));
      }
    } catch {
      /* unreadable: no claim */
    }
    try {
      const servers = adapter.readMcp();
      if (!isUnsupported(servers)) kinds.mcp = new Set(Object.keys(servers));
    } catch {
      /* unreadable: no claim */
    }
    try {
      const agents = adapter.readAgents();
      if (!isUnsupported(agents)) kinds.agent = new Set(agents.map((a) => a.name));
    } catch {
      /* unreadable: no claim */
    }
    names[adapter.id] = kinds;
  }
  return names;
}

function userPlace(adapter: Adapter | undefined, assetType: AssetKind): string {
  if (adapter === undefined) return "";
  const paths = adapter.paths();
  const value =
    assetType === "skill"
      ? paths.skillsDir
      : assetType === "mcp"
        ? paths.mcp
        : assetType === "agent"
          ? paths.agentsDir
          : paths.commandsDir;
  return isUnsupported(value) ? "" : value;
}

/* ------------------------------------------------------------------ */
/* Listing                                                             */
/* ------------------------------------------------------------------ */

export interface ListScopesInput {
  projects: readonly DiscoveredProject[];
  /** The adapters for the user level (all five, enabled or not). */
  adapters: readonly Adapter[];
  /** Overrides for tests; read from the adapters / `~/.claude.json` otherwise. */
  userNames?: UserNames;
  claudeProjects?: Record<string, unknown> | null;
}

/** Everything the project and local scopes hold, for every discovered project. */
export function listScopes(input: ListScopesInput): ScopeListing {
  const userNames = input.userNames ?? userNamesFrom(input.adapters);
  const faults: ScopeFault[] = [];
  let claudeProjects = input.claudeProjects;
  if (claudeProjects === undefined) {
    const read = readClaudeProjectsMap();
    claudeProjects = read.map;
  }

  const assets: ScopedAsset[] = [];
  const shadows: UserShadow[] = [];

  for (const project of input.projects) {
    const byPlace = new Map<string, ScopedAsset>();
    /** Per (target, kind, name): the places holding it in this project. */
    const holders = new Map<string, { scope: Scope; place: ScopePlace; asset: ScopedAsset }[]>();

    for (const location of SCOPE_LOCATIONS) {
      const at = location.at(project.root);
      let found: Found[];
      try {
        switch (location.reader.kind) {
          case "skills-dir":
            found = readSkillsDir(at);
            break;
          case "agents-dir":
            found = readAgentsDir(at);
            break;
          case "mcp-file":
            found = readMcpFile(at, location.reader.key, location.reader.jsonc);
            break;
          case "claude-local-mcp":
            found = readClaudeLocalMcp(project.root, claudeProjects ?? null);
            break;
        }
      } catch (err) {
        faults.push({
          target: location.target,
          assetType: location.assetType,
          scope: location.scope,
          project: project.root,
          path: at,
          message: message(err),
        });
        continue;
      }

      for (const item of found) {
        // One file read by two targets (`.github/agents` by Copilot CLI and VS
        // Code) is one row with two readers, not two rows.
        const placeKey = `${location.assetType}\u0000${item.path}\u0000${item.entry ?? ""}\u0000${item.name}`;
        let asset = byPlace.get(placeKey);
        if (asset === undefined) {
          asset = {
            assetType: location.assetType,
            name: item.name,
            scope: location.scope,
            project: project.root,
            path: item.path,
            ...(item.entry !== undefined ? { entry: item.entry } : {}),
            readers: [],
            ...(item.description !== undefined ? { description: item.description } : {}),
            ...(item.kindNote !== undefined ? { kindNote: item.kindNote } : {}),
            ...(item.unreadable !== undefined ? { unreadable: item.unreadable } : {}),
          };
          byPlace.set(placeKey, asset);
          assets.push(asset);
        }
        if (!asset.readers.some((r) => r.target === location.target)) {
          asset.readers.push({
            target: location.target,
            ...(location.confidence !== "公式" ? { unverified: true as const } : {}),
          });
        }
        const holderKey = `${location.target}\u0000${location.assetType}\u0000${item.name}`;
        const list = holders.get(holderKey) ?? [];
        list.push({
          scope: location.scope,
          place: { scope: location.scope, path: item.path, ...(item.entry !== undefined ? { entry: item.entry } : {}) },
          asset,
        });
        holders.set(holderKey, list);
      }
    }

    // Precedence, applied only where it is documented.
    for (const [key, list] of holders) {
      const [target, assetType, name] = key.split("\u0000") as [TargetId, AssetKind, string];
      const rule = precedenceFor(target, assetType);
      if (rule === undefined || rule.confidence !== "公式") continue;
      const userHas = userNames[target]?.[assetType]?.has(name) === true;
      const adapter = input.adapters.find((a) => a.id === target);
      const all: { scope: Scope; place: ScopePlace; asset?: ScopedAsset }[] = [...list];
      if (userHas) all.push({ scope: "user", place: { scope: "user", path: userPlace(adapter, assetType) } });
      const rank = (scope: Scope): number => {
        const i = rule.order.indexOf(scope);
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
      };
      const winner = [...all].sort((a, b) => rank(a.scope) - rank(b.scope))[0];
      if (winner === undefined) continue;
      for (const holder of all) {
        if (holder === winner || holder.scope === winner.scope) continue;
        if (holder.asset !== undefined) {
          const reader = holder.asset.readers.find((r) => r.target === target);
          if (reader !== undefined && reader.shadowedBy === undefined) reader.shadowedBy = winner.place;
        } else {
          shadows.push({ target, assetType, name, project: project.root, by: winner.place });
        }
      }
    }
  }

  for (const asset of assets) asset.readers.sort((a, b) => a.target.localeCompare(b.target));
  return { assets, shadows, faults };
}
