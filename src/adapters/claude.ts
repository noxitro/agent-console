/**
 * Claude Code adapter (SPEC §4).
 *
 * | asset  | location                          | dialect notes                     |
 * |--------|-----------------------------------|-----------------------------------|
 * | skills | `~/.claude/skills/<name>`         | junction to `~/.agents/skills/<n>` |
 * | MCP    | `~/.claude.json` → `mcpServers`   | `type` = `stdio` / `http` / `sse` |
 * | agents | `~/.claude/agents/<name>.md`      | `name` required, `tools` = string |
 *
 * Two rules from SPEC §7 hold everywhere in this file: the adapter **never
 * writes** (it only reads and returns plans), and it **never hard-codes a
 * path** (every path comes from `core/paths.ts`).
 *
 * The delicate part is `~/.claude.json` (SPEC §6.1): it is a large, live state
 * file owned by Claude Code (`oauthAccount`, project history, …). Only the
 * top-level `mcpServers` key may be touched, and `renderMcp` asserts —
 * structurally, on the re-parsed output — that every other key survived
 * unchanged.
 */

import * as path from "node:path";

import {
  AmError,
  assertValidAgentName,
  isTransport,
  type AgentDef,
  type CommandDef,
  type FileEdit,
  type LinkMode,
  type McpServer,
  type SkillLink,
  type SkillLinkKind,
  type SkillRef,
  type TargetId,
  type Transport,
} from "../core/model.js";
import {
  claudeAgentPath,
  claudeAgentsDir,
  claudeJsonPath,
  claudeSkillPath,
  claudeSkillsDir,
  sourceSkillDir,
} from "../core/paths.js";
import {
  compareDirectories,
  inspectPath,
  linkPointsTo,
  listDirNames,
  listFiles,
  readJsonFile,
  readTextFile,
  serializeJson,
} from "../core/fsops.js";
import { parseAgentFile, renderAgentFile } from "../core/frontmatter.js";
import { readManifest } from "../core/manifest.js";
import { diffSkills, type SkillDiffEntry } from "../core/diff.js";
import {
  UNSUPPORTED,
  type Adapter,
  type AdapterCapabilities,
  type AdapterPaths,
  type McpRenderOptions,
  type SkillAction,
  type Unsupported,
} from "./types.js";

/** The one top-level key of `~/.claude.json` this tool may touch (SPEC §6.1). */
const MCP_KEY = "mcpServers";

/** Agent file extension for this target (SPEC §4). */
const AGENT_EXT = ".md";

export const CLAUDE_CAPABILITIES: AdapterCapabilities = {
  agentExtension: AGENT_EXT,
  agentDialect: "claude",
  supportedTransports: ["stdio", "http", "sse"],
};

/* ------------------------------------------------------------------ */
/* MCP dialect conversion (SPEC §4)                                    */
/* ------------------------------------------------------------------ */

/**
 * Claude's on-disk server shape. `type` is the dialect word for the normalized
 * `transport`; for claude the two vocabularies happen to coincide, but the
 * conversion still goes through the normalized model so the source of truth
 * never carries dialect-specific values.
 */
interface ClaudeMcpServer {
  type?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  headers?: unknown;
  [key: string]: unknown;
}

/** normalized `transport` → claude `type` (SPEC §4 dialect table). */
function toClaudeType(transport: Transport): string {
  return transport;
}

/**
 * claude `type` → normalized `transport`.
 *
 * A missing `type` is inferred from the shape (`command` ⇒ stdio, `url` ⇒
 * http), which is what Claude Code itself accepts. An unrecognised `type` is a
 * hard error rather than a silent default — guessing here would let `apply`
 * rewrite a server into a transport the user never asked for.
 */
function fromClaudeType(raw: ClaudeMcpServer, name: string, filePath: string): Transport {
  const value = raw["type"];
  if (value === undefined || value === null || value === "") {
    if (typeof raw["command"] === "string") return "stdio";
    if (typeof raw["url"] === "string") return "http";
    throw new AmError(
      `MCP server "${name}" in ${filePath} has neither "type" nor a recognisable shape`,
      { path: filePath },
    );
  }
  if (!isTransport(value)) {
    throw new AmError(`MCP server "${name}" in ${filePath} has unsupported type "${String(value)}"`, {
      path: filePath,
    });
  }
  return value;
}

