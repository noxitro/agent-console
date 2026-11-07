/**
 * `--json` output for every command (the GUI's transport).
 *
 * One rule governs this module: **it computes nothing of its own**. Every
 * payload is assembled from the same functions the human-readable commands
 * call — `collectDiagnostics`, `computeActions`, the adapters — so the GUI and
 * the CLI cannot disagree about what the environment looks like
 * (PRODUCT: "CLI と GUI は同じ真実"). Where a command performs work
 * (`apply`, `import`), this module runs the real command with a report object
 * attached and a buffered `io`, rather than re-implementing the work.
 *
 * Wire format (one JSON object on stdout, nothing else):
 *  - success: the payload for the command
 *  - failure: `{ error: { message, path? } }`, with the human text on stderr
 *
 * The `unsupported` sentinel is emitted verbatim wherever a target genuinely
 * cannot carry an asset kind (vs2026 MCP, SPEC §4). PRODUCT forbids papering
 * over it with an empty list.
 */

import { isUnsupported, listCommandsForDisplay, type Adapter } from "../adapters/types.js";
import { planExitCode, type Action, type ActionKind, type AssetKind } from "../core/diff.js";
import { inspectPath, modifiedAt, readLinkTarget } from "../core/fsops.js";
import { enabledTargets, readManifest } from "../core/manifest.js";
import {
  AmError,
  TARGET_IDS,
  type LinkMode,
  type SkillLink,
  type SkillLinkKind,
  type TargetId,
} from "../core/model.js";
import { manifestPath, sourceMcpPath, sourceRoot } from "../core/paths.js";
import {
  emptyApplyReport,
  emptyImportReport,
  type ApplyReport,
  type ImportReport,
} from "../core/report.js";
import {
  agentModifiedAt,
  commandModifiedAt,
  readSourceAgents,
  readSourceCommands,
  readSourceServers,
  readSourceSkillMeta,
} from "../core/source.js";
import { runApply, type ApplyOptions } from "./apply.js";
import { collectDiagnostics, type DiagnosticLevel } from "./doctor.js";
import { runImport, type ImportOptions } from "./import.js";
import { computeActions } from "./plan.js";
import { consoleIo, createAdapter, loadSourceContext, type CommandIo } from "./context.js";

/**
 * The `io` a command gets in JSON mode: its human-readable narration is
 * dropped (stdout must carry exactly one JSON object) but everything it writes
 * to stderr still reaches the terminal — that channel carries the conflict
 * listings and the drift refusal, which are the messages a caller most needs
 * when a write command declines to proceed.
 */
export function stderrOnlyIo(io: CommandIo = consoleIo): CommandIo {
  return {
    out(): void {
      /* discarded: stdout belongs to the JSON payload */
    },
    err: (line: string) => {
      io.err(line);
    },
  };
}

/** The literal a target uses to say "this asset kind does not exist here". */
export const UNSUPPORTED_LITERAL = "unsupported" as const;
export type UnsupportedLiteral = typeof UNSUPPORTED_LITERAL;

/* ------------------------------------------------------------------ */
/* inventory                                                           */
/* ------------------------------------------------------------------ */

/**
 * SPEC §9.3. Every asset kind is a **list of assets**, not a count: the console
 * lists individual skills, servers and agents, and a count cannot be listed.
 *
 * `enabled` is the manifest's exclude list applied (SPEC §9.1) — the single
 * definition of on/off, computed here so the GUI never derives it (Product
 * Principle 2). Optional fields are omitted rather than defaulted; the
 * interface draws 「—」 for an absent `version`, and must never be handed a
 * fabricated one.
 */
export interface JsonSourceSkill {
  name: string;
  hasSkillMd: boolean;
  enabled: boolean;
  description?: string;
  version?: string;
  /** ISO8601 mtime of `SKILL.md` alone (SPEC §9.3). */
  modified?: string;
  origin?: { source: string; sourceUrl?: string };
}

