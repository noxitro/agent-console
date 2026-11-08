/**
 * Project discovery (ARCHITECTURE.md「フェーズとゲート」P2, spike S16).
 *
 * A *project* is a git working tree some harness has recorded as a place it ran
 * in. Three records are read, and from each of them **only the folder**:
 *
 *  - Claude Code: the keys of `projects` in `~/.claude.json`. The file also
 *    holds account and usage state; nothing but the key strings leaves this
 *    function (the per-project `mcpServers` are read by `scopes.ts`, not here).
 *  - Copilot CLI: the `cwd:` line of `~/.copilot/session-state/<id>/workspace.yaml`.
 *    The rest of that file carries the session's name and summary, so the file
 *    is scanned line by line and never parsed as a whole document.
 *  - VS Code: the `folder` URI of `workspaceStorage/<hash>/workspace.json`.
 *
 * `~/.copilot/config.json` (which also lists trusted folders) is deliberately
 * not one of them: SPEC §6.2 forbids reading it.
 *
 * Each recorded folder is kept only when it still exists and sits inside a git
 * working tree; the project is that tree's root. The result is cached in
 * `~/.agent-console/projects-cache.json`, keyed on stamps of the record files,
 * so a second survey re-reads nothing that has not changed (S16: under 1 s
 * with a cache, under 10 s without).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as YAML from "yaml";

import { normalizeText, writeJsonAtomic } from "./fsops.js";
import {
  claudeJsonPath,
  copilotSessionStateDir,
  gitMarkerPath,
  projectsCachePath,
  vscodeWorkspaceStorageDir,
} from "./paths.js";

/** Which harness recorded a folder. */
export type ProjectSource = "claude" | "copilot-cli" | "vscode";

export const PROJECT_SOURCES: readonly ProjectSource[] = ["claude", "copilot-cli", "vscode"];

export interface DiscoveredProject {
  /** The git working tree's root, spelled as the first record spelled it. */
  root: string;
  /** Every harness that recorded a folder inside this tree, in a fixed order. */
  sources: ProjectSource[];
}

/** A record file that exists and could not be read — reported, never treated as empty. */
export interface DiscoveryFault {
  source: ProjectSource;
  path: string;
  message: string;
}

export interface DiscoveryResult {
  projects: DiscoveredProject[];
  /** True when every record was unchanged and the cached answer was used. */
  cached: boolean;
  /** Recorded folders dropped because they no longer exist. */
  missing: number;
  /** Recorded folders dropped because no `.git` was found above them. */
  outsideGit: number;
  faults: DiscoveryFault[];
}

/* ------------------------------------------------------------------ */
/* Reading the records                                                 */
/* ------------------------------------------------------------------ */

interface SourceRead {
  folders: string[];
  /** For directory-shaped records: what each entry recorded, for the cache. */
  entries?: EntryMap;
  fault?: DiscoveryFault;
}

/** The folder keys of `~/.claude.json` `projects`. Nothing else is kept. */
export function readClaudeProjectFolders(): SourceRead {
  const file = claudeJsonPath();
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (isEnoent(err)) return { folders: [] };
    return { folders: [], fault: { source: "claude", path: file, message: reason(err) } };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(normalizeText(text));
  } catch (err) {
    return {
      folders: [],
      fault: { source: "claude", path: file, message: `JSON として読めません (${reason(err)})` },
    };
  }
  const projects = isRecord(doc) ? doc["projects"] : undefined;
  if (!isRecord(projects)) return { folders: [] };
  return { folders: Object.keys(projects) };
}

/**
 * The `cwd:` of every Copilot CLI session.
 *
 * Only a top-level `cwd:` line is looked at; its value goes through the YAML
 * scalar parser alone, so a quoted path is unquoted and nothing else in the
 * file is ever interpreted.
 *
 * `known` is the cache's answer for session directories already read: a
 * session's folder never changes once it is recorded, so only new directories
 * are opened. With two thousand sessions on a working machine, that is the
 * difference between reading two thousand files and reading three.
 */