/** Render one normalized server into the claude dialect, with fixed key order. */
function renderServer(server: McpServer): Record<string, unknown> {
  const out: Record<string, unknown> = { type: toClaudeType(server.transport) };
  if (server.transport === "stdio") {
    if (server.command !== undefined) out["command"] = server.command;
    if (server.args !== undefined) out["args"] = [...server.args];
    if (server.env !== undefined) out["env"] = sortRecord(server.env);
  } else {
    if (server.url !== undefined) out["url"] = server.url;
    if (server.headers !== undefined) out["headers"] = sortRecord(server.headers);
  }
  return out;
}

/**
 * Parse one claude-dialect server back into the normalized model.
 *
 * Scalar `env` / `headers` values are coerced to strings (hand-written configs
 * routinely carry `"PORT": 8080`), matching what the vscode and copilot-cli
 * adapters do. Anything that is *not* a scalar throws: dropping the whole map —
 * or just the offending key — would be silent data loss, which SPEC §6.3
 * forbids as firmly for a well-formed-but-unexpected value as for broken JSON.
 */
function parseServer(name: string, raw: unknown, filePath: string): McpServer {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AmError(`MCP server "${name}" in ${filePath} is not an object`, { path: filePath });
  }
  const entry = raw as ClaudeMcpServer;
  const transport = fromClaudeType(entry, name, filePath);
  const server: McpServer = { transport };

  if (transport === "stdio") {
    if (typeof entry["command"] === "string") server.command = entry["command"];
    const args = entry["args"];
    if (args !== undefined && args !== null) {
      if (!Array.isArray(args)) {
        throw new AmError(`MCP server "${name}" in ${filePath} has a non-array "args"`, {
          path: filePath,
        });
      }
      server.args = args.map((a, i) => scalarToString(a, name, `args[${i}]`, filePath));
    }
    const env = entry["env"];
    if (env !== undefined && env !== null) server.env = parseStringMap(name, "env", env, filePath);
  } else {
    if (typeof entry["url"] === "string") server.url = entry["url"];
    const headers = entry["headers"];
    if (headers !== undefined && headers !== null) {
      server.headers = parseStringMap(name, "headers", headers, filePath);
    }
  }
  return server;
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

export interface ClaudeAdapterOptions {
  /**
   * Skill materialization mode. Defaults to `manifest.skills.linkMode`
   * (SPEC §2); injectable so `planSkills` stays testable without a manifest.
   */
  linkMode?: LinkMode;
}

export class ClaudeAdapter implements Adapter {
  readonly id: TargetId = "claude";
  readonly capabilities: AdapterCapabilities = CLAUDE_CAPABILITIES;

