/**
 * The diff engine (SPEC §7).
 *
 * Everything here is a **pure function**: no file-system access, no clock, no
 * environment. Callers gather the current on-disk state (via `fsops`) and the
 * desired state (via adapters), hand both to these functions, and get back a
 * sorted `Action[]`. That is what makes `plan` provably write-free (SPEC §6.5)
 * and makes the whole engine trivially testable.
 */

import type { FileEdit, LinkMode, SkillLink, TargetId } from "./model.js";

/* ------------------------------------------------------------------ */
/* Action                                                              */
/* ------------------------------------------------------------------ */

/** Action kinds from SPEC §5, plus `unsupported` for vs2026 MCP (SPEC §4). */
export type ActionKind =
  /** Target has nothing; the source provides it. */
  | "create"
  /** Target has it with different content. */
  | "update"
  /** Present in the target but absent from the source (managed assets only). */
  | "delete"
  /**
   * Present in the target, absent from the source, and **kept** — an unmanaged
   * asset that this run deliberately leaves alone (SPEC §5: 削除は `--prune`
   * のみ).
   *
   * This is a note, not a difference. It exists because "we saw this and chose
   * not to touch it" and "we are about to remove this" are opposite statements
   * that were previously both spelled `delete`: a single MCP server registered
   * by Claude Code itself made `plan` exit 1 forever (the SPEC §8 fixed point
   * became unreachable) and made the GUI's confirmation dialog promise a
   * deletion that `apply` would never perform.
   */
  | "preserve"
  /** Materialize a skill as a junction (or a copy under `linkMode: "copy"`). */
  | "link"
  /** Conflicting physical state that `apply` must not silently resolve. */
  | "drift"
  /** The target cannot carry this asset kind at all. */
  | "unsupported";

/** SPEC §10.2 adds `command` to the three v1 asset kinds. */
export type AssetKind = "mcp" | "agent" | "skill" | "command";

export interface Action {
  kind: ActionKind;
  target: TargetId;
  asset: AssetKind;
  /** Absolute path the action operates on. */
  path: string;
  /** Human-readable explanation shown by `plan` / `apply`. */
  detail: string;
  /** Asset name (server name, agent name, skill name) when applicable. */
  name?: string;
  /** Full desired file content, for `create` / `update` of file-backed assets. */
  content?: string;
  /**
   * Full **current** file content, for `update` / `delete` of file-backed
   * assets. Absent for `create` (there is nothing there yet) and for skills
   * (a directory has no single text to show).
   *
   * SPEC §9.6: this is what lets the confirmation dialog show *what changes*
   * rather than only *which files change*. It is a snapshot taken at plan time;
   * `apply` re-reads before writing, so it is a preview, never the input to a
   * write.
   */
  before?: string;
  /** Source directory, for skill `link` actions. */
  sourcePath?: string;
  /** Requested materialization mode, for skill `link` actions. */
  linkMode?: LinkMode;
}

/** `drift`, `unsupported` and `preserve` are never executed by `apply`. */
export const NON_EXECUTABLE_KINDS: readonly ActionKind[] = ["drift", "unsupported", "preserve"];

/**
 * Kinds that are notes about the environment rather than pending work.
 *
 * `hasChanges` (and therefore the SPEC §5 exit code) ignores exactly these, so
 * a plan made only of them is "nothing to do" — which is what lets
 * `apply → plan` settle at zero differences (SPEC §8).
 */
export const INFORMATIONAL_KINDS: readonly ActionKind[] = ["unsupported", "preserve"];

/** `delete` is only executed under `apply --prune` (SPEC §5). */
export function isExecutable(action: Action, options: { prune?: boolean } = {}): boolean {
  if (NON_EXECUTABLE_KINDS.includes(action.kind)) return false;
  if (action.kind === "delete") return options.prune === true;
  return true;
}