export interface JsonSourceMcp {
  name: string;
  transport: string;
  enabled: boolean;
  /** Explicit target selector from `servers.json`; absent ⇒ all enabled. */
  targets?: TargetId[];
  /** Command (stdio) or URL (http/sse) — the console's second column. */
  endpoint?: string;
  modified?: string;
}

export interface JsonSourceAgent {
  name: string;
  description: string;
  enabled: boolean;
  model?: string;
  targets?: TargetId[];
  modified?: string;
}

/** SPEC §10.2. Same shape discipline as the other three: absent is absent. */
export interface JsonSourceCommand {
  name: string;
  description: string;
  enabled: boolean;
  /** The opencode agent that runs it; omitted when the command names none. */
  agent?: string;
  targets?: TargetId[];
  modified?: string;
}

export interface JsonSource {
  root: string;
  manifestPresent: boolean;
  linkMode: LinkMode;
  skills: JsonSourceSkill[];
  mcp: JsonSourceMcp[];
  agents: JsonSourceAgent[];
  commands: JsonSourceCommand[];
}

export interface JsonSkillEntry {
  name: string;
  kind: SkillLinkKind;
  /** Resolved link destination; absent for a physical directory. */
  dest?: string;
  /**
   * The engine's reason, for `kind: "unreadable"` (SPEC §9.7).
   *
   * Carried on the wire so the console can say *why* a slot is 未確認 rather
   * than printing a bare verdict — the same shape `commands` already uses for a
   * file whose frontmatter will not parse.
   */
  unreadable?: string;
}

export interface JsonMcpEntry {
  name: string;
  transport: string;
  /**
   * The **target's own** per-server switch, when the target has one (opencode's
   * `"enabled": false` — SPEC §10.3).
   *
   * Absent means the target has no such concept, which is a different statement
   * from `true`; `false` means the entry is delivered and the target still will
   * not start it. Nothing to do with `manifest.mcp.exclude`, which is this
   * tool's own definition of enabled/disabled (SPEC §9.1) and appears on the
   * *source* side of the payload.
   */
  enabled?: boolean;
}

export interface JsonAgentEntry {
  name: string;
}

export interface JsonCommandEntry {
  name: string;
  /**
   * Omitted only when the file could not be parsed — see `unreadable`. A blank
   * string here would be a description the console could draw as if it had read
   * one (PRODUCT: 捏造しない).
   */
  description?: string;
  agent?: string;
  /**
   * SPEC §10.2 — this file exists in the target and its frontmatter does not
   * parse. The row survives (the name is the file-name stem) so the console can
   * show the owner *which* file is broken; the text is the engine's own parse
   * error, path included.
   *
   * `inventory` still exits 0: the scan completed, and one unreadable file is a
   * fact about the machine rather than a failure of the survey. `doctor` is
   * where it counts as an error (`command.unreadable`, exit 1), and `plan` /
   * `apply` / `import` are unchanged — they read the same file strictly and
   * stop (SPEC §6.3).
   */
  unreadable?: string;
}

/**
 * Why a target answers `"unsupported"` for an asset kind (SPEC §10.4).
 *
 * The console needs the reason, not only the verdict: 「非対応」 with no
 * explanation reads as a hole in this tool rather than a deliberate refusal.
 */
export interface JsonUnsupportedReason {
  assetType: AssetKind;
  reason: string;
}

export interface JsonTarget {
  id: TargetId;
  /** Whether the manifest has this target switched on (SPEC §2). */
  enabled: boolean;
  skillsDir: string | UnsupportedLiteral;
  mcpPath: string | UnsupportedLiteral;
  agentsDir: string | UnsupportedLiteral;
  commandsDir: string | UnsupportedLiteral;
  skills: JsonSkillEntry[] | UnsupportedLiteral;
  mcp: JsonMcpEntry[] | UnsupportedLiteral;
  agents: JsonAgentEntry[] | UnsupportedLiteral;
  commands: JsonCommandEntry[] | UnsupportedLiteral;
  /** Set when the target reads another target's directories (SPEC §4). */
  sharesDiscoveryWith?: TargetId;
  /** Reasons for every `"unsupported"` above that the adapter explains. */
  unsupportedReasons?: JsonUnsupportedReason[];
}

