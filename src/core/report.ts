/**
 * Structured report shapes shared by the CLI's `--json` mode and the GUI.
 *
 * These types live in `core/` rather than in `commands/` for one reason: the
 * write commands (`apply`, `import`) accept a report object to fill in as they
 * work, and the module that *renders* the JSON imports those commands. Putting
 * the shapes here keeps that dependency one-directional.
 *
 * Nothing here is a second source of truth about what happened — every field is
 * filled in by the command that performed the operation, at the moment it
 * performed it (PRODUCT: "CLI と GUI は同じ真実").
 */

import type { ActionKind, AssetKind } from "./diff.js";
import type { TargetId } from "./model.js";

/** SPEC §5 asset vocabulary, as it appears in the JSON contract. */
export type AssetType = AssetKind;

/* ------------------------------------------------------------------ */
/* apply                                                               */
/* ------------------------------------------------------------------ */

/**
 * The outcome of one planned action.
 *
 * A write failure still aborts the run (exit 2) rather than continuing on a
 * broken environment — but the actions that already ran did run, and the entry
 * that threw is recorded as `failed` with its error before the run unwinds.
 * The report is the audit trail of a partial apply; dropping it would leave the
 * caller unable to say which files changed or where the backups went.
 */
export type AppliedStatus = "done" | "skipped" | "failed";

export interface AppliedEntry {
  kind: ActionKind;
  target: TargetId;
  assetType: AssetType;
  /** Asset name; empty when the action is about a whole config file. */
  asset: string;
  path: string;
  detail: string;
  status: AppliedStatus;
  error?: string;
}

/** Filled in by `runApply` when the caller supplies it. */
export interface ApplyReport {
  applied: AppliedEntry[];
  /** Present only when a write actually happened (SPEC §5). */
  backupDir?: string;
  /**
   * Present when the run ended in an error. `applied` and `backupDir` still
   * describe everything that happened before it, which is exactly what a
   * partial apply has to hand back.
   */
  error?: { message: string; path?: string };
}

export function emptyApplyReport(): ApplyReport {
  return { applied: [] };
}

/* ------------------------------------------------------------------ */
/* import                                                              */
/* ------------------------------------------------------------------ */

export interface ImportedEntry {
  assetType: AssetType;
  asset: string;
  /** Target id for MCP/agents; the physical directory for a moved skill. */
  from: string;
}

export interface ImportConflict {
  assetType: AssetType;
  asset: string;
  /** Every target that carries a differing definition. */
  targets: TargetId[];
  /** The target whose version won, when `--prefer` resolved it. */
  resolution?: TargetId;
}

/**
 * An asset found in a target that the normalized schema (SPEC §3) rejects.
 *
 * It was **not** written to the source of truth: storing it would make every
 * later command fail while reading the source back. Reported so the exclusion
 * is visible rather than silent.
 */
export interface ImportRejection {
  assetType: AssetType;
  asset: string;
  /** Target the rejected definition came from. */
  from: string;
  /** Why the normalized schema refused it. */
  reason: string;
}

/**
 * Something an import could **not** learn from the target it read (SPEC §10.3).
 *
 * Distinct from {@link ImportRejection}: the asset *was* imported, but a fact
 * about it was unrecoverable — opencode records both `http` and `sse` servers
 * as `type: "remote"`, so the transport of an imported remote server is a
 * default, not an observation. SPEC §10.3 is explicit that this must be
 * reported rather than guessed at in silence, and a note is how it travels to
 * both the CLI's output and the console.
 */
export interface ImportNote {
  /** Stable machine-readable code, e.g. `opencode.remote-transport-ambiguous`. */
  code: string;
  assetType: AssetType;
  asset: string;
  /** Target the asset came from. */
  from: TargetId;
  /** What could not be recovered, and what was assumed instead. */
  detail: string;
}

/** Filled in by `runImport` when the caller supplies it. */
export interface ImportReport {
  imported: ImportedEntry[];
  conflicts: ImportConflict[];
  rejected: ImportRejection[];
  /** SPEC §10.3. Empty is the normal case; it is never omitted. */
  notes: ImportNote[];
}

export function emptyImportReport(): ImportReport {
  return { imported: [], conflicts: [], rejected: [], notes: [] };
}
