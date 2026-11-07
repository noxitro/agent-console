/**
 * The `Adapter` interface every target implements (SPEC §7).
 *
 * Two hard rules:
 *  1. **Adapters never write.** `read*` reads, `render*`/`plan*` produce
 *     plans. All writing is centralized in `commands/apply.ts` (SPEC §7),
 *     which is what makes SPEC §6.5 ("only `apply` writes") enforceable.
 *  2. **Adapters never invent paths.** Every path comes from `core/paths.ts`
 *     (SPEC §7).
 *
 * Read semantics (SPEC §7): a missing file yields empty data; a file that
 * exists but cannot be parsed **throws** (SPEC §6.3).
 */

import type {
  AgentDef,
  CommandDef,
  FileEdit,
  McpServer,
  SkillLink,
  SkillRef,
  TargetId,
} from "../core/model.js";
import type { Action, AssetKind, SkillDiffEntry } from "../core/diff.js";

/** Sentinel for an asset kind a target cannot carry (e.g. MCP on vs2026). */
export const UNSUPPORTED = "unsupported" as const;
export type Unsupported = typeof UNSUPPORTED;

export function isUnsupported<T>(value: T | Unsupported): value is Unsupported {
  return value === UNSUPPORTED;
}

/** Skill actions a target plans; a re-export alias of the diff engine's `Action`. */
export type SkillAction = Action;

/**
 * One of a target's command files, as the **display** path sees it (SPEC §10.2).
 *
 * Deliberately not a `CommandDef`. A `CommandDef` is a definition this tool can
 * act on — it always has a name and a body — whereas this is a *row in a
 * listing*, and a file whose frontmatter does not parse still has to occupy one.
 * So every field but the name is optional, and `unreadable` carries the parse
 * error instead of the fields nobody could read. Absent is absent: an
 * unreadable file gets no description, not an empty one (PRODUCT: 捏造しない).
 */
export interface CommandListing {
  /** Frontmatter `name` when it parsed, otherwise the file-name stem. */
  name: string;
  /** Omitted only when the file could not be parsed at all. */
  description?: string;
  agent?: string;
  /**
   * The parse error, when this file exists but could not be understood.
   *
   * Its presence is the flag; the text is the engine's own message, path
   * included, so the console repeats a diagnosis rather than inventing one.
   */
  unreadable?: string;
}

/** Where a target keeps each asset kind. Used by `inventory` (SPEC §5). */
export interface AdapterPaths {
  /** Config file holding MCP servers, or `"unsupported"`. */
  mcp: string | Unsupported;
  /** Directory holding agent files, or `"unsupported"`. */
  agentsDir: string | Unsupported;
  /** Skill discovery directory, or `"unsupported"`. */
  skillsDir: string | Unsupported;
  /** Directory holding command files (SPEC §10.2), or `"unsupported"`. */
  commandsDir: string | Unsupported;
}

/** Extra facts `inventory` / `doctor` display without needing target internals. */
export interface AdapterCapabilities {
  /** File extension for agent files: `".md"` or `".agent.md"` (SPEC §4). */
  agentExtension: string;
  /** Frontmatter dialect for agents (SPEC §4). */
  agentDialect: "claude" | "copilot";
  /** Transports this target can express; others are skipped with a warning. */
  supportedTransports: readonly ("stdio" | "http" | "sse")[];
  /**
   * True when the target discovers assets from another target's directory and
   * therefore needs no work of its own (vscode skills/agents — SPEC §4).
   */
  sharesDiscoveryWith?: TargetId;
}

/**
 * Extra inputs for {@link Adapter.renderMcp}.
 *
 * `preserve` carries **raw dialect entries** for servers the source of truth
 * does not know about. SPEC §5 forbids removing an environment-only asset
 * outside `--prune`, and "preserved" has to mean *structurally* preserved:
 * round-tripping such an entry through the normalized model would silently drop
 * fields the normalized schema has no room for (unknown per-server keys,
 * copilot's `tools` allowlist, …). So `plan` hands the untouched on-disk object
 * back and the adapter splices it in verbatim.
 *
 * Names in `preserve` that are also present in `servers` are ignored: the
 * source of truth wins for anything it manages.
 */