export interface InventoryJson {
  source: JsonSource;
  targets: JsonTarget[];
}

/** `am inventory --json`. Read-only, so the exit code is always 0 (SPEC §5). */
export function inventoryJson(): { exitCode: 0; payload: InventoryJson } {
  return { exitCode: 0, payload: buildInventory() };
}

function buildInventory(): InventoryJson {
  const manifest = readManifest();
  const enabled = new Set<TargetId>(enabledTargets(manifest));
  // The *unfiltered* source: inventory lists what exists, and marks each row
  // enabled or not. Filtering here would make a disabled asset indistinguishable
  // from a deleted one, and the console could never offer to switch it back on.
  const skillExcluded = new Set(manifest.skills.exclude);
  const mcpExcluded = new Set(manifest.mcp.exclude);
  const agentExcluded = new Set(manifest.agents.exclude);
  const commandExcluded = new Set(manifest.commands.exclude);
  const servers = readSourceServers();
  const serversModified = modifiedAt(sourceMcpPath());

  return {
    source: {
      root: sourceRoot(),
      manifestPresent: inspectPath(manifestPath()).exists,
      linkMode: manifest.skills.linkMode,
      skills: readSourceSkillMeta().map((meta) => ({
        name: meta.name,
        hasSkillMd: meta.hasSkillMd,
        enabled: !skillExcluded.has(meta.name),
        ...(meta.description !== undefined ? { description: meta.description } : {}),
        ...(meta.version !== undefined ? { version: meta.version } : {}),
        ...(meta.modified !== undefined ? { modified: meta.modified } : {}),
        ...(meta.origin !== undefined ? { origin: meta.origin } : {}),
      })),
      mcp: Object.keys(servers)
        .sort()
        .map((name) => {
          const server = servers[name];
          const endpoint = server?.command ?? server?.url;
          return {
            name,
            transport: server?.transport ?? "stdio",
            enabled: !mcpExcluded.has(name),
            ...(server?.targets !== undefined ? { targets: [...server.targets] } : {}),
            ...(endpoint !== undefined ? { endpoint } : {}),
            // A server has no file of its own; the document that holds it is
            // the only mtime that exists, and it is the honest one to show.
            ...(serversModified !== undefined ? { modified: serversModified } : {}),
          };
        }),
      agents: readSourceAgents().map((agent) => ({
        name: agent.name,
        description: agent.description,
        enabled: !agentExcluded.has(agent.name),
        ...(agent.model !== undefined ? { model: agent.model } : {}),
        ...(agent.targets !== undefined ? { targets: [...agent.targets] } : {}),
        ...(agentModifiedAt(agent.name) !== undefined
          ? { modified: agentModifiedAt(agent.name) as string }
          : {}),
      })),
      commands: readSourceCommands().map((command) => ({
        name: command.name,
        description: command.description,
        enabled: !commandExcluded.has(command.name),
        ...(command.agent !== undefined ? { agent: command.agent } : {}),
        ...(command.targets !== undefined ? { targets: [...command.targets] } : {}),
        ...(commandModifiedAt(command.name) !== undefined
          ? { modified: commandModifiedAt(command.name) as string }
          : {}),
      })),
    },
    // Every target is listed, enabled or not: "who sees what" is a question
    // about the machine, not about the manifest (SPEC §5).
    targets: TARGET_IDS.map((id) =>
      targetJson(createAdapter(id, manifest.skills.linkMode), enabled.has(id)),
    ),
  };
}

