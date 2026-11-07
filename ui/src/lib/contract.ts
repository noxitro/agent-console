/**
 * The `am ... --json` wire contract, as TypeScript types.
 *
 * **This file mirrors the engine.** The authoritative definitions live in
 * `src/commands/json.ts` and `src/core/report.ts` at the repository root; the
 * GUI is a separate TypeScript project (its own `tsconfig`, its own bundler),
 * so the shapes are restated here rather than imported across the boundary.
 * Change one, change the other.
 *
 * Two things the contract does *not* smooth over, deliberately (PRODUCT:
 * "失敗は大きく表示" / VS 2026 の MCP は unsupported 表示):
 *  - `"unsupported"` is a real value a target reports, not an empty list;
 *  - the action and link vocabularies include the failure-shaped members
 *    (`drift`, `broken`, `file`), because those are exactly what the GUI
 *    exists to surface.
 */

export type TargetId = "claude" | "copilot-cli" | "vscode" | "vs2026" | "opencode";

export type AssetType = "skill" | "mcp" | "agent" | "command";

export type LinkMode = "junction" | "copy";

/** A target that cannot carry an asset kind at all (SPEC §4). */
export const UNSUPPORTED = "unsupported";
export type Unsupported = typeof UNSUPPORTED;

export function isUnsupported<T>(value: T | Unsupported): value is Unsupported {
  return value === UNSUPPORTED;
}

/* ------------------------------- inventory ------------------------------- */

/**
 * What occupies a skill slot in a target's discovery directory.
 *
 * `junction` / `symlink` are healthy; `directory` is a physical copy (a
 * duplicate, possibly drifted); `broken` is a dangling link; `file` is a file
 * where a directory belongs; `missing` is an empty slot.
 */
export type SkillLinkKind =
  | "junction"
  | "symlink"
  | "directory"
  | "file"
  | "broken"
  | "missing"
  /** SPEC §9.7 — present as far as anyone can tell, and refused to us. */
  | "unreadable";

/**
 * SPEC §9.3 — the source of truth as **lists of assets**, one row per asset.
 *
 * `enabled` is the manifest's exclude list already applied by the engine. The
 * GUI never computes it: on/off is a fact about `manifest.json`, and Product
 * Principle 2 keeps facts on the engine's side of the wire.
 *
 * Optional fields are optional *in the data*, not merely in the type. `version`
 * is outside the agentskills.io schema and most skills genuinely have none, so
 * the interface draws 「—」 rather than inventing one.
 */
export interface SourceSkill {
  name: string;
  hasSkillMd: boolean;
  enabled: boolean;
  description?: string;
  version?: string;
  /** ISO8601 mtime of `SKILL.md` alone. */
  modified?: string;
  origin?: { source: string; sourceUrl?: string };
}

export interface SourceMcp {
  name: string;
  transport: string;
  enabled: boolean;
  targets?: TargetId[];
  /** Command (stdio) or URL (http/sse). */
  endpoint?: string;
  modified?: string;
}

export interface SourceAgent {
  name: string;
  description: string;
  enabled: boolean;
  model?: string;
  targets?: TargetId[];
  modified?: string;
}

/**
 * SPEC §10.2 — a user-added command, the asset kind opencode brought with it.
 *
 * `agent` is the opencode agent that runs the command. It is optional in the
 * frontmatter and therefore optional here: a command that names none gets 「—」
 * in the list, never a fabricated owner.
 */
export interface SourceCommand {
  name: string;
  description: string;
  enabled: boolean;
  agent?: string;
  targets?: TargetId[];
  modified?: string;
}

export interface InventorySource {
  root: string;
  manifestPresent: boolean;
  linkMode: LinkMode;
  skills: SourceSkill[];
  mcp: SourceMcp[];
  agents: SourceAgent[];
  commands: SourceCommand[];
}

export interface TargetSkill {
  name: string;
  kind: SkillLinkKind;
  /** Resolved link destination; absent for a physical directory. */
  dest?: string;
  /**
   * The engine's reason, for `kind: "unreadable"` (SPEC §9.7).
   *
   * Same shape and same rule as `SourceCommand.unreadable`: the engine looked
   * and could not, and it says why in its own words.
   */
  unreadable?: string;
}

export interface TargetMcp {
  name: string;
  transport: string;
  /**
   * The **target's own** per-server switch, when it has one (opencode's
   * `"enabled": false` — SPEC §10.3).
   *
   * Absent means the target has no such concept, which is a different statement
   * from `true`. Nothing to do with `SourceMcp.enabled`, which is this tool's
   * `manifest.mcp.exclude` (SPEC §9.1): a server can be enabled here and
   * switched off there, and the console has to be able to say so.
   */
  enabled?: boolean;
}

export interface TargetAgent {
  name: string;
}

/**
 * One command file in a target's own directory (SPEC §10.2).
 *
 * `description` is optional because `unreadable` exists: a file whose
 * frontmatter does not parse still occupies a row — with the file-name stem for
 * a name — and the engine sends no description for it rather than a blank one
 * the console would draw as if it had read something. `inventory` stays exit 0
 * over such a file (the scan completed); `doctor` reports it as an error, and
 * that is what puts a number in the DOCTOR cell.
 */
export interface TargetCommand {
  name: string;
  description?: string;
  agent?: string;
  /** The engine's parse error for this file, when it could not be read. */
  unreadable?: string;
}

/**
 * SPEC §10.4 — why a target answers `"unsupported"` for an asset kind.
 *
 * The console needs the reason and not only the verdict: 「非対応」 with nothing
 * behind it reads as a hole in this tool rather than as the deliberate refusal
 * it is (opencode's agent frontmatter has no safe conversion; VS 2026 has no
 * verified MCP format).
 */