/* ------------------------------------------------------------------ */
/* File-backed assets (MCP config files, agent markdown files)         */
/* ------------------------------------------------------------------ */

/** Current on-disk content of a path. `null` means the file does not exist. */
export interface FileState {
  path: string;
  content: string | null;
}

export interface DiffFilesInput {
  target: TargetId;
  asset: AssetKind;
  /** Desired files, from an adapter's `render*`. */
  desired: readonly FileEdit[];
  /** Current state of every path the tool manages for this target+asset. */
  actual: readonly FileState[];
  /**
   * Managed paths that exist but are absent from `desired` produce `delete`.
   * When false (the default for whole-file configs like `mcp.json`, whose
   * lifecycle is "always rewritten, never removed"), extras are ignored.
   */
  reportDeletes?: boolean;
  /** Optional name lookup for nicer output. */
  nameOf?: (filePath: string) => string | undefined;
}

/**
 * Compare desired file contents against current ones.
 *
 * Content comparison is exact string equality on the rendered text. Adapters
 * are responsible for rendering deterministically (sorted keys, canonical
 * formatting) so that a semantically unchanged config does not show up as an
 * endless `update` — that determinism is what makes SPEC §8's
 * "import → apply → plan が差分ゼロ" fixed point reachable.
 */
export function diffFiles(input: DiffFilesInput): Action[] {
  const { target, asset, desired, actual, reportDeletes = false, nameOf } = input;
  const actualByPath = new Map<string, string | null>();
  for (const state of actual) actualByPath.set(normalizePathKey(state.path), state.content);

  const actions: Action[] = [];
  const desiredPaths = new Set<string>();

  for (const edit of desired) {
    const key = normalizePathKey(edit.path);
    desiredPaths.add(key);
    const current = actualByPath.get(key) ?? null;
    if (current === null) {
      actions.push(
        makeAction({
          kind: "create",
          target,
          asset,
          path: edit.path,
          detail: "not present in target",
          name: nameOf?.(edit.path),
          content: edit.content,
        }),
      );
    } else if (current !== edit.content) {
      actions.push(
        makeAction({
          kind: "update",
          target,
          asset,
          path: edit.path,
          detail: "content differs from source",
          name: nameOf?.(edit.path),
          content: edit.content,
          before: current,
        }),
      );
    }
  }

  if (reportDeletes) {
    for (const state of actual) {
      const key = normalizePathKey(state.path);
      if (state.content === null) continue;
      if (desiredPaths.has(key)) continue;
      actions.push(
        makeAction({
          kind: "delete",
          target,
          asset,
          path: state.path,
          detail: "present in target but absent from source",
          name: nameOf?.(state.path),
          before: state.content,
        }),
      );
    }
  }

  return sortActions(actions);
}

/* ------------------------------------------------------------------ */
/* Skills                                                              */
/* ------------------------------------------------------------------ */

export interface SkillDiffEntry {
  name: string;
  /** Absolute path of the source skill directory (`~/.agents/skills/<name>`). */
  sourcePath: string;
  /** Absolute path inside the target's discovery directory. */
  targetPath: string;
  /** What currently occupies `targetPath`. */
  link: SkillLink;
  /**
   * For `link.kind === "junction" | "symlink"`: does it resolve to `sourcePath`?
   */
  linkResolvesToSource?: boolean;
  /**
   * For `link.kind === "directory"`: does its content hash equal the source's?
   * SPEC §6.6 permits replacing a real directory with a junction **only** when
   * this is true.
   */
  contentIdentical?: boolean;
  /**
   * Set when the comparison could not be made at all — the tree exceeded the
   * SPEC §9.5 hashing limits. Distinct from `contentIdentical: false`, which
   * asserts a real difference; this one asserts nothing and must be surfaced as
   * such rather than accusing the user of an edit we never looked at.
   */
  contentIncomparable?: string;
}