function targetJson(adapter: Adapter, enabled: boolean): JsonTarget {
  const paths = adapter.paths();
  const links = adapter.readSkillLinks();
  const servers = adapter.readMcp();
  const agents = adapter.readAgents();
  // The display read (SPEC §10.2): one unparseable command file must not take
  // the console's entire survey — every target, skill and server in it — down
  // with it. It stays in the listing, flagged.
  const commands = listCommandsForDisplay(adapter);
  const shares = adapter.capabilities.sharesDiscoveryWith;
  // Absent hook ⇒ this target has no per-server switch, so the field stays off
  // the wire entirely rather than being defaulted to `true` (PRODUCT: 捏造しない).
  const disabledInTarget = adapter.mcpDisabledNames?.();

  const reasons: JsonUnsupportedReason[] = [];
  for (const [assetType, value] of [
    ["skill", links],
    ["mcp", servers],
    ["agent", agents],
    ["command", commands],
  ] as const) {
    if (!isUnsupported(value)) continue;
    const reason = adapter.unsupportedReason?.(assetType);
    if (reason !== undefined) reasons.push({ assetType, reason });
  }

  return {
    id: adapter.id,
    enabled,
    skillsDir: paths.skillsDir,
    mcpPath: paths.mcp,
    agentsDir: paths.agentsDir,
    commandsDir: paths.commandsDir,
    skills: isUnsupported(links) ? UNSUPPORTED_LITERAL : links.map(skillEntry),
    mcp: isUnsupported(servers)
      ? UNSUPPORTED_LITERAL
      : Object.keys(servers)
          .sort()
          .map((name) => ({
            name,
            transport: servers[name]?.transport ?? "stdio",
            ...(disabledInTarget !== undefined
              ? { enabled: !disabledInTarget.includes(name) }
              : {}),
          })),
    agents: isUnsupported(agents)
      ? UNSUPPORTED_LITERAL
      : agents.map((agent) => ({ name: agent.name })),
    commands: isUnsupported(commands)
      ? UNSUPPORTED_LITERAL
      : commands.map((command) => ({
          name: command.name,
          ...(command.description !== undefined ? { description: command.description } : {}),
          ...(command.agent !== undefined ? { agent: command.agent } : {}),
          ...(command.unreadable !== undefined ? { unreadable: command.unreadable } : {}),
        })),
    ...(shares !== undefined ? { sharesDiscoveryWith: shares } : {}),
    ...(reasons.length > 0 ? { unsupportedReasons: reasons } : {}),
  };
}