  private readonly linkModeOverride: LinkMode | undefined;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.linkModeOverride = options.linkMode;
  }

  paths(): AdapterPaths {
    return {
      mcp: claudeJsonPath(),
      agentsDir: claudeAgentsDir(),
      skillsDir: claudeSkillsDir(),
      // SPEC §10.2: `command` is an opencode-only asset kind.
      commandsDir: UNSUPPORTED,
    };
  }

  /* ---------------- real environment → normalized ---------------- */

  /**
   * Read `~/.claude.json`'s `mcpServers` (SPEC §6.1 — no other key is even
   * looked at). Missing file ⇒ `{}`; unparseable file ⇒ throw (SPEC §6.3).
   */
  readMcp(): Record<string, McpServer> {
    const filePath = claudeJsonPath();
    const doc = readJsonFile<unknown>(filePath);
    if (doc === null) return {};
    const root = asDocument(doc, filePath);
    const raw = root[MCP_KEY];
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new AmError(`"${MCP_KEY}" in ${filePath} is not an object`, { path: filePath });
    }
    const servers: Record<string, McpServer> = {};
    for (const name of Object.keys(raw as Record<string, unknown>).sort()) {
      servers[name] = parseServer(name, (raw as Record<string, unknown>)[name], filePath);
    }
    return servers;
  }

  /**
   * The `mcpServers` entries verbatim, for the preservation path in `plan`
   * (see {@link McpRenderOptions}). Same validation as {@link readMcp}: the
   * document must be an object and `mcpServers` a map of objects.
   */
  readRawMcp(): Record<string, unknown> {
    const filePath = claudeJsonPath();
    const doc = readJsonFile<unknown>(filePath);
    if (doc === null) return {};
    const raw = asDocument(doc, filePath)[MCP_KEY];
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new AmError(`"${MCP_KEY}" in ${filePath} is not an object`, { path: filePath });
    }
    const out: Record<string, unknown> = {};
    for (const name of Object.keys(raw as Record<string, unknown>).sort()) {
      const entry = (raw as Record<string, unknown>)[name];
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new AmError(`MCP server "${name}" in ${filePath} is not an object`, {
          path: filePath,
        });
      }
      out[name] = entry;
    }
    return out;
  }

  /**
   * Read `~/.claude/agents/*.md` as normalized agents.
   *
   * Parsing is lenient: claude only requires `name` (SPEC §4), and files
   * authored by hand often omit `description`. Malformed YAML still throws.
   */
  readAgents(): AgentDef[] {
    const dir = claudeAgentsDir();
    const agents: AgentDef[] = [];
    for (const file of listFiles(dir, AGENT_EXT)) {
      const full = path.join(dir, file);
      const text = readTextFile(full);
      if (text === null) continue;
      agents.push(
        parseAgentFile(text, {
          fallbackName: file.slice(0, -AGENT_EXT.length),
          sourcePath: full,
          lenient: true,
        }),
      );
    }
    return agents.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * SPEC §10.2: only opencode carries user-added commands. Claude Code's own
   * slash commands are a different mechanism this tool does not manage, so the
   * honest answer is "not supported here", not an empty list.
   */
  readCommands(): Unsupported {
    return UNSUPPORTED;
  }

  /** Inspect `~/.claude/skills/`: junction / symlink / real directory / file. */
  readSkillLinks(): SkillLink[] {
    const dir = claudeSkillsDir();
    const names = new Set<string>([...listDirNames(dir), ...listFiles(dir)]);
    return [...names].sort().map((name) => inspectSkill(name, claudeSkillPath(name)));
  }

  /* ---------------- normalized → real environment ---------------- */

  /**
   * Produce the full new text of `~/.claude.json` with only `mcpServers`
   * swapped (SPEC §6.1).
   *
   * The read → replace → serialize sequence happens here so `apply` performs a
   * single atomic write. Before returning, the rendered text is re-parsed and
   * every non-`mcpServers` key is compared structurally against the original;
   * any divergence throws rather than risking a live state file.
   *
   * `options.preserve` entries are copied in **untouched** — an unmanaged
   * server keeps its `env`, its `timeout`, and every other key Claude Code
   * understands but the normalized schema does not (SPEC §5).
   */
  renderMcp(servers: Record<string, McpServer>, options: McpRenderOptions = {}): FileEdit[] {
    const filePath = claudeJsonPath();
    const existing = readJsonFile<unknown>(filePath);
    const root: Record<string, unknown> =
      existing === null ? {} : asDocument(existing, filePath);

    const rendered: Record<string, unknown> = {};
    const preserve = options.preserve ?? {};
    for (const name of new Set([...Object.keys(servers), ...Object.keys(preserve)].sort())) {
      const server = servers[name];
      if (server !== undefined) {
        rendered[name] = renderServer(server);
        continue;
      }
      const raw = preserve[name];
      if (raw !== undefined) rendered[name] = raw;
    }

    // Nothing to deliver and no `mcpServers` key on disk: leave the live state
    // file alone rather than editing it purely to add an empty map (SPEC §6.1's
    // minimal-touch discipline). A missing file is `plan`'s call, not ours.
    if (Object.keys(rendered).length === 0 && existing !== null && !(MCP_KEY in root)) {
      return [];
    }

    // Rebuild preserving the original key order, so a no-op render is
    // byte-identical to what is already on disk (the SPEC §8 fixed point).
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(root)) {
      next[key] = key === MCP_KEY ? rendered : root[key];
    }
    if (!(MCP_KEY in next)) next[MCP_KEY] = rendered;

    const content = serializeJson(next);
    assertOtherKeysPreserved(root, content, filePath);
    return [{ path: filePath, content }];
  }

  /** One `.md` file per agent, `tools` rendered as a comma-separated string. */
  renderAgents(agents: readonly AgentDef[]): FileEdit[] {
    return [...agents]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((agent) => {
        assertValidAgentName(agent.name);
        return {
          path: claudeAgentPath(agent.name),
          content: renderAgentFile(agent, this.capabilities.agentDialect),
        };
      });
  }

  /** SPEC §10.2: nothing to render — this target has no command directory. */
  renderCommands(_commands: readonly CommandDef[]): Unsupported {
    void _commands;
    return UNSUPPORTED;
  }

  /** Plan `~/.claude/skills/<name>` materialization (SPEC §6.6 via `diffSkills`). */
  planSkills(skills: readonly SkillRef[]): SkillAction[] {
    const linkMode = this.linkMode();
    const entries: SkillDiffEntry[] = [...skills]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((skill) => buildSkillEntry(skill, claudeSkillPath(skill.name)));

    const wanted = new Set(skills.map((s) => s.name.toLowerCase()));
    const orphans = this.readSkillLinks().filter(
      (link) =>
        !wanted.has(link.name.toLowerCase()) &&
        !skillExistsInSource(link.name) &&
        isManagedSkillSlot(link),
    );

    return diffSkills({ target: this.id, linkMode, entries, orphans });
  }

  private linkMode(): LinkMode {
    return this.linkModeOverride ?? readManifest().skills.linkMode;
  }
}