export interface UnsupportedReason {
  assetType: AssetType;
  reason: string;
}

export interface InventoryTarget {
  id: TargetId;
  enabled: boolean;
  skillsDir: string | Unsupported;
  mcpPath: string | Unsupported;
  agentsDir: string | Unsupported;
  commandsDir: string | Unsupported;
  skills: TargetSkill[] | Unsupported;
  mcp: TargetMcp[] | Unsupported;
  agents: TargetAgent[] | Unsupported;
  commands: TargetCommand[] | Unsupported;
  /** Set when this target reads another target's directories (SPEC §4). */
  sharesDiscoveryWith?: TargetId;
  /** Reasons for every `"unsupported"` above that the adapter explains. */
  unsupportedReasons?: UnsupportedReason[];
}

export interface Inventory {
  source: InventorySource;
  targets: InventoryTarget[];
}

/* -------------------------------- doctor --------------------------------- */

export type FindingLevel = "error" | "warn";

export interface Finding {
  level: FindingLevel;
  /** Stable machine-readable code, e.g. `skill.duplicate-copy`. */
  code: string;
  target?: TargetId;
  asset?: string;
  detail: string;
  path?: string;
}

export interface Doctor {
  findings: Finding[];
}

/* --------------------------------- plan ---------------------------------- */

/**
 * SPEC §5. Two of these are **notes, not work**:
 *
 *  - `unsupported` — the target cannot carry this asset kind at all;
 *  - `preserve` — the asset exists only in the target and this run is
 *    deliberately leaving it alone (`--prune` would turn it into `delete`).
 *
 * The distinction is load-bearing for the confirmation dialog: it promises
 * 「以下を適用します」, so anything it lists has to be something `apply` will
 * actually do. `preserve` used to be spelled `delete`, which put a removal the
 * engine would skip into that list.
 */
export type ActionKind =
  | "create"
  | "update"
  | "delete"
  | "link"
  | "drift"
  | "preserve"
  | "unsupported";

/** Kinds that describe the environment rather than pending work (SPEC §5). */
export const INFORMATIONAL_KINDS: readonly ActionKind[] = ["unsupported", "preserve"];

export interface PlanAction {
  kind: ActionKind;
  target: TargetId;
  assetType: AssetType;
  /** Asset name; empty for actions about a whole config file. */
  asset: string;
  path: string;
  detail: string;
  /** SPEC §9.6 — current file text. Absent for `create` and for skills. */
  before?: string;
  /** SPEC §9.6 — the text the write would produce. Absent for `delete`. */
  after?: string;
  /** Why the preview is missing even though one would apply (size ceiling). */
  previewOmitted?: string;
}

/**
 * Would `apply` carry this action out?
 *
 * Mirrors `isExecutable` in `src/core/diff.ts` **including the `--prune` rule**,
 * because the dialog's list and the engine's work have to be the same list. The
 * GUI never passes `--prune`, so `delete` is not executable here.
 */
export function isExecutableAction(action: PlanAction, options: { prune?: boolean } = {}): boolean {
  if (action.kind === "drift" || action.kind === "unsupported" || action.kind === "preserve") {
    return false;
  }
  if (action.kind === "delete") return options.prune === true;
  return true;
}

export interface Plan {
  actions: PlanAction[];
}

/* --------------------------------- apply --------------------------------- */

export type AppliedStatus = "done" | "skipped" | "failed";

export interface AppliedAction extends PlanAction {
  status: AppliedStatus;
  error?: string;
}

export interface Apply {
  applied: AppliedAction[];
  /** Present only when the run actually wrote something (SPEC §5). */
  backupDir?: string;
  /**
   * Present when the run ended in an error. `applied` and `backupDir` still
   * describe everything that happened before it: a partially applied machine
   * has to be reportable, and the backup directory is the way back.
   */
  error?: { message: string; path?: string };
}

/* -------------------------------- import --------------------------------- */

export interface ImportedAsset {
  assetType: AssetType;
  asset: string;
  /** Target id for MCP/agents; the physical directory for a moved skill. */
  from: string;
}

export interface ImportConflict {
  assetType: AssetType;
  asset: string;
  targets: TargetId[];
  /** The target whose version won, when `--prefer` resolved it. */
  resolution?: TargetId;
}

/** A definition the normalized schema refused; it was NOT written (SPEC §3). */
export interface ImportRejection {
  assetType: AssetType;
  asset: string;
  from: string;
  reason: string;
}

/**
 * SPEC §10.3 — something was taken in, but not losslessly.
 *
 * opencode cannot tell `http` from `sse`, so a remote server imported from it
 * arrives as `http` and this note says so. It is neither a rejection (the asset
 * *was* written) nor silence (information was genuinely lost), which is why it
 * is a third channel rather than being folded into either.
 */
export interface ImportNote {
  code: string;
  assetType: AssetType;
  asset: string;
  from: string;
  detail: string;
}

export interface Import {
  imported: ImportedAsset[];
  conflicts: ImportConflict[];
  rejected: ImportRejection[];
  notes: ImportNote[];
}

/* ------------------------- enable / disable / remove ---------------------- */

/** SPEC §9.2 — the payload of `am enable|disable --json`. */
export interface ExcludeResult {
  changed: boolean;
  manifestPath: string;
  /** The exclude list *after* the change, not the delta. */
  excluded: string[];
  backupDir?: string;
}

/** SPEC §9.2 — the payload of `am remove --json`. */
export interface RemoveResult {
  removed: { assetType: AssetType; asset: string; path: string }[];
  backupDir?: string;
}

/* --------------------------------- error --------------------------------- */

export interface WireError {
  error: { message: string; path?: string };
}