function skillEntry(link: SkillLink): JsonSkillEntry {
  const dest =
    link.kind === "junction" || link.kind === "symlink" || link.kind === "broken"
      ? readLinkTarget(link.path) ?? link.linkTarget
      : undefined;
  return {
    name: link.name,
    kind: link.kind,
    ...(dest !== undefined ? { dest } : {}),
    ...(link.unreadable !== undefined ? { unreadable: link.unreadable } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* doctor                                                              */
/* ------------------------------------------------------------------ */

export interface JsonFinding {
  level: DiagnosticLevel;
  code: string;
  target?: TargetId;
  asset?: string;
  detail: string;
  path?: string;
}

export interface DoctorJson {
  findings: JsonFinding[];
}

/** `am doctor --json`. Exit 1 when anything was found (SPEC §5). */
export function doctorJson(): { exitCode: 0 | 1; payload: DoctorJson } {
  const payload = buildDoctor();
  return { exitCode: payload.findings.length === 0 ? 0 : 1, payload };
}

function buildDoctor(): DoctorJson {
  return {
    findings: collectDiagnostics().map((d) => ({
      level: d.level,
      code: d.code,
      ...(d.target !== undefined ? { target: d.target } : {}),
      ...(d.asset !== undefined ? { asset: d.asset } : {}),
      detail: d.message,
      ...(d.path !== undefined ? { path: d.path } : {}),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* plan                                                                */
/* ------------------------------------------------------------------ */

/**
 * SPEC §9.6: the largest text a single action carries in either direction.
 *
 * The payload crosses a sidecar as one JSON document that the GUI parses in the
 * UI thread, so an unbounded `before`/`after` would let one large agent file
 * stall the window. Past the ceiling the fields are dropped and
 * `previewOmitted` says why — the confirmation dialog then shows the paths and
 * says the content is too large to preview, which is a true statement, rather
 * than showing a truncated diff that looks like the whole change.
 */
export const PREVIEW_MAX_BYTES = 256 * 1024;

export interface JsonAction {
  kind: ActionKind;
  target: TargetId;
  assetType: AssetKind;
  /** Asset name; empty for actions about a whole config file. */
  asset: string;
  path: string;
  detail: string;
  /**
   * SPEC §9.6 — content preview for file-backed writes.
   *
   * `before` is the current file text (absent for `create`), `after` the text
   * the write would produce (absent for `delete`). Both are the plan-time
   * snapshot; `apply` re-reads and re-renders immediately before writing, so
   * this is strictly a preview and never the bytes that land on disk.
   */
  before?: string;
  after?: string;
  /** Set when a preview exists in principle but was left out (see above). */
  previewOmitted?: string;
}

export interface PlanJson {
  actions: JsonAction[];
}

/** `am plan --json`. Exit 1 when a real difference exists (SPEC §5). */
export function planJson(options: { prune?: boolean } = {}): {
  exitCode: 0 | 1;
  payload: PlanJson;
} {
  const ctx = loadSourceContext();
  const actions = computeActions(ctx, { prune: options.prune === true });
  return { exitCode: planExitCode(actions), payload: { actions: actions.map(toJsonAction) } };
}

function toJsonAction(action: Action): JsonAction {
  const base: JsonAction = {
    kind: action.kind,
    target: action.target,
    assetType: action.asset,
    asset: action.name ?? "",
    path: action.path,
    detail: action.detail,
  };
  const before = action.before;
  const after = action.content;
  if (before === undefined && after === undefined) return base;

  const bytes = (before?.length ?? 0) + (after?.length ?? 0);
  if (bytes > PREVIEW_MAX_BYTES) {
    return { ...base, previewOmitted: `content exceeds ${PREVIEW_MAX_BYTES} bytes` };
  }
  return {
    ...base,
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* apply / import                                                      */
/* ------------------------------------------------------------------ */

/**
 * Run the real `apply` with its human output buffered away, returning both the
 * exit code and the structured record it filled in.
 *
 * A failure is **not** re-thrown to the CLI's generic handler. That handler
 * emits `{ error }` and nothing else, which for `apply` would throw away the
 * list of actions that already succeeded and the `backupDir` naming the only
 * copy of what they overwrote. Instead the partial report is returned with the
 * error attached and exit code 2 (SPEC §5), and the human-readable error still
 * goes to stderr exactly as the CLI would have written it.
 */
export function applyJson(
  options: Omit<ApplyOptions, "io" | "report"> = {},
  io: CommandIo = consoleIo,
): {
  exitCode: 0 | 1 | 2;
  payload: ApplyReport;
} {
  const report = emptyApplyReport();
  try {
    const exitCode = runApply({ ...options, io: stderrOnlyIo(io), report });
    return { exitCode, payload: report };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const path = err instanceof AmError ? err.path : undefined;
    // `report.error` is already set when the failure happened inside the
    // execution loop; a failure before it (drift, an unconfirmed prune, an
    // unreadable source) has to be recorded here.
    if (report.error === undefined) {
      report.error = { message, ...(path !== undefined ? { path } : {}) };
    }
    io.err(`error: ${message}`);
    if (path !== undefined) io.err(`  path: ${path}`);
    return { exitCode: 2, payload: report };
  }
}

export function importJson(
  options: Omit<ImportOptions, "io" | "report"> = {},
  io: CommandIo = consoleIo,
): {
  exitCode: 0;
  payload: ImportReport;
} {
  const report = emptyImportReport();
  const exitCode = runImport({ ...options, io: stderrOnlyIo(io), report });
  return { exitCode, payload: report };
}

/* ------------------------------------------------------------------ */
/* Emission                                                            */
/* ------------------------------------------------------------------ */

export interface JsonError {
  error: { message: string; path?: string };
}

/** Write a payload as the single JSON object on stdout. */
export function emitJson(payload: unknown, io: CommandIo): void {
  io.out(JSON.stringify(payload));
}
