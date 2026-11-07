/**
 * Copilot CLI adapter (SPEC §4).
 *
 * | asset  | location                                                        |
 * |--------|-----------------------------------------------------------------|
 * | skills | `~/.copilot/skills/<name>` ← junction                            |
 * | MCP    | `~/.copilot/mcp-config.json`, top-level key `mcpServers`         |
 * | agents | `~/.copilot/agents/<name>.agent.md` (shared with VS Code Copilot) |
 *
 * MCP dialect (SPEC §4): normalized `stdio` becomes `type: "local"`; `http`
 * and `sse` keep their names. Entries carry `tools: ["*"]`.
 *
 * Agent dialect (SPEC §4): `.agent.md`, `description` is required, and `tools`
 * is a YAML **array**. `targets` is stripped by `renderAgentFile`.
 *
 * SPEC §6.2: `~/.copilot/config.json` is a self-managed, non-strict JSON file
 * (it carries `//` comments) and is **never** read or written by this adapter.
 * Nothing in this module references it other than the doc comment.
 *
 * SPEC §7: this adapter never writes. `read*` reads, `render*` / `planSkills`
 * return plans that `commands/apply.ts` executes.
 */

import * as path from "node:path";

import {
  AmError,
  isValidAssetName,
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
import { diffSkills, type SkillDiffEntry } from "../core/diff.js";
import { parseAgentFile, renderAgentFile } from "../core/frontmatter.js";
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
import { readManifest } from "../core/manifest.js";
import {
  copilotAgentPath,
  copilotAgentsDir,
  copilotMcpConfigPath,
  copilotSkillPath,
  copilotSkillsDir,
  sourceSkillDir,
} from "../core/paths.js";
import {
  UNSUPPORTED,
  type Adapter,
  type AdapterCapabilities,
  type AdapterPaths,
  type McpRenderOptions,
  type SkillAction,
  type Unsupported,
} from "./types.js";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const COPILOT_CLI_TARGET: TargetId = "copilot-cli";

/** SPEC §4: agent files use the `.agent.md` extension. */
export const COPILOT_AGENT_EXTENSION = ".agent.md";

/** Every rendered server exposes all of its tools (SPEC §4). */
export const COPILOT_TOOLS_ALL: readonly string[] = ["*"];

/** Top-level key holding the servers in `mcp-config.json` (SPEC §4). */
const MCP_SERVERS_KEY = "mcpServers";

export const COPILOT_CLI_CAPABILITIES: AdapterCapabilities = {
  agentExtension: COPILOT_AGENT_EXTENSION,
  agentDialect: "copilot",
  supportedTransports: ["stdio", "http", "sse"],
};

/* ------------------------------------------------------------------ */
/* MCP dialect conversion (SPEC §4)                                    */
/* ------------------------------------------------------------------ */

/** Copilot CLI's `type` vocabulary. */
export type CopilotServerType = "local" | "http" | "sse";

/** One entry of `mcpServers` in `~/.copilot/mcp-config.json`. */
export interface CopilotServerConfig {
  type: CopilotServerType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  tools?: string[];
}

/** Shape of `~/.copilot/mcp-config.json` (other top-level keys are preserved). */
export interface CopilotMcpDocument {
  [key: string]: unknown;
  mcpServers?: Record<string, CopilotServerConfig>;
}

const TRANSPORT_TO_TYPE: Record<Transport, CopilotServerType> = {
  stdio: "local",
  http: "http",
  sse: "sse",
};

const TYPE_TO_TRANSPORT: Record<string, Transport> = {
  local: "stdio",
  // Copilot CLI accepts "stdio" as a synonym in hand-written configs; accept it
  // on read so an imported config does not have to be perfectly canonical.
  stdio: "stdio",
  http: "http",
  sse: "sse",
};

/**
 * Normalized → copilot-cli dialect.
 *
 * Key order and map ordering are fixed so the rendered document is a pure
 * function of the source. Without that determinism SPEC §8's
 * `import → apply → plan == 0 diff` fixed point is unreachable.
 */
export function toCopilotServer(server: McpServer): CopilotServerConfig {
  const out: CopilotServerConfig = { type: TRANSPORT_TO_TYPE[server.transport] };
  if (server.transport === "stdio") {
    if (server.command !== undefined) out.command = server.command;
    if (server.args !== undefined) out.args = [...server.args];
    if (server.env !== undefined) out.env = sortedStringMap(server.env);
  } else {
    if (server.url !== undefined) out.url = server.url;
    if (server.headers !== undefined) out.headers = sortedStringMap(server.headers);
  }
  out.tools = [...COPILOT_TOOLS_ALL];
  return out;
}

/**
 * copilot-cli dialect → normalized.
 *
 * `tools` is a target-side concern and is intentionally dropped: it is not part
 * of the normalized schema (SPEC §3), and re-rendering restores it.
 */
export function fromCopilotServer(
  name: string,
  raw: unknown,
  sourcePath: string,
): McpServer {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AmError(`MCP server "${name}" must be an object: ${sourcePath}`, {
      path: sourcePath,
    });
  }
  const entry = raw as Record<string, unknown>;

  const rawType = entry["type"];
  let transport: Transport;
  if (typeof rawType === "string") {
    const mapped = TYPE_TO_TRANSPORT[rawType];
    if (mapped === undefined) {
      throw new AmError(
        `Unknown MCP server type "${rawType}" for "${name}": ${sourcePath}`,
        { path: sourcePath },
      );
    }
    transport = mapped;
  } else if (rawType === undefined) {
    // Copilot CLI infers the transport from the payload when `type` is absent.
    transport = typeof entry["url"] === "string" ? "http" : "stdio";
  } else {
    throw new AmError(`MCP server "${name}" has a non-string "type": ${sourcePath}`, {
      path: sourcePath,
    });
  }

  const server: McpServer = { transport };
  if (transport === "stdio") {
    const command = entry["command"];
    if (typeof command === "string") server.command = command;
    const args = entry["args"];
    if (Array.isArray(args)) {
      server.args = args.map((a, i) => scalarToString(a, name, `args[${i}]`, sourcePath));
    }
    const env = readStringMap(entry["env"], name, "env", sourcePath);
    if (env !== undefined) server.env = env;
  } else {
    const url = entry["url"];
    if (typeof url === "string") server.url = url;
    const headers = readStringMap(entry["headers"], name, "headers", sourcePath);
    if (headers !== undefined) server.headers = headers;
  }
  return server;
}

