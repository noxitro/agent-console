/**
 * VS Code Copilot adapter (SPEC §4).
 *
 * This target is unusual: it owns exactly **one** asset kind.
 *
 * | asset  | vscode                                                            |
 * |--------|-------------------------------------------------------------------|
 * | MCP    | `%APPDATA%/Code/User/mcp.json`, top-level key `servers`            |
 * | agents | shares `~/.copilot/agents/` with copilot-cli — **no work needed**  |
 * | skills | discovers `~/.agents/skills` directly — **no work needed**         |
 *
 * For the two shared kinds the `read*` methods still report what VS Code
 * actually discovers (so `inventory` can answer "who sees what", SPEC §5),
 * while the `render*` / `plan*` methods return an empty plan: those files are
 * materialized by the target that owns the directory, and planning them twice
 * would produce duplicate — and, for skills, conflicting — actions.
 *
 * Per SPEC §7 this module never writes, and every path root comes from
 * `core/paths.ts`.
 */

import * as path from "node:path";

import { unsupportedAction, type Action } from "../core/diff.js";
import { parseAgentFile } from "../core/frontmatter.js";
import { listFiles, readJsonFile, readTextFile, serializeJson } from "../core/fsops.js";
import {
  AmError,
  isTransport,
  type AgentDef,
  type CommandDef,
  type FileEdit,
  type McpServer,
  type SkillLink,
  type SkillRef,
  type TargetId,
  type Transport,
} from "../core/model.js";
import { copilotAgentsDir, sourceSkillsDir, vscodeMcpPath } from "../core/paths.js";
import { readSharedSkillLinks } from "./skill-discovery.js";
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

const TARGET: TargetId = "vscode";

/** SPEC §4: the top-level key is `servers`, **not** `mcpServers`. */
export const VSCODE_SERVERS_KEY = "servers";

/** Agent files in the shared copilot directory (SPEC §4). */
export const VSCODE_AGENT_EXTENSION = ".agent.md";

/**
 * SPEC §4 dialect table. `sse` has no VS Code spelling: such servers are
 * skipped and reported as a plan warning (see {@link mcpWarnings}).
 */
const TRANSPORT_TO_TYPE: Readonly<Record<Transport, string | null>> = {
  stdio: "stdio",
  http: "http",
  sse: null,
};

/** Transports VS Code can express. */
export const VSCODE_SUPPORTED_TRANSPORTS: readonly Transport[] = ["stdio", "http"];

export const vscodeCapabilities: AdapterCapabilities = {
  agentExtension: VSCODE_AGENT_EXTENSION,
  agentDialect: "copilot",
  supportedTransports: VSCODE_SUPPORTED_TRANSPORTS,
  sharesDiscoveryWith: "copilot-cli",
};

/* ------------------------------------------------------------------ */
/* MCP: normalized → vscode dialect                                    */
/* ------------------------------------------------------------------ */

