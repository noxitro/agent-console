/**
 * `am enable` / `am disable` / `am remove` — the SPEC §9.2 asset commands.
 *
 * These are the engine half of the management console: the GUI's enable
 * toggle and delete button call *these*, rather than editing `manifest.json`
 * or the source tree themselves (PRODUCT Principle 2 — "GUI 専用ロジックで
 * 結果が変わることを許さない"). Everything a console can do to an asset is
 * therefore also something the CLI can do, with the same backups and the same
 * refusals.
 *
 * Three rules hold for all of them:
 *
 *  - **A write is preceded by a backup** (SPEC §9.2). `enable`/`disable` back up
 *    `manifest.json`; `remove` backs up the asset itself. Both land in
 *    `backups/<ts>/` under the original path structure, like `apply`'s.
 *  - **Enable/disable never touch the asset.** SPEC §9.1: exclusion is the only
 *    definition of "disabled", and the file stays exactly where it was.
 *  - **A name that does not exist is exit 2** (SPEC §9.2), never a silent
 *    success. Excluding a typo would look identical to excluding a real asset,
 *    and the owner would find out at the next `apply`.
 */

import {
  AmError,
  excludeListOf,
  type AssetKindId,
  type Manifest,
} from "../core/model.js";
import { backupPath, inspectPath, removePath } from "../core/fsops.js";
import { readManifest, writeManifest } from "../core/manifest.js";
import {
  backupDir,
  manifestPath,
  sourceAgentPath,
  sourceCommandPath,
  sourceMcpPath,
  sourceSkillDir,
} from "../core/paths.js";
import {
  readSourceAgents,
  readSourceCommands,
  readSourceServers,
  readSourceSkills,
  writeSourceServers,
} from "../core/source.js";
import { consoleIo, type CommandIo } from "./context.js";

/* ------------------------------------------------------------------ */
/* Reports (the `--json` payloads of SPEC §9.2)                        */
/* ------------------------------------------------------------------ */

export interface ExcludeReport {
  changed: boolean;
  manifestPath: string;
  /** The list after the change, sorted — the whole list, not the delta. */
  excluded: string[];
  /** Present only when something was written (SPEC §9.2). */
  backupDir?: string;
}

export interface RemovedAsset {
  assetType: AssetKindId;
  asset: string;
  path: string;
}

export interface RemoveReport {
  removed: RemovedAsset[];
  /** Present only when something was written. */
  backupDir?: string;
}

export interface AssetCommandOptions {
  io?: CommandIo;
  /** Injectable clock, so tests get a deterministic backup directory name. */
  now?: Date;
}

export interface RemoveOptions extends AssetCommandOptions {
  /** SPEC §9.2: without it, `remove` lists its victims and deletes nothing. */
  yes?: boolean;
}

/* ------------------------------------------------------------------ */
/* Asset resolution                                                    */
/* ------------------------------------------------------------------ */

/** Human label for each asset kind, used in messages. */
const KIND_LABEL: Record<AssetKindId, string> = {
  skill: "skill",
  mcp: "MCP server",
  agent: "agent",
  command: "command",
};

/** Every name the source of truth currently holds for one asset kind. */
export function sourceAssetNames(kind: AssetKindId): string[] {
  switch (kind) {
    case "skill":
      return readSourceSkills().map((s) => s.name);
    case "mcp":
      return Object.keys(readSourceServers()).sort();
    case "agent":
      return readSourceAgents().map((a) => a.name);
    case "command":
      return readSourceCommands().map((c) => c.name);
  }
}

/**
 * The file or directory a named asset lives in.
 *
 * For MCP this is `mcp/servers.json` — the entry's *container*, since a server
 * is a key inside a shared document rather than a file of its own.
 */
export function sourceAssetPath(kind: AssetKindId, name: string): string {
  switch (kind) {
    case "skill":
      return sourceSkillDir(name);
    case "mcp":
      return sourceMcpPath();
    case "agent":
      return sourceAgentPath(name);
    case "command":
      return sourceCommandPath(name);
  }
}

/** Throw exit-2 unless `name` names an asset that actually exists (SPEC §9.2). */
function assertAssetExists(kind: AssetKindId, name: string): void {
  const names = sourceAssetNames(kind);
  if (names.includes(name)) return;
  const known = names.length === 0 ? "(none)" : names.join(", ");
  throw new AmError(
    `No such ${KIND_LABEL[kind]} in the source of truth: "${name}". Known ${kind} names: ${known}`,
  );
}

/* ------------------------------------------------------------------ */
/* enable / disable                                                    */
/* ------------------------------------------------------------------ */

/**
 * Add or remove `name` from the exclude list for `kind`.
 *
 * Returns the SPEC §9.2 exit code: 0 both when the manifest changed and when it
 * already said what was asked for. "Already enabled" is a success, not a
 * difference — the caller asked for a state, and the state holds.
 */