export function readCopilotSessionFolders(known: EntryMap = {}): SourceRead {
  return readPerEntry("copilot-cli", copilotSessionStateDir(), known, (entryDir) => {
    let text: string;
    try {
      text = fs.readFileSync(path.join(entryDir, "workspace.yaml"), "utf8");
    } catch {
      // A session directory without the file (or a stray file) records nothing.
      return null;
    }
    return cwdLine(text) ?? null;
  });
}

/** The value of a top-level `cwd:` line, or undefined. Exported for tests. */
export function cwdLine(text: string): string | undefined {
  for (const line of normalizeText(text).split("\n")) {
    if (!line.startsWith("cwd:")) continue;
    const raw = line.slice(4).trim();
    if (raw === "") return undefined;
    try {
      const value: unknown = YAML.parse(raw);
      return typeof value === "string" && value !== "" ? value : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The `folder` of every VS Code workspace that is a local folder. */
export function readVscodeWorkspaceFolders(known: EntryMap = {}): SourceRead {
  return readPerEntry("vscode", vscodeWorkspaceStorageDir(), known, (entryDir) => {
    let doc: unknown;
    try {
      doc = JSON.parse(normalizeText(fs.readFileSync(path.join(entryDir, "workspace.json"), "utf8")));
    } catch {
      return null;
    }
    const folder = isRecord(doc) ? doc["folder"] : undefined;
    // Remote folders (`vscode-remote://…`) and multi-root workspaces are not
    // folders on this disk, so they are not projects this tool can read.
    if (typeof folder !== "string" || !folder.startsWith("file:")) return null;
    try {
      return fileURLToPath(folder);
    } catch {
      return null;
    }
  });
}

/** Directory entry name → the folder it recorded (null: it records none). */
export type EntryMap = Record<string, string | null>;

/**
 * Read a record that is a directory of per-session (or per-workspace) entries,
 * opening only the entries `known` does not already answer for.
 */
function readPerEntry(
  source: ProjectSource,
  dir: string,
  known: EntryMap,
  read: (entryDir: string) => string | null,
): SourceRead {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (isEnoent(err)) return { folders: [], entries: {} };
    return { folders: [], fault: { source, path: dir, message: reason(err) } };
  }
  const entries: EntryMap = {};
  for (const name of names) {
    entries[name] = Object.hasOwn(known, name) ? (known[name] ?? null) : read(path.join(dir, name));
  }
  return { folders: Object.values(entries).filter((f): f is string => f !== null), entries };
}

const READERS: Record<ProjectSource, (known: EntryMap) => SourceRead> = {
  claude: () => readClaudeProjectFolders(),
  "copilot-cli": readCopilotSessionFolders,
  vscode: readVscodeWorkspaceFolders,
};

const RECORD_PATHS: Record<ProjectSource, () => string> = {
  claude: claudeJsonPath,
  "copilot-cli": copilotSessionStateDir,
  vscode: vscodeWorkspaceStorageDir,
};

/* ------------------------------------------------------------------ */
/* Narrowing to git working trees                                      */
/* ------------------------------------------------------------------ */

/** Case-folded on Windows, where `E:\Dev` and `e:\dev` are one folder. */
export function folderKey(folder: string): string {
  const resolved = path.resolve(folder);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function exists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The root of the git working tree holding `folder`, or null.
 *
 * Walks upward looking for `.git` (a directory in a clone, a file in a linked
 * worktree or submodule). Nothing is executed: `git` itself is never started.
 */
export function gitRootOf(folder: string): string | null {
  let current = path.resolve(folder);
  for (let depth = 0; depth < 64; depth += 1) {
    if (exists(gitMarkerPath(current))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

const CACHE_VERSION = 1;

interface Stamp {
  mtimeMs: number;
  size: number;
}

interface CacheFile {
  version: number;
  stamps: Partial<Record<ProjectSource, Stamp | null>>;
  /** Raw folders per source, so an unchanged source is not re-read. */
  folders: Partial<Record<ProjectSource, string[]>>;
  /** Per-entry answers for directory-shaped records (see `readPerEntry`). */
  entries: Partial<Record<ProjectSource, EntryMap>>;
}

/**
 * A cheap fingerprint of a record. For a directory of session folders, the
 * entry count stands in for the size: a new session adds an entry.
 */
function stampOf(target: string): Stamp | null {
  try {
    const st = fs.statSync(target);
    if (st.isDirectory()) return { mtimeMs: st.mtimeMs, size: fs.readdirSync(target).length };
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function sameStamp(a: Stamp | null | undefined, b: Stamp | null): boolean {
  if (a === undefined) return false;
  if (a === null || b === null) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function readCache(): CacheFile | null {
  try {
    const doc: unknown = JSON.parse(fs.readFileSync(projectsCachePath(), "utf8"));
    if (!isRecord(doc) || doc["version"] !== CACHE_VERSION) return null;
    if (!isRecord(doc["stamps"]) || !isRecord(doc["folders"]) || !isRecord(doc["entries"])) {
      return null;
    }
    return doc as unknown as CacheFile;
  } catch {
    // An absent or damaged cache is a cold start, never a fault: it is ours,
    // derived, and rebuilt from the records below.
    return null;
  }
}

function writeCache(cache: CacheFile): void {
  try {
    writeJsonAtomic(projectsCachePath(), cache);
  } catch {
    // A cache that cannot be written only costs the next survey its speed.
  }
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

export interface DiscoverOptions {
  /** Read and write `~/.agent-console/projects-cache.json`. Default true. */
  useCache?: boolean;
}

export function discoverProjects(options: DiscoverOptions = {}): DiscoveryResult {
  const useCache = options.useCache ?? true;
  const cache = useCache ? readCache() : null;
  const next: CacheFile = { version: CACHE_VERSION, stamps: {}, folders: {}, entries: {} };
  const faults: DiscoveryFault[] = [];
  let cached = cache !== null;

  const recorded: { folder: string; source: ProjectSource }[] = [];
  for (const source of PROJECT_SOURCES) {
    const stamp = stampOf(RECORD_PATHS[source]());
    const hit = cache !== null && sameStamp(cache.stamps[source], stamp) ? cache.folders[source] : undefined;
    let folders: string[];
    if (hit !== undefined && Array.isArray(hit)) {
      folders = hit;
    } else {
      cached = false;
      const known = cache?.entries[source];
      const read = READERS[source](isRecord(known) ? (known as EntryMap) : {});
      if (read.fault !== undefined) faults.push(read.fault);
      folders = read.folders;
      if (read.entries !== undefined) next.entries[source] = read.entries;
    }
    if (hit !== undefined && cache?.entries[source] !== undefined) {
      next.entries[source] = cache.entries[source];
    }
    // A record that could not be read is not cached: the next survey retries it.
    if (!faults.some((f) => f.source === source)) {
      next.stamps[source] = stamp;
      next.folders[source] = folders;
    }
    for (const folder of folders) recorded.push({ folder, source });
  }

  // One existence check and one git walk per distinct folder, however many
  // sessions recorded it.
  const byFolder = new Map<string, { folder: string; sources: Set<ProjectSource> }>();
  for (const { folder, source } of recorded) {
    const key = folderKey(folder);
    const entry = byFolder.get(key) ?? { folder, sources: new Set<ProjectSource>() };
    entry.sources.add(source);
    byFolder.set(key, entry);
  }

  let missing = 0;
  let outsideGit = 0;
  const byRoot = new Map<string, { root: string; sources: Set<ProjectSource> }>();
  for (const { folder, sources } of byFolder.values()) {
    if (!isDirectory(folder)) {
      missing += 1;
      continue;
    }
    const root = gitRootOf(folder);
    if (root === null) {
      outsideGit += 1;
      continue;
    }
    const key = folderKey(root);
    const entry = byRoot.get(key) ?? { root, sources: new Set<ProjectSource>() };
    for (const source of sources) entry.sources.add(source);
    byRoot.set(key, entry);
  }

  if (useCache) writeCache(next);

  const projects = [...byRoot.values()]
    .map(({ root, sources }) => ({
      root,
      sources: PROJECT_SOURCES.filter((s) => sources.has(s)),
    }))
    .sort((a, b) => folderKey(a.root).localeCompare(folderKey(b.root)));

  return { projects, cached: cached && faults.length === 0, missing, outsideGit, faults };
}

/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function reason(err: unknown): string {
  const e = err as NodeJS.ErrnoException | undefined;
  return e?.code !== undefined ? `${e.code}: ${e.message}` : String(err);
}