/** Convenience factory mirroring the other adapters. */
export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): ClaudeAdapter {
  return new ClaudeAdapter(options);
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

/** `~/.claude.json` must be a JSON object; anything else is a hard error. */
function asDocument(value: unknown, filePath: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AmError(`${filePath} is not a JSON object`, { path: filePath });
  }
  return value as Record<string, unknown>;
}

/**
 * SPEC §6.1's mandatory assertion: after swapping `mcpServers`, the set of
 * other top-level keys — and their values, compared structurally rather than
 * byte-wise — must be identical to the original document.
 */
function assertOtherKeysPreserved(
  original: Record<string, unknown>,
  renderedText: string,
  filePath: string,
): void {
  let reparsed: unknown;
  try {
    reparsed = JSON.parse(renderedText);
  } catch (err) {
    throw new AmError(`Rendered ${filePath} is not valid JSON`, { path: filePath, cause: err });
  }
  const next = asDocument(reparsed, filePath);

  const before = Object.keys(original).filter((k) => k !== MCP_KEY).sort();
  const after = Object.keys(next).filter((k) => k !== MCP_KEY).sort();
  if (before.length !== after.length || before.some((k, i) => k !== after[i])) {
    throw new AmError(
      `Refusing to write ${filePath}: top-level keys other than "${MCP_KEY}" changed ` +
        `(before: [${before.join(", ")}], after: [${after.join(", ")}])`,
      { path: filePath },
    );
  }
  for (const key of before) {
    if (JSON.stringify(original[key]) !== JSON.stringify(next[key])) {
      throw new AmError(
        `Refusing to write ${filePath}: top-level key "${key}" would be modified`,
        { path: filePath },
      );
    }
  }
}

/**
 * Classify what occupies a skill slot.
 *
 * Node cannot report a reparse-point type, so junction vs. symlink is inferred
 * from the destination form: Windows junctions read back as `\\?\`-prefixed
 * absolute paths. Both kinds are handled identically by `diffSkills`, so the
 * distinction only affects what `inventory` prints.
 */