export interface McpRenderOptions {
  preserve?: Readonly<Record<string, unknown>>;
}

export interface Adapter {
  readonly id: TargetId;
  readonly capabilities: AdapterCapabilities;

  /** Resolved paths for this target (all from `core/paths.ts`). */
  paths(): AdapterPaths;

  /* ---------------- real environment → normalized ---------------- */

  /**
   * Read the target's MCP servers, converted back to the normalized schema.
   * Missing file ⇒ `{}`. Unparseable file ⇒ throw (SPEC §6.3).
   */
  readMcp(): Record<string, McpServer> | Unsupported;

  /**
   * The target's MCP entries **exactly as they sit on disk**, keyed by server
   * name and still in the target's own dialect.
   *
   * `readMcp` is lossy by design (it projects onto the normalized schema of
   * SPEC §3); this is the escape hatch that lets `plan` preserve an unmanaged
   * server byte-for-byte instead of re-rendering a degraded copy of it. Missing
   * file ⇒ `{}`; unparseable file ⇒ throw, exactly like `readMcp`.
   */
  readRawMcp(): Record<string, unknown> | Unsupported;

  /** Read the target's agent files as normalized `AgentDef`s. */
  readAgents(): AgentDef[] | Unsupported;

  /**
   * Read the target's command files as normalized `CommandDef`s (SPEC §10.2).
   *
   * Only opencode carries commands today; every other adapter answers
   * `"unsupported"`, which `inventory` and `plan` show as such rather than as
   * an empty (and therefore reassuring) list.
   */
  readCommands(): CommandDef[] | Unsupported;

  /**
   * The same files, read for the **display** path only (`inventory`).
   *
   * `readCommands` above is strict, as SPEC §6.3 requires of every path that
   * feeds a write: `plan`, `apply` and `import` must stop rather than act on a
   * file they could not understand. `inventory` writes nothing, and stopping it
   * is what actually happened — one hand-edited `command/*.md` with a broken
   * YAML block took the whole survey down (`am inventory` exit 2, and the
   * console, whose window *is* that payload, opened onto a fault plate with no
   * table behind it).
   *
   * So the display path keeps the row and drops the fields: exactly the bargain
   * `readSkillMeta` already strikes for a malformed `SKILL.md` (see
   * `core/source.ts`). The row says `unreadable`; `doctor` remains the command
   * that judges the same file, and its `command.unreadable` error is unchanged.
   *
   * Optional and discovered structurally, like {@link unsupportedReason}: an
   * adapter that answers `"unsupported"` for commands has nothing to add, and
   * {@link listCommandsForDisplay} falls back to the strict read for it.
   */
  readCommandsForDisplay?(): CommandListing[] | Unsupported;

  /** Inspect the target's skill discovery directory: junction / real dir / missing. */
  readSkillLinks(): SkillLink[] | Unsupported;

  /* ---------------- normalized → real environment ---------------- */

  /**
   * Render MCP servers into the target dialect (SPEC §4). Returns the whole
   * file content(s) to write — for `~/.claude.json` this means reading the
   * existing document and swapping only the `mcpServers` key (SPEC §6.1).
   * Never writes.
   *
   * `options.preserve` (see {@link McpRenderOptions}) is spliced in verbatim.
   */
  renderMcp(servers: Record<string, McpServer>, options?: McpRenderOptions): FileEdit[];

  /**
   * Render agents into the target dialect. Never writes.
   *
   * `"unsupported"` is a *different* answer from `[]`: opencode's agent
   * frontmatter has no safe conversion from the normalized schema (SPEC §10.4),
   * and saying so is what keeps `plan` from reporting "already in sync" about
   * files it never looked at.
   */
  renderAgents(agents: readonly AgentDef[]): FileEdit[] | Unsupported;

  /** Render commands into the target dialect (SPEC §10.2). Never writes. */
  renderCommands(commands: readonly CommandDef[]): FileEdit[] | Unsupported;