export function runExclusion(
  kind: AssetKindId,
  name: string,
  excluded: boolean,
  options: AssetCommandOptions = {},
): { exitCode: 0; report: ExcludeReport } {
  const io = options.io ?? consoleIo;
  assertAssetExists(kind, name);

  const manifest = readManifest();
  const list = excludeListOf(manifest, kind);
  const present = list.includes(name);
  const verb = excluded ? "disabled" : "enabled";

  if (present === excluded) {
    io.out(`${KIND_LABEL[kind]} "${name}" is already ${verb}.`);
    return {
      exitCode: 0,
      report: { changed: false, manifestPath: manifestPath(), excluded: sorted(list) },
    };
  }

  const next = excluded ? [...list, name] : list.filter((n) => n !== name);
  setExcludeList(manifest, kind, next);

  // SPEC §9.2: the manifest is copied into `backups/<ts>/` before it is
  // replaced. It is a small file, but it is the only record of which assets the
  // owner had switched off, and a bad write is otherwise unrecoverable.
  const backupRoot = backupDir(options.now ?? new Date());
  backupPath(manifestPath(), backupRoot);
  writeManifest(manifest);

  io.out(`${KIND_LABEL[kind]} "${name}" is now ${verb}.`);
  io.out(`Backups: ${backupRoot}`);
  return {
    exitCode: 0,
    report: {
      changed: true,
      manifestPath: manifestPath(),
      excluded: sorted(next),
      backupDir: backupRoot,
    },
  };
}

export function runEnable(
  kind: AssetKindId,
  name: string,
  options: AssetCommandOptions = {},
): { exitCode: 0; report: ExcludeReport } {
  return runExclusion(kind, name, false, options);
}

export function runDisable(
  kind: AssetKindId,
  name: string,
  options: AssetCommandOptions = {},
): { exitCode: 0; report: ExcludeReport } {
  return runExclusion(kind, name, true, options);
}

function setExcludeList(manifest: Manifest, kind: AssetKindId, values: readonly string[]): void {
  const next = sorted(values);
  switch (kind) {
    case "skill":
      manifest.skills.exclude = next;
      return;
    case "mcp":
      manifest.mcp.exclude = next;
      return;
    case "agent":
      manifest.agents.exclude = next;
      return;
    case "command":
      manifest.commands.exclude = next;
      return;
  }
}

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/* ------------------------------------------------------------------ */
/* remove                                                              */
/* ------------------------------------------------------------------ */

/**
 * Delete an asset **from the source of truth** (SPEC §9.2).
 *
 * This does not touch the targets. The asset stops being delivered, and the
 * copies already sitting in `~/.claude/skills` and friends are removed by
 * `apply --prune` — the one command whose whole job is deleting from a live
 * environment, with its own confirmation. Splitting it this way keeps the
 * blast radius of a mis-click inside `~/.agents-manager` + `~/.agents/skills`,
 * both of which have just been backed up.
 *
 * Exit code: 0 when the asset was removed, **1** when `--yes` was absent (the
 * victims are listed and nothing is written), 2 (throw) when the name is
 * unknown.
 */
export function runRemove(
  kind: AssetKindId,
  name: string,
  options: RemoveOptions = {},
): { exitCode: 0 | 1; report: RemoveReport } {
  const io = options.io ?? consoleIo;
  assertAssetExists(kind, name);

  const target = sourceAssetPath(kind, name);

  if (options.yes !== true) {
    io.out("The following source assets would be removed:");
    io.out(`  ${kind} ${name} — ${target}`);
    io.out();
    io.err("Refusing to remove without confirmation. Re-run with `--yes`. Nothing was written.");
    return { exitCode: 1, report: { removed: [] } };
  }

  const backupRoot = backupDir(options.now ?? new Date());
  backupPath(target, backupRoot);

  switch (kind) {
    case "skill":
    case "agent":
    // SPEC §10.2: a command is a single file under `~/.agents-manager/commands/`,
    // so removing it is the same one-path operation as removing an agent.
    case "command":
      removePath(target);
      break;
    case "mcp": {
      // A server is a key inside a shared document, so removal is a rewrite of
      // the whole file — through `writeSourceServers`, which re-validates every
      // remaining entry before the atomic replace (SPEC §6.3/§6.4).
      const servers = readSourceServers();
      delete servers[name];
      writeSourceServers(servers);
      break;
    }
  }

  io.out(`  removed  ${kind} ${name} — ${target}`);
  io.out(`Backups: ${backupRoot}`);
  return {
    exitCode: 0,
    report: { removed: [{ assetType: kind, asset: name, path: target }], backupDir: backupRoot },
  };
}

/** True when the source asset path still exists — used by tests and doctor. */
export function sourceAssetExists(kind: AssetKindId, name: string): boolean {
  if (kind === "mcp") return name in readSourceServers();
  return inspectPath(sourceAssetPath(kind, name)).exists;
}