function inspectSkill(name: string, target: string): SkillLink {
  const info = inspectPath(target);
  let kind: SkillLinkKind;
  // Absence is the one thing this cannot guess. `inspectPath` reports a failed
  // `lstat` that was not ENOENT/ENOTDIR as `unreadable`, and it comes first:
  // everything below reads `exists: false` as 「無い」, which is exactly the
  // claim we are not entitled to make about a slot we were refused (SPEC §9.7).
  if (info.unreadable !== undefined) {
    kind = "unreadable";
  } else if (!info.exists) {
    kind = "missing";
  } else if (info.isLink) {
    kind = info.isBroken ? "broken" : isJunctionTarget(info.linkTarget) ? "junction" : "symlink";
  } else if (info.isDirectory) {
    kind = "directory";
  } else {
    kind = "file";
  }
  const link: SkillLink = { name, path: target, kind };
  if (info.unreadable !== undefined) link.unreadable = info.unreadable;
  if (info.linkTarget !== undefined) link.linkTarget = info.linkTarget;
  return link;
}

function isJunctionTarget(linkTarget: string | undefined): boolean {
  return process.platform === "win32" && linkTarget !== undefined && linkTarget.startsWith("\\\\?\\");
}

/** Gather the current state of one skill slot for `diffSkills`. */
function buildSkillEntry(skill: SkillRef, targetPath: string): SkillDiffEntry {
  const link = inspectSkill(skill.name, targetPath);
  const entry: SkillDiffEntry = {
    name: skill.name,
    sourcePath: skill.sourcePath,
    targetPath,
    link,
  };
  if (link.kind === "junction" || link.kind === "symlink") {
    entry.linkResolvesToSource = linkPointsTo(targetPath, skill.sourcePath);
  }
  if (link.kind === "directory") {
    // SPEC §9.5: the comparison is three-valued. "Could not read the tree" is
    // carried through as its own outcome instead of being flattened into
    // "differs", which `diffSkills` would otherwise blame on the user.
    const comparison = compareDirectories(skill.sourcePath, targetPath);
    if (comparison.status === "incomparable") {
      entry.contentIncomparable = `${comparison.reason} under ${comparison.path}`;
    } else {
      entry.contentIdentical = comparison.status === "identical";
    }
  }
  return entry;
}

/**
 * True when a skill still exists in the source of truth. Used to keep an
 * *excluded* skill (SPEC §2 `skills.exclude`) from being reported as an
 * orphaned `delete`: it is absent from the delivery list but is not "ソースに
 * 無い" (SPEC §5).
 */
function skillExistsInSource(name: string): boolean {
  return inspectPath(sourceSkillDir(name)).exists;
}

/**
 * True when a slot in `~/.claude/skills/` could plausibly hold a **skill this
 * tool manages**. `readSkillLinks` deliberately reports plain files too (so
 * `doctor` can flag one squatting on a skill path), but SPEC §5 scopes `delete`
 * to 管理下資産: a stray `notes.txt` or `desktop.ini` the user dropped in the
 * directory was never managed, and `apply --prune --yes` must not remove it.
 */
function isManagedSkillSlot(link: SkillLink): boolean {
  // `unreadable` is excluded for a stronger reason than `file` is (SPEC §9.7).
  // A stray file is something we can see and have decided not to own; an
  // unreadable slot is one we could not look at, and `--prune` derives `delete`
  // from this predicate. Deriving a deletion from a reading nobody took is the
  // one thing this codebase refuses to do.
  return link.kind !== "file" && link.kind !== "missing" && link.kind !== "unreadable";
}

/** Coerce a scalar to a string; anything else is an error, never a silent drop. */
function scalarToString(value: unknown, name: string, where: string, filePath: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new AmError(`MCP server "${name}" in ${filePath} has a non-scalar "${where}"`, {
    path: filePath,
  });
}

/** Parse an `env` / `headers` map, coercing scalars and rejecting the rest. */
function parseStringMap(
  name: string,
  key: string,
  value: unknown,
  filePath: string,
): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AmError(`MCP server "${name}" in ${filePath} has a non-object "${key}"`, {
      path: filePath,
    });
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of Object.keys(record).sort()) {
    out[k] = scalarToString(record[k], name, `${key}.${k}`, filePath);
  }
  return out;
}

/** Sort a string map's keys so rendered output is byte-stable (SPEC §8). */
function sortRecord(record: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