/** A single entry under `servers` in `mcp.json`. */
export interface VscodeServerEntry {
  type: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * Convert one normalized server into the VS Code dialect, or `null` when the
 * transport has no VS Code spelling (`sse` — SPEC §4).
 *
 * `targets` is source-only metadata and is always stripped, exactly as it is
 * for agents (SPEC §3). Keys are emitted in a fixed order and only the fields
 * that belong to the transport are written, so the rendered file is byte-stable
 * across runs — the precondition for SPEC §8's
 * "import → apply → plan が差分ゼロ" fixed point.
 */
export function toVscodeServer(server: McpServer): VscodeServerEntry | null {
  const type = TRANSPORT_TO_TYPE[server.transport];
  if (type === null) return null;

  const entry: VscodeServerEntry = { type };
  if (server.transport === "stdio") {
    if (server.command !== undefined) entry.command = server.command;
    if (server.args !== undefined) entry.args = [...server.args];
    if (server.env !== undefined) entry.env = sortedStringMap(server.env);
  } else {
    if (server.url !== undefined) entry.url = server.url;
    if (server.headers !== undefined) entry.headers = sortedStringMap(server.headers);
  }
  return entry;
}

/** Convert a whole normalized map, dropping `sse` servers. Keys are sorted. */
export function toVscodeServers(
  servers: Readonly<Record<string, McpServer>>,
): Record<string, VscodeServerEntry> {
  const out: Record<string, VscodeServerEntry> = {};
  for (const name of Object.keys(servers).sort()) {
    const server = servers[name];
    if (server === undefined) continue;
    const entry = toVscodeServer(server);
    if (entry !== null) out[name] = entry;
  }
  return out;
}

/**
 * Plan warnings for servers VS Code cannot carry (SPEC §4: "非対応 → plan で
 * 警告しスキップ").
 *
 * The `Adapter` interface has no channel for warnings, so these come back as
 * `unsupported` actions — which `plan` prints, which `apply` never executes
 * (`NON_EXECUTABLE_KINDS`), and which do not by themselves make `plan` exit 1.
 */
export function mcpWarnings(servers: Readonly<Record<string, McpServer>>): Action[] {
  const actions: Action[] = [];
  for (const name of Object.keys(servers).sort()) {
    const server = servers[name];
    if (server === undefined) continue;
    if (TRANSPORT_TO_TYPE[server.transport] === null) {
      actions.push(
        unsupportedAction(
          TARGET,
          "mcp",
          `server "${name}": VS Code does not support the "${server.transport}" transport; skipped`,
          vscodeMcpPath(),
        ),
      );
    }
  }
  return actions;
}

/* ------------------------------------------------------------------ */
/* MCP: vscode dialect → normalized                                    */
/* ------------------------------------------------------------------ */

/**
 * Parse the `servers` map of an `mcp.json` document into normalized servers.
 *
 * Exported so the round-trip test can run render → parse without touching the
 * file system. `sse` entries are accepted here even though we never write
 * them: `import` must not silently discard a server the user already has.
 *
 * Malformed structure throws (SPEC §6.3 — broken input is never "empty data").
 */
export function parseVscodeMcp(
  document: unknown,
  sourcePath: string = vscodeMcpPath(),
): Record<string, McpServer> {
  if (document === null || document === undefined) return {};
  const doc = asRecord(document, `${sourcePath}: expected a JSON object`, sourcePath);

  const rawServers = doc[VSCODE_SERVERS_KEY];
  if (rawServers === undefined || rawServers === null) return {};
  const servers = asRecord(
    rawServers,
    `${sourcePath}: "${VSCODE_SERVERS_KEY}" must be an object`,
    sourcePath,
  );

  const out: Record<string, McpServer> = {};
  for (const name of Object.keys(servers).sort()) {
    out[name] = parseVscodeServer(name, servers[name], sourcePath);
  }
  return out;
}

function parseVscodeServer(name: string, raw: unknown, sourcePath: string): McpServer {
  const entry = asRecord(raw, `${sourcePath}: server "${name}" must be an object`, sourcePath);
  const transport = parseTransport(name, entry, sourcePath);

  const server: McpServer = { transport };
  if (transport === "stdio") {
    const command = entry["command"];
    if (command !== undefined) {
      if (typeof command !== "string") {
        throw new AmError(`${sourcePath}: server "${name}" has a non-string "command"`, {
          path: sourcePath,
        });
      }
      server.command = command;
    }
    const args = entry["args"];
    if (args !== undefined) {
      if (!Array.isArray(args)) {
        throw new AmError(`${sourcePath}: server "${name}" has a non-array "args"`, {
          path: sourcePath,
        });
      }
      // Scalars are coerced, everything else throws — the same rule `env` and
      // `headers` follow two lines below. `String({...})` would import
      // `"[object Object]"` as a launch argument (SPEC §6.3).
      server.args = args.map((a, i) => scalarToString(a, name, `args[${i}]`, sourcePath));
    }
    const env = entry["env"];
    if (env !== undefined) server.env = parseStringMap(name, "env", env, sourcePath);
  } else {
    const url = entry["url"];
    if (url !== undefined) {
      if (typeof url !== "string") {
        throw new AmError(`${sourcePath}: server "${name}" has a non-string "url"`, {
          path: sourcePath,
        });
      }
      server.url = url;
    }
    const headers = entry["headers"];
    if (headers !== undefined) {
      server.headers = parseStringMap(name, "headers", headers, sourcePath);
    }
  }
  return server;
}

/**
 * Recover the normalized transport. VS Code spells `stdio` and `http` exactly
 * as the normalized vocabulary does; `sse` is tolerated on read. When `type` is
 * absent it is inferred from the shape (`command` ⇒ stdio, `url` ⇒ http), which
 * is what VS Code itself does for older hand-written configs.
 */
function parseTransport(
  name: string,
  entry: Readonly<Record<string, unknown>>,
  sourcePath: string,
): Transport {
  const rawType = entry["type"];
  if (rawType === undefined || rawType === null) {
    if (typeof entry["command"] === "string") return "stdio";
    if (typeof entry["url"] === "string") return "http";
    throw new AmError(
      `${sourcePath}: server "${name}" has no "type" and neither "command" nor "url"`,
      { path: sourcePath },
    );
  }
  if (!isTransport(rawType)) {
    throw new AmError(`${sourcePath}: server "${name}" has unsupported type "${String(rawType)}"`, {
      path: sourcePath,
    });
  }
  return rawType;
}

/** Coerce a scalar, refuse anything else (SPEC §6.3 — no silent data loss). */
function scalarToString(value: unknown, name: string, where: string, sourcePath: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new AmError(`${sourcePath}: server "${name}" has a non-scalar "${where}"`, {
    path: sourcePath,
  });
}

function parseStringMap(
  name: string,
  key: string,
  value: unknown,
  sourcePath: string,
): Record<string, string> {
  const record = asRecord(
    value,
    `${sourcePath}: server "${name}" has a non-object "${key}"`,
    sourcePath,
  );
  const out: Record<string, string> = {};
  for (const k of Object.keys(record).sort()) {
    out[k] = scalarToString(record[k], name, `${key}.${k}`, sourcePath);
  }
  return out;
}

function sortedStringMap(value: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** The `servers` map of an already-parsed `mcp.json` document, or `{}`. */
function existingServers(document: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const raw = document[VSCODE_SERVERS_KEY];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

function asRecord(value: unknown, message: string, sourcePath: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AmError(message, { path: sourcePath });
  }
  return value as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

export class VscodeAdapter implements Adapter {
  readonly id: TargetId = TARGET;
  readonly capabilities: AdapterCapabilities = vscodeCapabilities;

  paths(): AdapterPaths {
    return {
      mcp: vscodeMcpPath(),
      // Shared with copilot-cli (SPEC §4) — reported so `inventory` can show
      // that VS Code reads another target's directory.
      agentsDir: copilotAgentsDir(),
      // VS Code discovers the skill source directly (SPEC §4).
      skillsDir: sourceSkillsDir(),
      // SPEC §10.2: `command` is an opencode-only asset kind.
      commandsDir: UNSUPPORTED,
    };
  }

  /* -------------------- real environment → normalized -------------------- */

  /** Missing file ⇒ `{}`. Present but broken ⇒ throw (SPEC §6.3). */
  readMcp(): Record<string, McpServer> {
    const file = vscodeMcpPath();
    const document = readJsonFile(file);
    if (document === null) return {};
    return parseVscodeMcp(document, file);
  }

  /**
   * Agents VS Code discovers, read from the directory copilot-cli owns.
   * Parsed leniently: these files were written by another tool and may lack
   * keys the normalized schema requires.
   */
  readAgents(): AgentDef[] {
    const dir = copilotAgentsDir();
    const agents: AgentDef[] = [];
    for (const fileName of listFiles(dir, VSCODE_AGENT_EXTENSION)) {
      const filePath = path.join(dir, fileName);
      const text = readTextFile(filePath);
      if (text === null) continue;
      agents.push(
        parseAgentFile(text, {
          fallbackName: fileName.slice(0, -VSCODE_AGENT_EXTENSION.length),
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

  /**
   * What currently sits in the directory VS Code discovers skills from.
   *
   * Shared with every other discovery-path target (SPEC §5: two views of one
   * directory must never disagree) — see `skill-discovery.ts`.
   */
  readSkillLinks(): SkillLink[] {
    return readSharedSkillLinks();
  }

  /* -------------------- normalized → real environment -------------------- */

  /**
   * Rewrite `mcp.json`, replacing only the `servers` key.
   *
   * Every other top-level key — notably `inputs`, which holds the user's
   * variable prompts (SPEC §4) — is preserved structurally, and the result is
   * asserted to differ from the original in `servers` alone.
   */
  /** The `servers` entries verbatim, for `plan`'s preservation path. */
  readRawMcp(): Record<string, unknown> {
    const file = vscodeMcpPath();
    const existing = readJsonFile(file);
    if (existing === null) return {};
    const document = asRecord(existing, `${file}: expected a JSON object`, file);
    const raw = document[VSCODE_SERVERS_KEY];
    if (raw === undefined || raw === null) return {};
    const servers = asRecord(raw, `${file}: "${VSCODE_SERVERS_KEY}" must be an object`, file);
    const out: Record<string, unknown> = {};
    for (const name of Object.keys(servers).sort()) {
      out[name] = asRecord(servers[name], `${file}: server "${name}" must be an object`, file);
    }
    return out;
  }

  renderMcp(servers: Record<string, McpServer>, options: McpRenderOptions = {}): FileEdit[] {
    const file = vscodeMcpPath();
    const existing = readJsonFile(file);
    const document =
      existing === null ? {} : asRecord(existing, `${file}: expected a JSON object`, file);
    const onDisk = existingServers(document);

    // SPEC §4 says an `sse` server is "skipped" for VS Code. Skipped means *not
    // written*, never *removed*: dropping an entry that is already in mcp.json
    // would delete a working server outside `--prune` (SPEC §5). So a name we
    // cannot express keeps whatever mcp.json already holds for it.
    const rendered: Record<string, unknown> = {};
    const preserve = options.preserve ?? {};
    for (const name of new Set([...Object.keys(servers), ...Object.keys(preserve)].sort())) {
      const server = servers[name];
      if (server !== undefined) {
        const entry = toVscodeServer(server);
        if (entry !== null) rendered[name] = entry;
        else if (onDisk[name] !== undefined) rendered[name] = onDisk[name];
        continue;
      }
      // Unmanaged extra: keep the raw on-disk object, `sse` and unknown keys
      // included.
      const raw = preserve[name];
      if (raw !== undefined) rendered[name] = raw;
    }

    // Nothing to deliver and no `servers` key on disk: do not touch the file
    // just to add an empty map.
    if (
      Object.keys(rendered).length === 0 &&
      existing !== null &&
      !(VSCODE_SERVERS_KEY in document)
    ) {
      return [];
    }

    const next: Record<string, unknown> = { ...document };
    next[VSCODE_SERVERS_KEY] = rendered;

    assertOnlyServersChanged(document, next, file);
    return [{ path: file, content: serializeJson(next) }];
  }

  /** No-op: agent files live in copilot-cli's directory (SPEC §4). */
  renderAgents(_agents: readonly AgentDef[]): FileEdit[] {
    return [];
  }

  /** SPEC §10.2: nothing to render — this target has no command directory. */
  renderCommands(_commands: readonly CommandDef[]): Unsupported {
    void _commands;
    return UNSUPPORTED;
  }

  /** No-op: VS Code discovers `~/.agents/skills` directly (SPEC §4). */
  planSkills(_skills: readonly SkillRef[]): SkillAction[] {
    return [];
  }

  /** Plan warnings for transports VS Code cannot express (SPEC §4). */
  mcpWarnings(servers: Readonly<Record<string, McpServer>>): Action[] {
    return mcpWarnings(servers);
  }
}

/** Singleton instance, mirroring how commands consume adapters. */
export const vscodeAdapter: VscodeAdapter = new VscodeAdapter();

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

/**
 * SPEC §6.1's guarantee, applied to `mcp.json` as well: the set of top-level
 * keys must be unchanged apart from `servers`, and every other key must still
 * hold an identical value. A violation is a bug in this module rather than bad
 * user input, so it fails loudly instead of writing a mangled config.
 */
function assertOnlyServersChanged(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  sourcePath: string,
): void {
  const beforeKeys = Object.keys(before).filter((k) => k !== VSCODE_SERVERS_KEY);
  const afterKeys = Object.keys(after).filter((k) => k !== VSCODE_SERVERS_KEY);
  const same =
    beforeKeys.length === afterKeys.length &&
    beforeKeys.every((k, i) => afterKeys[i] === k) &&
    beforeKeys.every((k) => JSON.stringify(before[k]) === JSON.stringify(after[k]));
  if (!same) {
    throw new AmError(
      `${sourcePath}: refusing to write — keys other than "${VSCODE_SERVERS_KEY}" would change`,
      { path: sourcePath },
    );
  }
}

