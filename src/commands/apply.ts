/**
 * `am apply` — execute the plan (SPEC §5).
 *
 * This is the **only** module in the tool that writes to a target (SPEC §7).
 * Adapters plan; the diff engine compares; everything below is the single
 * place where bytes move, which is what makes the safety rules auditable:
 *
 *  - every file or directory about to change is copied into
 *    `~/.agents-manager/backups/<ts>/` first, under its original path
 *    structure (SPEC §5);
 *  - writes are temp-file → `rename` (SPEC §6.4), via `fsops`;
 *  - nothing is ever deleted without `--prune`, and `--prune` lists its
 *    victims and demands `--yes` (SPEC §5);
 *  - `drift` aborts the run before the first write (SPEC §6.6): a physical
 *    copy that disagrees with the source may hold the user's only copy of an
 *    edit, so we refuse rather than guess.
 *
 * `--dry-run` is `plan` (SPEC §5) — literally the same action list.
 */

import {
  hasDrift,
  isExecutable,
  planExitCode,
  summarizeActions,
  type Action,
} from "../core/diff.js";
import {
  backupPath,
  createCopy,
  createJunction,
  inspectPath,
  removePath,
  writeFileAtomic,
  type LinkResult,
} from "../core/fsops.js";
import { AmError, type LinkMode } from "../core/model.js";
import type { AppliedStatus, ApplyReport } from "../core/report.js";
import { backupDir } from "../core/paths.js";
import { computeActions, printActions, renderMcpEdits } from "./plan.js";
import { consoleIo, loadSourceContext, type CommandIo, type SourceContext } from "./context.js";

export interface ApplyOptions {
  /** Execute `delete` actions as well (SPEC §5). Requires `yes`. */
  prune?: boolean;
  /** Same as `am plan` — compute and print, write nothing (SPEC §5). */
  dryRun?: boolean;
  /** Explicit confirmation for the deletions `--prune` would perform. */
  yes?: boolean;
  io?: CommandIo;
  /** Injectable clock, so tests get a deterministic backup directory name. */
  now?: Date;
  /**
   * Optional structured record of what happened, filled in as the run proceeds.
   * Supplied by the CLI's `--json` mode and by the GUI; the human-readable
   * output is unaffected by its presence.
   */
  report?: ApplyReport;
}

/* ------------------------------------------------------------------ */
/* Command                                                             */
/* ------------------------------------------------------------------ */

/**
 * `am apply`. Returns 0 on success (SPEC §5); `--dry-run` returns the `plan`
 * exit code. Failures throw `AmError` and the CLI maps them to exit code 2.
 */
export function runApply(options: ApplyOptions = {}): 0 | 1 {
  const io = options.io ?? consoleIo;
  const prune = options.prune === true;
  const report = options.report;
  const ctx = loadSourceContext();
  const actions = computeActions(ctx, { prune });

  if (options.dryRun === true) {
    printActions(actions, io);
    io.out();
    io.out("(dry run — nothing was written)");
    // A dry run performs nothing, so every action is reported as `skipped`
    // rather than as a prediction of success.
    record(report, actions, "skipped");
    return planExitCode(actions);
  }

  assertNoDrift(actions, io);

  const executable = actions.filter((action) => isExecutable(action, { prune }));
  const deletions = executable.filter((action) => action.kind === "delete");
  if (deletions.length > 0) confirmDeletions(deletions, options.yes === true, io);

  // Everything the plan listed but this run will not perform (`drift`,
  // `unsupported`, un-pruned deletions) is still reported — silence would read
  // as "there was nothing else", which is exactly the thing PRODUCT's
  // "失敗は大きく表示" forbids.
  record(
    report,
    actions.filter((action) => !executable.includes(action)),
    "skipped",
  );

  if (executable.length === 0) {
    io.out("Nothing to do. The environment already matches the source of truth.");
    return 0;
  }

  const backupRoot = backupDir(options.now ?? new Date());
  if (report !== undefined) report.backupDir = backupRoot;
  io.out(`Backups: ${backupRoot}`);
  io.out();

  const linkMode = ctx.manifest.skills.linkMode;
  for (const action of executable) {
    let status: AppliedStatus;
    try {
      status = execute(action, backupRoot, linkMode, io, ctx, prune);
    } catch (err) {
      // The run stops here (SPEC §6.3), but everything already written stays
      // written, so the record of it — including the backup directory that is
      // the only way back — must survive the throw. Without this the report
      // handed to `--json` would be empty and a half-applied environment would
      // have no audit trail at all.
      recordFailure(report, action, err);
      io.err(`  FAILED   ${action.asset} ${action.name ?? ""} — ${action.path}`);
      throw err;
    }
    record(report, [action], status);
  }

  const summary = summarizeActions(executable);
  io.out();
  io.out(
    `Applied: ${Object.entries(summary)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `${kind}=${count}`)
      .join(" ")}`,
  );
  return 0;
}

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

