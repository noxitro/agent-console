/**
 * The source of truth: `~/.agents-manager/` + `~/.agents/skills/` (SPEC §2).
 *
 * `core/manifest.ts` owns `manifest.json`; this module owns the other three
 * source artefacts — `mcp/servers.json`, `agents/<name>.md`, and the skill
 * directories — and nothing else. Reading is available to every command;
 * the `write*` helpers exist for `commands/import.ts`, which is the only
 * command allowed to populate the source (SPEC §5). No function here ever
 * touches a *target* path: target writes are centralized in
 * `commands/apply.ts` (SPEC §7).
 *
 * Validation follows SPEC §6.3: a file that exists but cannot be understood
 * throws, and is never degraded into "empty data".
 */

import * as path from "node:path";

import {
  AmError,
  assertValidAgentName,
  assertValidCommandName,
  isTargetId,
  isTransport,
  type AgentDef,
  type CommandDef,
  type McpServer,
  type McpSourceFile,
  type SkillRef,
  type TargetId,
} from "./model.js";
import {
  inspectPath,
  listDirNames,
  listFiles,
  modifiedAt,
  readJsonFile,
  readTextFile,
  serializeJson,
  writeFileAtomic,
} from "./fsops.js";
import {
  parseAgentFile,
  parseCommandFile,
  parseFrontmatter,
  renderSourceAgentFile,
  renderSourceCommandFile,
} from "./frontmatter.js";
import {
  SKILL_LOCK_FILE,
  skillLockPath,
  skillManifestPath,
  sourceAgentPath,
  sourceAgentsDir,
  sourceCommandPath,
  sourceCommandsDir,
  sourceMcpPath,
  sourceSkillDir,
  sourceSkillsDir,
} from "./paths.js";

/* ------------------------------------------------------------------ */
/* MCP servers                                                         */
/* ------------------------------------------------------------------ */

/** Canonical key order for a rendered source server entry. */
function renderSourceServer(server: McpServer): Record<string, unknown> {
  const out: Record<string, unknown> = { transport: server.transport };
  if (server.transport === "stdio") {
    if (server.command !== undefined) out["command"] = server.command;
    if (server.args !== undefined) out["args"] = [...server.args];
    if (server.env !== undefined) out["env"] = sortedStringMap(server.env);
  } else {
    if (server.url !== undefined) out["url"] = server.url;
    if (server.headers !== undefined) out["headers"] = sortedStringMap(server.headers);
  }
  if (server.targets !== undefined) out["targets"] = [...server.targets];
  return out;
}

/**
 * Validate one entry of `mcp/servers.json` against the normalized schema
 * (SPEC §3). The transport determines which fields are meaningful, and the
 * field the transport cannot work without is required — a stdio server with
 * no `command` would render into every target as an unlaunchable stub.
 */
function parseSourceServer(name: string, raw: unknown, filePath: string): McpServer {
  const entry = asRecord(raw, `MCP server "${name}" must be an object`, filePath);

  const transport = entry["transport"];
  if (!isTransport(transport)) {
    throw new AmError(
      `MCP server "${name}" has an invalid "transport" (${String(transport)}); expected "stdio", "http" or "sse"`,
      { path: filePath },
    );
  }

  const server: McpServer = { transport };

  if (transport === "stdio") {
    const command = entry["command"];
    if (typeof command !== "string" || command.trim() === "") {
      throw new AmError(`MCP server "${name}" is stdio and needs a "command"`, { path: filePath });
    }
    server.command = command;
    const args = entry["args"];
    if (args !== undefined) {
      if (!Array.isArray(args)) {
        throw new AmError(`MCP server "${name}" has a non-array "args"`, { path: filePath });
      }
      server.args = args.map((a, i) => scalarToString(a, name, `args[${i}]`, filePath));
    }
    const env = entry["env"];
    if (env !== undefined) server.env = parseStringMap(name, "env", env, filePath);
  } else {
    const url = entry["url"];
    if (typeof url !== "string" || url.trim() === "") {
      throw new AmError(`MCP server "${name}" is ${transport} and needs a "url"`, {
        path: filePath,
      });
    }
    server.url = url;
    const headers = entry["headers"];
    if (headers !== undefined) {
      server.headers = parseStringMap(name, "headers", headers, filePath);
    }
  }

  const targets = entry["targets"];
  if (targets !== undefined) server.targets = parseTargets(name, targets, filePath);

  return server;
}