  /** Plan skill materialization for this target. Never writes. */
  planSkills(skills: readonly SkillRef[]): SkillAction[];

  /**
   * Why this target answers `"unsupported"` for `asset`.
   *
   * Optional, and discovered structurally by the commands (the way
   * `mcpWarnings` is), so an adapter only implements it when it has something
   * specific to say. SPEC §10.4 requires the *reason* to reach `inventory` and
   * `plan`, not merely the verdict: "cannot" without "why" reads as a defect in
   * this tool rather than a deliberate refusal.
   */
  unsupportedReason?(asset: AssetKind): string | undefined;

  /**
   * Facts about one MCP server that this target's dialect could **not** record,
   * and that `import` therefore had to assume (SPEC §10.3).
   *
   * opencode stores `http` and `sse` alike as `type: "remote"`, so an imported
   * remote server's transport is a default rather than an observation. Optional
   * and structurally discovered, like {@link unsupportedReason}: an adapter
   * whose dialect loses nothing simply does not implement it.
   */
  mcpImportNotes?(name: string, server: McpServer): AdapterImportNote[];

  /**
   * The same, for one command file: frontmatter keys outside the normalized
   * schema (SPEC §10.2) that were read but could not be carried into the source
   * of truth.
   */
  commandImportNotes?(name: string, command: CommandDef): AdapterImportNote[];

  /**
   * True when the value {@link readMcp} produced for `name` is a **guess** the
   * target's own format forced, rather than something it recorded.
   *
   * opencode stores `http` and `sse` alike as `type: "remote"` (SPEC §10.3), so
   * every remote server reads back as `http` whatever it was. `import` uses
   * this to keep such a value from out-voting — or falsely conflicting with —
   * a target that *did* record the fact, and from overwriting a source entry
   * that already says which of the two it is. Optional and discovered
   * structurally: an adapter whose reads are observations does not implement it.
   */
  mcpImportIsGuess?(name: string, server: McpServer): boolean;

  /**
   * MCP servers this target has switched off **in its own configuration**.
   *
   * Distinct from `manifest.mcp.exclude`, which is what *this tool* means by
   * disabled (SPEC §9.1): opencode carries a per-server `"enabled": false` that
   * the write path deliberately preserves, so a server can be delivered and
   * still never start. `inventory` carries the names through so the console can
   * say so instead of reporting 「適用済み(整合)」 about it. Optional: a target
   * with no such switch does not implement it, and the field stays absent from
   * the wire rather than being defaulted to `true`.
   */
  mcpDisabledNames?(): string[];
}

/**
 * One thing an adapter could not recover on the way into the normalized model.
 *
 * The adapter supplies both halves — a stable `code` for machine readers and
 * the prose a human needs — so no caller has to infer the code by matching on
 * the text (SPEC §10.3).
 */
export interface AdapterImportNote {
  code: string;
  detail: string;
}

/**
 * One target's commands for a *display* (SPEC §10.2), whichever way it can.
 *
 * Prefers {@link Adapter.readCommandsForDisplay}, whose whole job is to keep a
 * malformed file as a row instead of throwing the listing away. Adapters that
 * do not implement it are the four that answer `"unsupported"` for commands, so
 * the fallback below cannot be the source of the exit-2 this function exists to
 * prevent — and if a second command-carrying target ever appears without the
 * hook, it inherits the strict behaviour rather than a silently emptied list.
 */
export function listCommandsForDisplay(adapter: Adapter): CommandListing[] | Unsupported {
  if (adapter.readCommandsForDisplay !== undefined) return adapter.readCommandsForDisplay();
  const commands = adapter.readCommands();
  if (isUnsupported(commands)) return UNSUPPORTED;
  return commands.map((command) => ({
    name: command.name,
    description: command.description,
    ...(command.agent !== undefined ? { agent: command.agent } : {}),
  }));
}

/**
 * Per-entry state an adapter assembles before delegating to
 * `diffSkills` — re-exported so adapters share one shape.
 */
export type { SkillDiffEntry };