/**
 * Build the full `mcp-config.json` text for `servers`.
 *
 * Top-level keys other than `mcpServers` found in `existing` are preserved
 * structurally (the same discipline SPEC §6.1 mandates for `~/.claude.json`),
 * so a user's unrelated settings survive an `apply`.
 */
export function renderCopilotMcpDocument(
  servers: Readonly<Record<string, McpServer>>,
  existing?: CopilotMcpDocument | null,
  preserve: Readonly<Record<string, unknown>> = {},
): string {
  const document: Record<string, unknown> = {};
  const rendered: Record<string, unknown> = {};
  for (const name of new Set([...Object.keys(servers), ...Object.keys(preserve)].sort())) {
    const server = servers[name];
    if (server !== undefined) {
      rendered[name] = toCopilotServer(server);
      continue;
    }
    // Verbatim: an unmanaged entry keeps its `tools` allowlist and any field
    // this tool does not model. Re-rendering it would silently widen `tools`
    // to `["*"]` — a permission change on an asset the user never asked us to
    // manage (SPEC §5).
    const raw = preserve[name];
    if (raw !== undefined) rendered[name] = raw;
  }
  // `mcpServers` first, then every preserved key in its original order.
  document[MCP_SERVERS_KEY] = rendered;
  if (existing !== undefined && existing !== null) {
    for (const [key, value] of Object.entries(existing)) {
      if (key === MCP_SERVERS_KEY) continue;
      document[key] = value;
    }
  }
  const content = serializeJson(document);
  assertOtherKeysPreserved(existing ?? {}, content);
  return content;
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

export interface CopilotCliAdapterOptions {
  /**
   * Skill materialization mode. Defaults to the manifest's
   * `skills.linkMode` (SPEC §2), read lazily so tests can swap `AM_HOME`.
   */
  linkMode?: LinkMode;
}

export class CopilotCliAdapter implements Adapter {
  readonly id: TargetId = COPILOT_CLI_TARGET;
  readonly capabilities: AdapterCapabilities = COPILOT_CLI_CAPABILITIES;

  private readonly linkModeOverride: LinkMode | undefined;

  constructor(options: CopilotCliAdapterOptions = {}) {
    this.linkModeOverride = options.linkMode;
  }

  paths(): AdapterPaths {
    return {
      mcp: copilotMcpConfigPath(),
      agentsDir: copilotAgentsDir(),
      skillsDir: copilotSkillsDir(),
      // SPEC §10.2: `command` is an opencode-only asset kind.
      commandsDir: UNSUPPORTED,
    };
  }

  /* ---------------- real environment → normalized ---------------- */

  /** Missing file ⇒ `{}`; unparseable file ⇒ throw (SPEC §6.3). */
  readMcp(): Record<string, McpServer> | Unsupported {
    const file = copilotMcpConfigPath();
    const document = readJsonFile<CopilotMcpDocument>(file);
    if (document === null) return {};
    if (typeof document !== "object" || Array.isArray(document)) {
      throw new AmError(`MCP config must be a JSON object: ${file}`, { path: file });
    }
    const rawServers = document[MCP_SERVERS_KEY];
    if (rawServers === undefined || rawServers === null) return {};
    if (typeof rawServers !== "object" || Array.isArray(rawServers)) {
      throw new AmError(`"${MCP_SERVERS_KEY}" must be an object: ${file}`, { path: file });
    }
    const entries = rawServers as Record<string, unknown>;
    const out: Record<string, McpServer> = {};
    for (const name of Object.keys(entries).sort()) {
      out[name] = fromCopilotServer(name, entries[name], file);
    }
    return out;
  }

  /**
   * Read `~/.copilot/agents/*.agent.md`.
   *
   * Parsed leniently: files already living in the target may predate this tool
   * and lack a `description`. Malformed YAML still throws (SPEC §6.3); the
   * missing-field case is a `doctor` diagnostic, not a read failure.
   */
  readAgents(): AgentDef[] | Unsupported {
    const dir = copilotAgentsDir();
    const agents: AgentDef[] = [];
    for (const fileName of listFiles(dir, COPILOT_AGENT_EXTENSION)) {
      const filePath = path.join(dir, fileName);
      const text = readTextFile(filePath);
      if (text === null) continue;
      agents.push(
        parseAgentFile(text, {
          fallbackName: fileName.slice(0, -COPILOT_AGENT_EXTENSION.length),
          sourcePath: filePath,
          lenient: true,
        }),
      );
    }
    return agents.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** SPEC §10.2: only opencode carries user-added commands. */
  readCommands(): Unsupported {
    return UNSUPPORTED;
  }

  /** Inspect `~/.copilot/skills/`: junction / symlink / real directory / broken. */
  readSkillLinks(): SkillLink[] | Unsupported {
    const dir = copilotSkillsDir();
    return listDirNames(dir).map((name) => inspectSkillLink(name, path.join(dir, name)));
  }

  /* ---------------- normalized → real environment ---------------- */

  /** The `mcpServers` entries verbatim, for `plan`'s preservation path. */
  readRawMcp(): Record<string, unknown> {
    const file = copilotMcpConfigPath();
    const document = readJsonFile<CopilotMcpDocument>(file);
    if (document === null) return {};
    if (typeof document !== "object" || Array.isArray(document)) {
      throw new AmError(`MCP config must be a JSON object: ${file}`, { path: file });
    }
    const rawServers = document[MCP_SERVERS_KEY];
    if (rawServers === undefined || rawServers === null) return {};
    if (typeof rawServers !== "object" || Array.isArray(rawServers)) {
      throw new AmError(`"${MCP_SERVERS_KEY}" must be an object: ${file}`, { path: file });
    }
    const entries = rawServers as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const name of Object.keys(entries).sort()) {
      const entry = entries[name];
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new AmError(`MCP server "${name}" must be an object: ${file}`, { path: file });
      }
      out[name] = entry;
    }
    return out;
  }

  renderMcp(servers: Record<string, McpServer>, options: McpRenderOptions = {}): FileEdit[] {
    const file = copilotMcpConfigPath();
    // Read-modify-write of the whole document: other top-level keys survive.
    const existing = readJsonFile<CopilotMcpDocument>(file);
    const preserve = options.preserve ?? {};
    // Nothing to deliver and no `mcpServers` key on disk: leave the file as it
    // is rather than editing it purely to add an empty map.
    if (
      Object.keys(servers).length === 0 &&
      Object.keys(preserve).length === 0 &&
      existing !== null &&
      !(MCP_SERVERS_KEY in existing)
    ) {
      return [];
    }
    return [
      { path: file, content: renderCopilotMcpDocument(servers, existing, preserve) },
    ];
  }

  renderAgents(agents: readonly AgentDef[]): FileEdit[] {
    return [...agents]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((agent) => {
        assertRenderableAgent(agent);
        return {
          path: copilotAgentPath(agent.name),
          content: renderAgentFile(agent, "copilot"),
        };
      });
  }

  /** SPEC §10.2: nothing to render — this target has no command directory. */
  renderCommands(_commands: readonly CommandDef[]): Unsupported {
    void _commands;
    return UNSUPPORTED;
  }

  planSkills(skills: readonly SkillRef[]): SkillAction[] {
    const linkMode = this.linkMode();
    const entries: SkillDiffEntry[] = [];
    const wanted = new Set<string>();

    for (const skill of skills) {
      wanted.add(skill.name.toLowerCase());
      const targetPath = copilotSkillPath(skill.name);
      const link = inspectSkillLink(skill.name, targetPath);
      const entry: SkillDiffEntry = {
        name: skill.name,
        sourcePath: skill.sourcePath,
        targetPath,
        link,
      };
      if (link.kind === "junction" || link.kind === "symlink") {
        entry.linkResolvesToSource = linkPointsTo(targetPath, skill.sourcePath);
      } else if (link.kind === "directory") {
        // SPEC §9.5: "could not compare" is its own outcome (see claude.ts).
        const comparison = compareDirectories(targetPath, skill.sourcePath);
        if (comparison.status === "incomparable") {
          entry.contentIncomparable = `${comparison.reason} under ${comparison.path}`;
        } else {
          entry.contentIdentical = comparison.status === "identical";
        }
      }
      entries.push(entry);
    }

    const dir = copilotSkillsDir();
    // `!wanted.has(...)` alone would report a skill that `manifest.skills.exclude`
    // kept out of the delivery list — but SPEC §5 defines `delete` as "ソースに
    // 無く実環境にだけある" and an excluded skill is still in the source. The
    // claude adapter applies the same guard; the two must agree.
    const orphans: SkillLink[] = listDirNames(dir)
      .filter((name) => !wanted.has(name.toLowerCase()) && !skillExistsInSource(name))
      .map((name) => inspectSkillLink(name, path.join(dir, name)));

    return diffSkills({ target: this.id, linkMode, entries, orphans });
  }

  private linkMode(): LinkMode {
    return this.linkModeOverride ?? readManifest().skills.linkMode;
  }
}