export interface DiffSkillsInput {
  target: TargetId;
  linkMode: LinkMode;
  entries: readonly SkillDiffEntry[];
  /**
   * Skill directories found in the target that have no counterpart in the
   * source. Reported as `delete` (executed only with `--prune`).
   */
  orphans?: readonly SkillLink[];
}

/**
 * Plan skill materialization for one target.
 *
 * The interesting case is SPEC §6.6: a *real directory* already sitting where
 * the junction should go. We only replace it when its content hash matches the
 * source exactly; any difference is `drift` and stops `apply`, because
 * replacing a divergent physical copy would destroy edits the user made
 * directly in the target directory.
 */
export function diffSkills(input: DiffSkillsInput): Action[] {
  const { target, linkMode, entries, orphans = [] } = input;
  const actions: Action[] = [];

  for (const entry of entries) {
    const base = {
      target,
      asset: "skill" as const,
      path: entry.targetPath,
      name: entry.name,
      sourcePath: entry.sourcePath,
      linkMode,
    };

    switch (entry.link.kind) {
      case "missing":
        actions.push(
          makeAction({
            ...base,
            kind: "link",
            detail:
              linkMode === "junction"
                ? "create junction to source skill"
                : "copy source skill into target",
          }),
        );
        break;

      case "broken":
        actions.push(
          makeAction({
            ...base,
            kind: "update",
            detail: `broken link (${entry.link.linkTarget ?? "unknown destination"}); recreate`,
          }),
        );
        break;

      /*
       * SPEC §9.7 — the slot could not be read, so nothing may be written over
       * it. This is `drift` for the same reason an incomparable physical copy
       * is: `apply` refuses on drift (SPEC §6.6), and refusing is the only
       * honest move when the thing we would replace is a thing we could not
       * look at. Treating it as `missing` planned a junction over whatever is
       * actually sitting there.
       */
      case "unreadable":
        actions.push(
          makeAction({
            ...base,
            kind: "drift",
            detail: `target path could not be read (${entry.link.unreadable ?? "reason unavailable"}); resolve manually`,
          }),
        );
        break;

      case "junction":
      case "symlink":
        if (linkMode === "copy") {
          actions.push(
            makeAction({
              ...base,
              kind: "update",
              detail: 'linkMode is "copy"; replace link with a physical copy',
            }),
          );
        } else if (entry.linkResolvesToSource !== true) {
          actions.push(
            makeAction({
              ...base,
              kind: "update",
              detail: `link points at ${entry.link.linkTarget ?? "an unknown path"}, expected the source skill`,
            }),
          );
        }
        break;

      case "directory":
        // SPEC §9.5: an uncomparable tree is reported, never silently applied
        // and never silently passed over. `drift` is the honest kind — `apply`
        // refuses, and the detail says why the comparison did not happen.
        if (entry.contentIncomparable !== undefined) {
          actions.push(
            makeAction({
              ...base,
              kind: "drift",
              detail: `physical copy could not be compared with the source (${entry.contentIncomparable}); resolve manually`,
            }),
          );
        } else if (linkMode === "copy") {
          if (entry.contentIdentical !== true) {
            actions.push(
              makeAction({ ...base, kind: "update", detail: "copy differs from source" }),
            );
          }
        } else if (entry.contentIdentical === true) {
          actions.push(
            makeAction({
              ...base,
              kind: "link",
              detail: "physical copy matches source; back up and replace with junction",
            }),
          );
        } else {
          actions.push(
            makeAction({
              ...base,
              kind: "drift",
              detail:
                "physical copy differs from source; refusing to replace it (resolve manually or re-import)",
            }),
          );
        }
        break;

      case "file":
        actions.push(
          makeAction({
            ...base,
            kind: "drift",
            detail: "a file occupies the skill directory path",
          }),
        );
        break;
    }
  }

  for (const orphan of orphans) {
    actions.push(
      makeAction({
        kind: "delete",
        target,
        asset: "skill",
        path: orphan.path,
        name: orphan.name,
        detail: "present in target but absent from source",
      }),
    );
  }

  return sortActions(actions);
}