/**
 * SPEC §6.6: a physical skill copy whose content differs from the source is
 * `drift` and an error. We stop before touching anything at all — a partial
 * apply on top of an unresolved conflict is harder to reason about than no
 * apply.
 */
function assertNoDrift(actions: readonly Action[], io: CommandIo): void {
  if (!hasDrift(actions)) return;
  io.err("Refusing to apply: unresolved drift.");
  for (const action of actions.filter((a) => a.kind === "drift")) {
    io.err(`  [${action.target}] ${action.name ?? action.asset} — ${action.path}`);
    io.err(`      ${action.detail}`);
  }
  throw new AmError(
    "Drift detected; resolve it (or re-run `am import`) before applying. Nothing was written.",
  );
}

/** SPEC §5: pruning enumerates its targets and requires an explicit go-ahead. */
function confirmDeletions(deletions: readonly Action[], yes: boolean, io: CommandIo): void {
  io.out("The following managed assets exist in a target but not in the source:");
  for (const action of deletions) {
    io.out(`  [${action.target}] ${action.asset} ${action.name ?? ""} — ${action.path}`);
  }
  io.out();
  if (!yes) {
    throw new AmError(
      "Refusing to delete without confirmation. Re-run with `--prune --yes` to remove the assets listed above. Nothing was written.",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

/** Append `actions` to the report, if one was supplied, with a fixed status. */
function record(
  report: ApplyReport | undefined,
  actions: readonly Action[],
  status: AppliedStatus,
): void {
  if (report === undefined) return;
  for (const action of actions) {
    report.applied.push({
      kind: action.kind,
      target: action.target,
      assetType: action.asset,
      asset: action.name ?? "",
      path: action.path,
      detail: action.detail,
      status,
    });
  }
}

/**
 * Record the action that threw, with its error, and mark the run as failed.
 *
 * `AppliedStatus: "failed"` and `AppliedEntry.error` exist for exactly this
 * moment; before this they were unreachable vocabulary.
 */
function recordFailure(report: ApplyReport | undefined, action: Action, err: unknown): void {
  if (report === undefined) return;
  const message = err instanceof Error ? err.message : String(err);
  const path = err instanceof AmError ? err.path : undefined;
  report.applied.push({
    kind: action.kind,
    target: action.target,
    assetType: action.asset,
    asset: action.name ?? "",
    path: action.path,
    detail: action.detail,
    status: "failed",
    error: message,
  });
  report.error = { message, ...(path !== undefined ? { path } : {}) };
}

function execute(
  action: Action,
  backupRoot: string,
  linkMode: LinkMode,
  io: CommandIo,
  ctx: SourceContext,
  prune: boolean,
): AppliedStatus {
  switch (action.asset) {
    case "skill":
      return executeSkill(action, backupRoot, linkMode, io);
    case "mcp":
      return executeMcp(action, backupRoot, io, ctx, prune);
    case "agent":
    // SPEC §10.2: a command is one markdown file, exactly like an agent —
    // same backup, same atomic replace, same `delete` semantics.
    case "command":
      return executeFile(action, backupRoot, io);
  }
}

/**
 * MCP `delete` is not a file operation: a pruned server disappears because the
 * `update` action for the same config file re-renders it without that entry.
 * Removing the file itself would destroy every other server in it.
 *
 * For a write, the content planned earlier is deliberately **discarded** and the
 * document is re-rendered here, immediately before the `rename`. SPEC §6.1's
 * 読み込み→キー差し替え→全体シリアライズ has to be one transaction *at write
 * time*: `~/.claude.json` is a live file Claude Code rewrites constantly (oauth
 * refresh, project history), and the gap between planning and writing — skill
 * backups, junction creation — is long enough for one of those updates to be
 * clobbered by a stale snapshot. Re-rendering also re-runs the adapter's
 * other-keys assertion against the *current* document.
 */
function executeMcp(
  action: Action,
  backupRoot: string,
  io: CommandIo,
  ctx: SourceContext,
  prune: boolean,
): AppliedStatus {
  if (action.kind === "delete") {
    io.out(`  removed  mcp ${action.name ?? ""} from ${action.path}`);
    return "done";
  }
  const adapter = ctx.adapters.find((a) => a.id === action.target);
  const planned = adapter === undefined ? undefined : renderMcpEdits(adapter, ctx, prune);
  if (planned === undefined) {
    // No way to re-render (an adapter without MCP support cannot produce an
    // executable action anyway); fall back to the planned content.
    return executeFile(action, backupRoot, io);
  }
  const key = (p: string): string => p.replace(/\\/g, "/").toLowerCase();
  const fresh = planned.edits.find((edit) => key(edit.path) === key(action.path));
  if (fresh === undefined) {
    // The file changed under us in a way that leaves nothing to write. Writing
    // the stale snapshot instead would be exactly the bug this re-render exists
    // to prevent, so skip and say so.
    io.out(`  skipped  mcp ${action.path} (no longer needs a write)`);
    return "skipped";
  }
  return executeFile({ ...action, content: fresh.content }, backupRoot, io);
}

/** `create` / `update` / `delete` for a file-backed asset. */
function executeFile(action: Action, backupRoot: string, io: CommandIo): AppliedStatus {
  if (action.kind === "delete") {
    backupPath(action.path, backupRoot);
    removePath(action.path);
    io.out(`  deleted  ${action.asset} ${label(action)}`);
    return "done";
  }
  if (action.content === undefined) {
    throw new AmError(`Internal error: ${action.kind} action for ${action.path} has no content`, {
      path: action.path,
    });
  }
  backupPath(action.path, backupRoot);
  writeFileAtomic(action.path, action.content);
  io.out(`  ${action.kind === "create" ? "created" : "updated"}  ${action.asset} ${label(action)}`);
  return "done";
}

/**
 * Materialize a skill: back up whatever occupies the slot, clear it, then link
 * (or copy). `create`/`update`/`link` all reduce to the same operation — the
 * distinction only exists to describe *why* in the plan output.
 *
 * SPEC §6.6: a junction failure falls back to a recursive copy and the
 * fallback must be visible in the output, never silent.
 */
function executeSkill(
  action: Action,
  backupRoot: string,
  linkMode: LinkMode,
  io: CommandIo,
): AppliedStatus {
  if (action.kind === "delete") {
    backupPath(action.path, backupRoot);
    removePath(action.path);
    io.out(`  deleted  skill ${label(action)}`);
    return "done";
  }

  const source = action.sourcePath;
  if (source === undefined) {
    throw new AmError(`Internal error: skill action for ${action.path} has no source path`, {
      path: action.path,
    });
  }
  if (!inspectPath(source).isDirectory) {
    throw new AmError(`Source skill directory is missing: ${source}`, { path: source });
  }

  backupPath(action.path, backupRoot);
  removePath(action.path);

  const mode = action.linkMode ?? linkMode;
  const result: LinkResult =
    mode === "junction" ? createJunction(source, action.path) : createCopy(source, action.path);

  io.out(`  ${result.mode === "junction" ? "linked " : "copied "}  skill ${label(action)}`);
  if (result.fellBack) {
    io.out(`           ! junction failed (${result.error ?? "unknown error"}); copied instead`);
  }
  return "done";
}

function label(action: Action): string {
  return `${action.name ?? ""} — ${action.path}`;
}