/** Convenience factory mirroring the other adapters. */
export function createCopilotCliAdapter(options: CopilotCliAdapterOptions = {}): Adapter {
  return new CopilotCliAdapter(options);
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

/** True when a skill still exists in `~/.agents/skills/` (SPEC §5). */
function skillExistsInSource(name: string): boolean {
  return inspectPath(sourceSkillDir(name)).exists;
}

/**
 * The copilot-cli counterpart of SPEC §6.1's mandatory assertion: after
 * swapping `mcpServers`, every other top-level key of `mcp-config.json` must
 * still be present with an identical value. Preservation used to hold only "by
 * construction"; checking the re-parsed output makes it hold by evidence.
 */
function assertOtherKeysPreserved(
  original: Readonly<Record<string, unknown>>,
  renderedText: string,
): void {
  const file = copilotMcpConfigPath();
  let reparsed: unknown;
  try {
    reparsed = JSON.parse(renderedText);
  } catch (err) {
    throw new AmError(`Rendered ${file} is not valid JSON`, { path: file, cause: err });
  }
  if (typeof reparsed !== "object" || reparsed === null || Array.isArray(reparsed)) {
    throw new AmError(`Rendered ${file} is not a JSON object`, { path: file });
  }
  const next = reparsed as Record<string, unknown>;
  const before = Object.keys(original).filter((k) => k !== MCP_SERVERS_KEY).sort();
  const after = Object.keys(next).filter((k) => k !== MCP_SERVERS_KEY).sort();
  if (before.length !== after.length || before.some((k, i) => k !== after[i])) {
    throw new AmError(
      `Refusing to write ${file}: top-level keys other than "${MCP_SERVERS_KEY}" changed ` +
        `(before: [${before.join(", ")}], after: [${after.join(", ")}])`,
      { path: file },
    );
  }
  for (const key of before) {
    if (JSON.stringify(original[key]) !== JSON.stringify(next[key])) {
      throw new AmError(
        `Refusing to write ${file}: top-level key "${key}" would be modified`,
        { path: file },
      );
    }
  }
}

/** SPEC §4: the copilot dialect requires `description`; names become filenames. */
function assertRenderableAgent(agent: AgentDef): void {
  if (!isValidAssetName(agent.name)) {
    throw new AmError(
      `Invalid agent name "${agent.name}": expected lowercase alphanumerics and hyphens (≤64 chars)`,
    );
  }
  if (agent.description.trim() === "") {
    throw new AmError(`Agent "${agent.name}" is missing required "description" (copilot dialect)`);
  }
}

/** Classify what currently occupies a skill slot. */
function inspectSkillLink(name: string, targetPath: string): SkillLink {
  const info = inspectPath(targetPath);
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
  const link: SkillLink = { name, path: targetPath, kind };
  if (info.unreadable !== undefined) link.unreadable = info.unreadable;
  if (info.linkTarget !== undefined) link.linkTarget = info.linkTarget;
  return link;
}

/**
 * Windows reports junctions and directory symlinks alike through `lstat`, and
 * Node strips the `\\?\` prefix from a junction's destination, so the two are
 * not perfectly distinguishable. A junction's destination is always absolute,
 * which is the best available signal (and the form this tool creates); a
 * relative destination is certainly a symlink. `diffSkills` treats both kinds
 * identically, so this classification only affects `inventory` display.
 */
function isJunctionTarget(linkTarget: string | undefined): boolean {
  return (
    process.platform === "win32" && linkTarget !== undefined && path.isAbsolute(linkTarget)
  );
}

function sortedStringMap(map: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(map).sort()) {
    const value = map[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Coerce a scalar to its string form, and refuse everything else.
 *
 * SPEC §6.3 forbids silent data loss as firmly for a well-formed-but-unexpected
 * value as for broken JSON: `String({...})` is `"[object Object]"`, which would
 * be imported into the source of truth as if the user had written it there and
 * then rendered back into every target. The claude adapter's `scalarToString`
 * and the vscode adapter's `parseStringMap` make the same call.
 */
function scalarToString(value: unknown, name: string, where: string, sourcePath: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new AmError(`MCP server "${name}" has a non-scalar "${where}": ${sourcePath}`, {
    path: sourcePath,
  });
}

function readStringMap(
  value: unknown,
  name: string,
  key: string,
  sourcePath: string,
): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AmError(`MCP server "${name}" has a non-object "${key}": ${sourcePath}`, {
      path: sourcePath,
    });
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of Object.keys(record).sort()) {
    out[k] = scalarToString(record[k], name, `${key}.${k}`, sourcePath);
  }
  return out;
}
