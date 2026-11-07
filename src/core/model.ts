/**
 * Normalized domain model (SPEC §3).
 *
 * These types describe the *source of truth* vocabulary. Target-specific
 * dialects are produced by adapters at render time (SPEC §4).
 */

/* ------------------------------------------------------------------ */
/* Targets                                                             */
/* ------------------------------------------------------------------ */

export type TargetId = "claude" | "copilot-cli" | "vscode" | "vs2026" | "opencode";

export const TARGET_IDS: readonly TargetId[] = [
  "claude",
  "copilot-cli",
  "vscode",
  "vs2026",
  /** SPEC §10: the fifth target, added in v3. */
  "opencode",
] as const;

export function isTargetId(value: unknown): value is TargetId {
  return typeof value === "string" && (TARGET_IDS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* MCP (SPEC §3)                                                       */
/* ------------------------------------------------------------------ */

/** Normalized transport vocabulary. Converted to dialects at render time. */
export type Transport = "stdio" | "http" | "sse";

export const TRANSPORTS: readonly Transport[] = ["stdio", "http", "sse"] as const;

export function isTransport(value: unknown): value is Transport {
  return typeof value === "string" && (TRANSPORTS as readonly string[]).includes(value);
}

export interface McpServer {
  transport: Transport;
  /** stdio only */
  command?: string;
  /** stdio only */
  args?: string[];
  /** stdio only */
  env?: Record<string, string>;
  /** http / sse only */
  url?: string;
  /** http / sse only */
  headers?: Record<string, string>;
  /** Omitted ⇒ all enabled targets (SPEC §3). */
  targets?: TargetId[];
}

/** Shape of `~/.agents-manager/mcp/servers.json`. */
export interface McpSourceFile {
  servers: Record<string, McpServer>;
}

/* ------------------------------------------------------------------ */
/* Custom agents (SPEC §3)                                             */
/* ------------------------------------------------------------------ */

export interface AgentDef {
  /** Required. lowercase-hyphen. */
  name: string;
  /** Required. */
  description: string;
  /** Optional. The source of truth always stores a YAML array. */
  tools?: string[];
  /** Optional. */
  model?: string;
  /** Optional. Omitted ⇒ all enabled targets. Stripped before render. */
  targets?: TargetId[];
  /** Any frontmatter key that is not part of the normalized schema. */
  extra?: Record<string, unknown>;
  /** System prompt body (everything after the frontmatter block). */
  body: string;
}

/** Agent frontmatter dialects (SPEC §4). */
export type AgentDialect = "claude" | "copilot";

/** SPEC §4: copilot bodies must be ≤ 30,000 characters (doctor warning). */
export const COPILOT_BODY_MAX = 30_000;

/* ------------------------------------------------------------------ */
/* Commands (SPEC §10.2)                                               */
/* ------------------------------------------------------------------ */

/**
 * A user-added command, normalized (SPEC §10.2).
 *
 * The source lives at `~/.agents-manager/commands/<name>.md`. Only **opencode**
 * can carry one today; every other target answers `"unsupported"`.
 *
 * The schema is deliberately four fields and a body. `name` and `targets` are
 * source-only selectors and are stripped before render; `description` and
 * `agent` are the two keys opencode itself reads (SPEC §10.2), so anything else
 * in the frontmatter could not be delivered anywhere and is not modelled.
 */
export interface CommandDef {
  /** Required. lowercase-hyphen, and equal to the file name. */
  name: string;
  /** Required. */
  description: string;
  /** Optional. The opencode agent that runs this command. */
  agent?: string;
  /** Optional. Omitted ⇒ every enabled target that supports commands. */
  targets?: TargetId[];
  /**
   * The command body, **verbatim**. `$ARGUMENTS` is harness-specific notation
   * (SPEC §10.2): this tool neither interprets nor substitutes it.
   */
  body: string;
}

/* ------------------------------------------------------------------ */
/* Skills (SPEC §3)                                                    */
/* ------------------------------------------------------------------ */

/** A skill in the source of truth (`~/.agents/skills/<name>/`). */
export interface SkillRef {
  name: string;
  /** Absolute path of the source skill directory. */
  sourcePath: string;
}

/** What actually exists at a target's skill discovery path. */
export type SkillLinkKind =
  /** A directory junction (the desired state). */
  | "junction"
  /** A symbolic link. */
  | "symlink"
  /** A real directory (a physical copy). */
  | "directory"
  /** A non-directory file occupying the slot. */
  | "file"
  /** Nothing there. */
  | "missing"
  /** A link whose destination no longer resolves. */
  | "broken"
  /**
   * Something is in the slot, or may be, and the process is not allowed to look
   * (SPEC §9.7).
   *
   * Distinct from `missing` on purpose. `lstat` failing with EACCES used to be
   * flattened into 「無い」, so an ACL-protected skill was drawn as undelivered
   * and `plan` proposed creating a junction over it — a write derived from a
   * reading nobody was able to take.
   */
  | "unreadable";

export interface SkillLink {
  name: string;
  /** Absolute path inside the target's discovery directory. */
  path: string;
  kind: SkillLinkKind;
  /** Resolved destination for `junction` / `symlink` / `broken`. */
  linkTarget?: string;
  /** The engine's reason, for `unreadable` — shown verbatim, never invented. */
  unreadable?: string;
}

/** SPEC §2: `"junction"` (default) | `"copy"`. */
export type LinkMode = "junction" | "copy";

/* ------------------------------------------------------------------ */
/* Manifest (SPEC §2)                                                  */
/* ------------------------------------------------------------------ */

export interface TargetConfig {
  enabled: boolean;
}

export interface SkillsConfig {
  linkMode: LinkMode;
  exclude: string[];
}

/**
 * SPEC §9.1: the only definition of "disabled" is membership of an `exclude`
 * list. The asset file itself is never touched — a disabled asset stops being
 * *delivered*, it does not stop existing.
 */
export interface ExcludeConfig {
  exclude: string[];
}

/** Versions this build can read. Writes always use {@link MANIFEST_VERSION}. */
export type ManifestVersion = 1 | 2 | 3;

export interface Manifest {
  version: ManifestVersion;
  targets: Record<TargetId, TargetConfig>;
  skills: SkillsConfig;
  /** SPEC §9.1. A v1 file is accepted and read as an empty list. */
  mcp: ExcludeConfig;
  /** SPEC §9.1. A v1 file is accepted and read as an empty list. */
  agents: ExcludeConfig;
  /** SPEC §10.5. A v1/v2 file is accepted and read as an empty list. */
  commands: ExcludeConfig;
}

/** The asset kinds an `exclude` list can name (SPEC §9.2, §10.5). */
export type AssetKindId = "skill" | "mcp" | "agent" | "command";

export const ASSET_KIND_IDS: readonly AssetKindId[] = [
  "skill",
  "mcp",
  "agent",
  "command",
] as const;

export function isAssetKindId(value: unknown): value is AssetKindId {
  return typeof value === "string" && (ASSET_KIND_IDS as readonly string[]).includes(value);
}

/** The `exclude` list a given asset kind is governed by (SPEC §9.1). */
export function excludeListOf(manifest: Manifest, kind: AssetKindId): string[] {
  switch (kind) {
    case "skill":
      return manifest.skills.exclude;
    case "mcp":
      return manifest.mcp.exclude;
    case "agent":
      return manifest.agents.exclude;
    case "command":
      return manifest.commands.exclude;
  }
}

/* ------------------------------------------------------------------ */
/* Planning primitives                                                 */
/* ------------------------------------------------------------------ */

/**
 * A planned whole-file write. Adapters only plan; `commands/apply.ts` is the
 * single place that performs writes (SPEC §7).
 */
export interface FileEdit {
  path: string;
  content: string;
}

/* ------------------------------------------------------------------ */
/* Selectors (pure)                                                    */
/* ------------------------------------------------------------------ */

/**
 * Resolve an asset's effective target list: an explicit `targets` array
 * intersected with the enabled targets, or all enabled targets when omitted.
 */
export function resolveTargets(
  declared: readonly TargetId[] | undefined,
  enabled: readonly TargetId[],
): TargetId[] {
  if (declared === undefined) return [...enabled];
  return enabled.filter((t) => declared.includes(t));
}

/** Servers that should be delivered to `target`. */
export function serversForTarget(
  servers: Readonly<Record<string, McpServer>>,
  target: TargetId,
  enabled: readonly TargetId[],
): Record<string, McpServer> {
  const out: Record<string, McpServer> = {};
  for (const name of Object.keys(servers).sort()) {
    const server = servers[name];
    if (server === undefined) continue;
    if (resolveTargets(server.targets, enabled).includes(target)) {
      out[name] = server;
    }
  }
  return out;
}

/** Agents that should be delivered to `target`. */
export function agentsForTarget(
  agents: readonly AgentDef[],
  target: TargetId,
  enabled: readonly TargetId[],
): AgentDef[] {
  return agents
    .filter((a) => resolveTargets(a.targets, enabled).includes(target))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Commands that should be delivered to `target` (SPEC §10.2). */
export function commandsForTarget(
  commands: readonly CommandDef[],
  target: TargetId,
  enabled: readonly TargetId[],
): CommandDef[] {
  return commands
    .filter((c) => resolveTargets(c.targets, enabled).includes(target))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Skills that should be delivered, honouring `manifest.skills.exclude`. */
export function skillsForDelivery(
  skills: readonly SkillRef[],
  exclude: readonly string[],
): SkillRef[] {
  const excluded = new Set(exclude);
  return skills.filter((s) => !excluded.has(s.name)).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * MCP servers that should be delivered, honouring `manifest.mcp.exclude`
 * (SPEC §9.1).
 *
 * An excluded server is dropped from the *desired* state, which is exactly what
 * makes it stop being written to every target. It is not deleted from anything:
 * a server already present in a target becomes an unmanaged extra, preserved
 * until the owner asks for `--prune`.
 */
export function serversForDelivery(
  servers: Readonly<Record<string, McpServer>>,
  exclude: readonly string[],
): Record<string, McpServer> {
  const excluded = new Set(exclude);
  const out: Record<string, McpServer> = {};
  for (const name of Object.keys(servers).sort()) {
    if (excluded.has(name)) continue;
    const server = servers[name];
    if (server !== undefined) out[name] = server;
  }
  return out;
}

/** Agents that should be delivered, honouring `manifest.agents.exclude`. */
export function agentsForDelivery(
  agents: readonly AgentDef[],
  exclude: readonly string[],
): AgentDef[] {
  const excluded = new Set(exclude);
  return agents.filter((a) => !excluded.has(a.name)).sort((a, b) => a.name.localeCompare(b.name));
}

/** Commands that should be delivered, honouring `manifest.commands.exclude`. */
export function commandsForDelivery(
  commands: readonly CommandDef[],
  exclude: readonly string[],
): CommandDef[] {
  const excluded = new Set(exclude);
  return commands.filter((c) => !excluded.has(c.name)).sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * SPEC §3: skill/agent names are lowercase alphanumerics and hyphens,
 * at most 64 characters.
 */
export const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const NAME_MAX_LENGTH = 64;

export function isValidAssetName(name: string): boolean {
  return name.length > 0 && name.length <= NAME_MAX_LENGTH && NAME_PATTERN.test(name);
}

/**
 * Guard every path that turns an agent name into a **file name**.
 *
 * `<dir>/<name>.md` is a bare `path.join`, so a name like `../../evil` (or, on
 * Windows, one containing `\`, `:` or a reserved device name) escapes the
 * directory the tool is allowed to manage. SPEC §3 makes lowercase-hyphen a
 * required constraint of the normalized schema, so enforcing it at every
 * render/write boundary costs nothing and closes the traversal.
 */
export function assertValidAgentName(name: string): void {
  if (isValidAssetName(name)) return;
  throw new AmError(
    `Invalid agent name "${name}": expected lowercase alphanumerics and hyphens (≤${NAME_MAX_LENGTH} chars)`,
  );
}

/**
 * The same guard for command names, which also become file names
 * (`command/<name>.md` — SPEC §10.2).
 */
export function assertValidCommandName(name: string): void {
  if (isValidAssetName(name)) return;
  throw new AmError(
    `Invalid command name "${name}": expected lowercase alphanumerics and hyphens (≤${NAME_MAX_LENGTH} chars)`,
  );
}

/** Thrown for malformed source/target data. The CLI maps this to exit code 2. */
export class AmError extends Error {
  readonly path: string | undefined;

  constructor(message: string, options?: { path?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AmError";
    this.path = options?.path;
  }
}