/* ------------------------------------------------------------------ */
/* Constructors / combinators                                          */
/* ------------------------------------------------------------------ */

/** Build an `unsupported` action (e.g. MCP on vs2026 — SPEC §4). */
export function unsupportedAction(
  target: TargetId,
  asset: AssetKind,
  detail: string,
  path = "",
): Action {
  return makeAction({ kind: "unsupported", target, asset, path, detail });
}

/** Build a `drift` action. */
export function driftAction(
  target: TargetId,
  asset: AssetKind,
  path: string,
  detail: string,
  name?: string,
): Action {
  return makeAction({ kind: "drift", target, asset, path, detail, name });
}

/** Concatenate and re-sort several action lists. */
export function mergeActions(...groups: readonly Action[][]): Action[] {
  return sortActions(groups.flat());
}

/**
 * Deterministic ordering for stable output and stable test assertions:
 * target → asset → kind → path.
 */
export function sortActions(actions: readonly Action[]): Action[] {
  const targetOrder: Record<TargetId, number> = {
    claude: 0,
    "copilot-cli": 1,
    vscode: 2,
    vs2026: 3,
    opencode: 4,
  };
  const assetOrder: Record<AssetKind, number> = { skill: 0, mcp: 1, agent: 2, command: 3 };
  const kindOrder: Record<ActionKind, number> = {
    create: 0,
    update: 1,
    link: 2,
    delete: 3,
    drift: 4,
    preserve: 5,
    unsupported: 6,
  };
  return [...actions].sort(
    (a, b) =>
      targetOrder[a.target] - targetOrder[b.target] ||
      assetOrder[a.asset] - assetOrder[b.asset] ||
      kindOrder[a.kind] - kindOrder[b.kind] ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}

/** True when any action represents a real difference from the desired state. */
export function hasChanges(actions: readonly Action[]): boolean {
  return actions.some((a) => !INFORMATIONAL_KINDS.includes(a.kind));
}

/** True when any action is blocking (`drift`). */
export function hasDrift(actions: readonly Action[]): boolean {
  return actions.some((a) => a.kind === "drift");
}

/** Count of actions per kind, for summary output. */
export function summarizeActions(actions: readonly Action[]): Record<ActionKind, number> {
  const summary: Record<ActionKind, number> = {
    create: 0,
    update: 0,
    link: 0,
    delete: 0,
    drift: 0,
    preserve: 0,
    unsupported: 0,
  };
  for (const action of actions) summary[action.kind] += 1;
  return summary;
}

/**
 * Exit code per SPEC §5: 0 when there is nothing to do, 1 when a difference
 * exists. (Exit code 2 is reserved for thrown errors and produced by the CLI.)
 */
export function planExitCode(actions: readonly Action[]): 0 | 1 {
  return hasChanges(actions) ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

interface ActionInit {
  kind: ActionKind;
  target: TargetId;
  asset: AssetKind;
  path: string;
  detail: string;
  name?: string | undefined;
  content?: string | undefined;
  before?: string | undefined;
  sourcePath?: string | undefined;
  linkMode?: LinkMode | undefined;
}

/** Build an `Action`, omitting optional keys that are `undefined`. */
function makeAction(init: ActionInit): Action {
  const action: Action = {
    kind: init.kind,
    target: init.target,
    asset: init.asset,
    path: init.path,
    detail: init.detail,
  };
  if (init.name !== undefined) action.name = init.name;
  if (init.content !== undefined) action.content = init.content;
  if (init.before !== undefined) action.before = init.before;
  if (init.sourcePath !== undefined) action.sourcePath = init.sourcePath;
  if (init.linkMode !== undefined) action.linkMode = init.linkMode;
  return action;
}

/** Windows paths are case-insensitive and mix separators; normalize for keys. */
function normalizePathKey(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}