function parseTargets(name: string, value: unknown, filePath: string): TargetId[] {
  if (!Array.isArray(value)) {
    throw new AmError(`MCP server "${name}" has a non-array "targets"`, { path: filePath });
  }
  const out: TargetId[] = [];
  for (const item of value) {
    const id = String(item).trim();
    if (!isTargetId(id)) {
      throw new AmError(`MCP server "${name}" lists an unknown target "${id}"`, {
        path: filePath,
      });
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Why a normalized server would not survive a round trip through
 * `mcp/servers.json`, or `null` when it is valid.
 *
 * The source of truth is read back with {@link readSourceServers}, which throws
 * on a schema violation — so writing an entry this function rejects bricks the
 * whole tool: every later command, `doctor` included, exits 2 while parsing the
 * file, and no CLI command can edit it back into shape. `import` therefore
 * checks each candidate here *before* the write and leaves the bad one out
 * (SPEC §6.3: broken input never becomes stored state).
 *
 * Validation is by construction rather than by a second rule set: the entry is
 * rendered exactly as it would be written and handed to the very parser that
 * will read it back.
 */
export function validateSourceServer(
  name: string,
  server: McpServer,
  filePath: string = sourceMcpPath(),
): string | null {
  try {
    parseSourceServer(name, renderSourceServer(server), filePath);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Read `~/.agents-manager/mcp/servers.json`. A missing file yields `{}`. */
export function readSourceServers(filePath: string = sourceMcpPath()): Record<string, McpServer> {
  const document = readJsonFile(filePath);
  if (document === null) return {};
  const root = asRecord(document, `${filePath} must be a JSON object`, filePath);
  const rawServers = root["servers"];
  if (rawServers === undefined || rawServers === null) return {};
  const servers = asRecord(rawServers, `"servers" in ${filePath} must be an object`, filePath);
  const out: Record<string, McpServer> = {};
  for (const name of Object.keys(servers).sort()) {
    out[name] = parseSourceServer(name, servers[name], filePath);
  }
  return out;
}

/**
 * Canonical text for **one** server, ignoring the source-only `targets`
 * selector (SPEC §3). Deeply serialized — `env` / `headers` contents included —
 * so equality of two servers can be decided by string comparison.
 */
export function canonicalServerText(server: McpServer): string {
  const rest: McpServer = { ...server };
  delete rest.targets;
  return serializeJson(renderSourceServer(rest));
}

/** Canonical text of `mcp/servers.json` for a normalized server map. */
export function serializeSourceServers(servers: Readonly<Record<string, McpServer>>): string {
  const rendered: Record<string, unknown> = {};
  for (const name of Object.keys(servers).sort()) {
    const server = servers[name];
    if (server === undefined) continue;
    rendered[name] = renderSourceServer(server);
  }
  const document: McpSourceFile = { servers: rendered as Record<string, McpServer> };
  return serializeJson(document);
}

/**
 * Write `mcp/servers.json` atomically. Only `import` may call this.
 *
 * Every entry is validated against the schema the reader enforces first. This
 * is the last gate before an unreadable source of truth — a file this function
 * would emit and {@link readSourceServers} would then reject leaves the user
 * with a tool that exits 2 on every command and cannot repair itself.
 */
export function writeSourceServers(
  servers: Readonly<Record<string, McpServer>>,
  filePath: string = sourceMcpPath(),
): void {
  for (const name of Object.keys(servers).sort()) {
    const server = servers[name];
    if (server === undefined) continue;
    const reason = validateSourceServer(name, server, filePath);
    if (reason !== null) {
      throw new AmError(`Refusing to write ${filePath}: ${reason}`, { path: filePath });
    }
  }
  writeFileAtomic(filePath, serializeSourceServers(servers));
}

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

const SOURCE_AGENT_EXT = ".md";

/**
 * Read `~/.agents-manager/agents/*.md`.
 *
 * Strict (not lenient) parsing: the source of truth must always satisfy both
 * dialects' required fields at once (SPEC §3), so a missing `name` or
 * `description` here is a real error rather than a `doctor` note.
 */
export function readSourceAgents(dir: string = sourceAgentsDir()): AgentDef[] {
  const agents: AgentDef[] = [];
  for (const fileName of listFiles(dir, SOURCE_AGENT_EXT)) {
    const filePath = path.join(dir, fileName);
    const text = readTextFile(filePath);
    if (text === null) continue;
    agents.push(
      parseAgentFile(text, {
        fallbackName: fileName.slice(0, -SOURCE_AGENT_EXT.length),
        sourcePath: filePath,
      }),
    );
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Write one `agents/<name>.md` atomically. Only `import` may call this.
 *
 * The name is validated first: `sourceAgentPath` is a bare `path.join`, so a
 * frontmatter `name: ../../evil` picked up from a target file would otherwise
 * write outside `~/.agents-manager/agents/` (SPEC §3's lowercase-hyphen rule is
 * a schema constraint, not just a doctor hint).
 */
export function writeSourceAgent(agent: AgentDef): string {
  assertValidAgentName(agent.name);
  const filePath = sourceAgentPath(agent.name);
  writeFileAtomic(filePath, renderSourceAgentFile(agent));
  return filePath;
}

/* ------------------------------------------------------------------ */
/* Commands (SPEC §10.2)                                               */
/* ------------------------------------------------------------------ */

const SOURCE_COMMAND_EXT = ".md";

/**
 * Read `~/.agents-manager/commands/*.md`.
 *
 * Strict, like {@link readSourceAgents}: SPEC §10.2 makes `name` and
 * `description` required of the normalized schema, and a command with no
 * description renders into opencode as an unlabelled entry in its picker. A
 * missing directory is legal and yields `[]`.
 */
export function readSourceCommands(dir: string = sourceCommandsDir()): CommandDef[] {
  const commands: CommandDef[] = [];
  for (const fileName of listFiles(dir, SOURCE_COMMAND_EXT)) {
    const filePath = path.join(dir, fileName);
    const text = readTextFile(filePath);
    if (text === null) continue;
    commands.push(
      parseCommandFile(text, {
        fallbackName: fileName.slice(0, -SOURCE_COMMAND_EXT.length),
        sourcePath: filePath,
      }),
    );
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Write one `commands/<name>.md` atomically. Only `import` may call this.
 *
 * The name is validated first for the same reason {@link writeSourceAgent}
 * validates one: `sourceCommandPath` is a bare `path.join`, so a frontmatter
 * `name: ../../evil` read out of a target would write outside
 * `~/.agents-manager/commands/`.
 */
export function writeSourceCommand(command: CommandDef): string {
  assertValidCommandName(command.name);
  const filePath = sourceCommandPath(command.name);
  writeFileAtomic(filePath, renderSourceCommandFile(command));
  return filePath;
}

/** ISO8601 mtime of `commands/<name>.md`, or `undefined` when it is missing. */
export function commandModifiedAt(name: string): string | undefined {
  return modifiedAt(sourceCommandPath(name));
}

/* ------------------------------------------------------------------ */
/* Skills                                                              */
/* ------------------------------------------------------------------ */

/**
 * Skills in the source of truth: every immediate subdirectory of
 * `~/.agents/skills/`. Names that violate the SPEC §3 constraints are still
 * returned — reporting them is `doctor`'s job, and silently hiding them here
 * would make `plan` claim a skill is absent when it is merely malformed.
 */
export function readSourceSkills(dir: string = sourceSkillsDir()): SkillRef[] {
  return listDirNames(dir)
    .map((name) => ({ name, sourcePath: sourceSkillDir(name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** True when `~/.agents/skills/<name>/SKILL.md` exists. */
export function skillHasManifest(name: string): boolean {
  return inspectPath(skillManifestPath(sourceSkillDir(name))).isFile;
}

/** Where a skill came from, when `.skill-lock.json` says (SPEC §9.3). */
export interface SkillOrigin {
  source: string;
  sourceUrl?: string;
}

/**
 * The descriptive facts about a source skill that the management console shows
 * in its table and detail pane (SPEC §9.3).
 *
 * Every field except `name` is optional **and omitted when unknown**, never
 * defaulted. `version` in particular is outside the agentskills.io schema, so
 * most skills legitimately have none; PRODUCT is explicit that the interface
 * draws 「—」 there rather than inventing a number. Same for `origin`: it exists
 * only for skills some installer recorded a lock file for.
 */
export interface SkillMeta {
  name: string;
  hasSkillMd: boolean;
  description?: string;
  version?: string;
  /** ISO8601 mtime of `SKILL.md` alone — not of the tree (SPEC §9.3/§9.5). */
  modified?: string;
  origin?: SkillOrigin;
}

/* ------------------------------------------------------------------ */
/* .skill-lock.json                                                     */
/* ------------------------------------------------------------------ */

/** Why {@link readSkillLock} could not use the file it found. */
export interface SkillLockError {
  /** `unparseable` = not JSON at all; `invalid` = JSON of the wrong shape. */
  kind: "unparseable" | "invalid";
  message: string;
}

/**
 * `~/.agents/.skill-lock.json`, as read.
 *
 * The document is written by foreign tooling, so every field here describes
 * *what was found*, never what should have been there. Read once per command:
 * a single file records every skill, and re-parsing it per row is the kind of
 * repeated work SPEC §9.5's read budget exists to keep out.
 */
export interface SkillLock {
  /** Absolute path of the file, whether or not it exists. */
  path: string;
  /** False when no installer has ever written one — not a fault. */
  present: boolean;
  /** Set when the file exists but could not be understood. */
  error?: SkillLockError;
  /** The `skills` map, entry by entry. Empty when absent or unreadable. */
  entries: Record<string, Record<string, unknown>>;
  /** Names whose entry was present but not an object, in file order. */
  malformed: string[];
}

/**
 * Read the one shared lock file.
 *
 * Never throws: both callers (the inventory's `origin` column and `doctor`)
 * want the failure as data — the inventory to omit `origin`, `doctor` to
 * report it as a finding rather than to abort the report it was asked for.
 */
export function readSkillLock(lockPath: string = skillLockPath()): SkillLock {
  const lock: SkillLock = { path: lockPath, present: false, entries: {}, malformed: [] };
  if (!inspectPath(lockPath).isFile) return lock;
  lock.present = true;

  let document: unknown;
  try {
    document = readJsonFile(lockPath);
  } catch (err) {
    lock.error = { kind: "unparseable", message: (err as Error).message };
    return lock;
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    lock.error = { kind: "invalid", message: `${SKILL_LOCK_FILE} is not a JSON object` };
    return lock;
  }

  const rawSkills = (document as Record<string, unknown>)["skills"];
  if (rawSkills === undefined || rawSkills === null) {
    lock.error = { kind: "invalid", message: `${SKILL_LOCK_FILE} has no "skills" map` };
    return lock;
  }
  if (typeof rawSkills !== "object" || Array.isArray(rawSkills)) {
    lock.error = { kind: "invalid", message: `"skills" in ${SKILL_LOCK_FILE} is not an object` };
    return lock;
  }

  for (const [name, entry] of Object.entries(rawSkills as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      lock.malformed.push(name);
      continue;
    }
    lock.entries[name] = entry as Record<string, unknown>;
  }
  return lock;
}

/**
 * The origin recorded for one skill, or `undefined` when the lock says nothing
 * about it. Absent is absent (SPEC §9.3): a skill installed by hand has no
 * entry, and inventing one would put a provenance in the console that no file
 * on disk supports.
 */
export function skillOriginFrom(lock: SkillLock, name: string): SkillOrigin | undefined {
  const entry = lock.entries[name];
  if (entry === undefined) return undefined;
  const source = entry["source"];
  if (typeof source !== "string" || source.trim() === "") return undefined;
  const url = entry["sourceUrl"];
  return {
    source: source.trim(),
    ...(typeof url === "string" && url.trim() !== "" ? { sourceUrl: url.trim() } : {}),
  };
}

/**
 * Read one skill's metadata.
 *
 * Deliberately forgiving, unlike {@link readSourceAgents}: this feeds a *display
 * column*, and a skill with a malformed `SKILL.md` must still appear in the list
 * (with its fields absent) so the owner can see it and fix it. `doctor` is the
 * command that judges the same files, and it keeps its errors.
 */
export function readSkillMeta(name: string, lock: SkillLock = readSkillLock()): SkillMeta {
  const dir = sourceSkillDir(name);
  const manifestFile = skillManifestPath(dir);
  const meta: SkillMeta = { name, hasSkillMd: inspectPath(manifestFile).isFile };
  if (!meta.hasSkillMd) return meta;

  const modified = modifiedAt(manifestFile);
  if (modified !== undefined) meta.modified = modified;

  const text = readTextFile(manifestFile);
  if (text !== null) {
    let data: Record<string, unknown> = {};
    try {
      data = parseFrontmatter(text, manifestFile).data;
    } catch {
      // A broken frontmatter block is doctor's finding to report, not a reason
      // to drop the row.
      data = {};
    }
    const description = data["description"];
    if (typeof description === "string" && description.trim() !== "") {
      meta.description = description.trim();
    }
    const version = data["version"];
    if (typeof version === "string" && version.trim() !== "") meta.version = version.trim();
    else if (typeof version === "number") meta.version = String(version);
  }

  const origin = skillOriginFrom(lock, name);
  if (origin !== undefined) meta.origin = origin;
  return meta;
}

/** Metadata for every source skill, in name order. */
export function readSourceSkillMeta(dir: string = sourceSkillsDir()): SkillMeta[] {
  // One parse of the shared lock file for the whole listing, not one per row.
  const lock = readSkillLock();
  return readSourceSkills(dir).map((skill) => readSkillMeta(skill.name, lock));
}

/** ISO8601 mtime of `agents/<name>.md`, or `undefined` when it is missing. */
export function agentModifiedAt(name: string): string | undefined {
  return modifiedAt(sourceAgentPath(name));
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown, message: string, filePath: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AmError(message, { path: filePath });
  }
  return value as Record<string, unknown>;
}

/** Coerce a scalar, refuse anything else (SPEC §6.3 — no silent data loss). */
function scalarToString(value: unknown, name: string, where: string, filePath: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new AmError(`MCP server "${name}" has a non-scalar "${where}"`, { path: filePath });
}

function parseStringMap(
  name: string,
  key: string,
  value: unknown,
  filePath: string,
): Record<string, string> {
  const record = asRecord(value, `MCP server "${name}" has a non-object "${key}"`, filePath);
  const out: Record<string, string> = {};
  for (const k of Object.keys(record).sort()) {
    out[k] = scalarToString(record[k], name, `${key}.${k}`, filePath);
  }
  return out;
}

function sortedStringMap(map: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(map).sort()) {
    const value = map[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
