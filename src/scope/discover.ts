/**
 * Project discovery (ARCHITECTURE.md「プロジェクトの発見」, design §5).
 *
 * Collects the folders Claude Code and Copilot have recorded working in, and
 * narrows them to repository roots a person would recognise as projects:
 *
 *  1. Claude: the **keys** of `projects` in `~/.claude.json` and the paths in
 *     `githubRepoPaths`. Nothing else in that file is kept — it also holds
 *     account information (`oauthAccount` and friends), so the parsed document
 *     is dropped as soon as the two keys are copied out.
 *  2. Copilot: `cwd` / `gitRoot` from the first line of each
 *     `session-state/<id>/events.jsonl` (`workspace.yaml` when there is no
 *     events file). The first line never changes once written, so it is cached
 *     per session id; only the mtime (last use) is re-read.
 *  3. Folders added by hand in the console (`~/.agent-console/projects.json`).
 *
 * Then, in order: drop paths that no longer exist, drop the excluded places
 * (home, temp, the harnesses' own directories, Windows), resolve each to its
 * repository root (gitroot.ts), and fold linked worktrees into their main
 * checkout. Folders outside git stay in the result, marked, for the console to
 * hide by default.
 *
 * This module writes only under `~/.agent-console/` (the cache and, through
 * `updateProjectSettings`, the settings file). It never writes a harness file.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { ensureDir, writeJsonAtomic } from "../core/fsops.js";
import { AmError } from "../core/model.js";
import {
  claudeHome,
  claudeJsonPath,
  claudeTranscriptsDir,
  copilotHome,
  copilotSessionStateDir,
  homeDir,
  projectsCachePath,
  projectsSettingsPath,
  systemRootDir,
  tempDirs,
} from "../core/paths.js";
import { findRepo } from "./gitroot.js";

export type ProjectSource = "claude" | "copilot" | "manual";

export interface ProjectEntry {
  /** Short stable id: the first 12 hex digits of sha256 of the normalized root. */
  id: string;
  root: string;
  name: string;
  sources: ProjectSource[];
  /** Newest use recorded by either harness, ISO8601. Absent when neither recorded one. */
  lastUsed?: string;
  /** Linked worktrees of this repository that were folded into it. */
  worktrees: number;
  /** False for a folder outside any git repository. */
  git: boolean;
  pinned?: true;
  hidden?: true;
}

export interface SourceStatus {
  /** What was read, as a short label (`claude.json#projects` …). */
  label: string;
  path: string;
  status: "ok" | "missing" | "unreadable";
  detail?: string;
  /** Records taken from it (folders), when it was read. */
  records?: number;
}

export interface DiscoveryCounts {
  /** Distinct folders the records named. */
  candidates: number;
  missing: number;
  excluded: number;
  /** Listed but outside git. */
  nonGit: number;
  hidden: number;
  /** Worktree folders folded into their main checkout. */
  worktreesMerged: number;
  /** Projects in the result (including hidden and non-git ones). */
  listed: number;
}

export interface ProjectsJson {
  projects: ProjectEntry[];
  counts: DiscoveryCounts;
  sources: SourceStatus[];
  /** `hit`: every Copilot session came from the cache. `partial`: some were new. `miss`: none were cached. */
  cache: "hit" | "partial" | "miss";
  elapsedMs: number;
  /** Set when `projects.json` could not be read; pins and hides are then not applied. */
  settingsError?: string;
}

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

const caseInsensitive = process.platform === "win32";

/** Absolute, resolved, without a trailing separator; drive letter upper-cased on Windows. */
export function normalizeRoot(p: string): string {
  let r = path.resolve(p);
  if (r.length > 3 && (r.endsWith("\\") || r.endsWith("/"))) r = r.slice(0, -1);
  if (/^[a-z]:/.test(r)) r = r[0]!.toUpperCase() + r.slice(1);
  return r;
}

function keyOf(p: string): string {
  const r = normalizeRoot(p);
  return caseInsensitive ? r.toLowerCase() : r;
}

/** The id the console and the API use for a project root. */
export function projectId(root: string): string {
  return createHash("sha256").update(keyOf(root)).digest("hex").slice(0, 12);
}

function isUnder(child: string, parent: string): boolean {
  const c = keyOf(child);
  const p = keyOf(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** Why a folder is never offered as a project, or `null`. */
export function exclusionReason(p: string): string | null {
  if (keyOf(p) === keyOf(homeDir())) return "home";
  for (const t of tempDirs()) if (isUnder(p, t)) return "temp";
  if (isUnder(p, copilotHome())) return "copilot-home";
  if (isUnder(p, claudeHome())) return "claude-home";
  const sys = systemRootDir();
  if (sys !== null && isUnder(p, sys)) return "windows";
  return null;
}

/* ------------------------------------------------------------------ */
/* Settings: ~/.agent-console/projects.json                            */
/* ------------------------------------------------------------------ */

export interface ProjectSettings {
  version: 1;
  pinned: string[];
  hidden: string[];
  added: string[];
}

function emptySettings(): ProjectSettings {
  return { version: 1, pinned: [], hidden: [], added: [] };
}

/**
 * Read the settings file. A missing file is "no settings"; a file that is
 * there but malformed is an error (SPEC §6.3) — never silently treated as empty,
 * because the next write would then erase the owner's pins.
 */
export function readProjectSettings(): ProjectSettings {
  const file = projectsSettingsPath();
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptySettings();
    throw new AmError(`Failed to read ${file}`, { path: file, cause: err });
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text.replace(/^﻿/, ""));
  } catch (err) {
    throw new AmError(`Failed to parse ${file} (${(err as Error).message})`, { path: file });
  }
  const o = doc as Partial<ProjectSettings> | null;
  const list = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
  if (
    o === null ||
    typeof o !== "object" ||
    o.version !== 1 ||
    !list(o.pinned ?? []) ||
    !list(o.hidden ?? []) ||
    !list(o.added ?? [])
  ) {
    throw new AmError(`${file} is not a version 1 projects file`, { path: file });
  }
  return { version: 1, pinned: o.pinned ?? [], hidden: o.hidden ?? [], added: o.added ?? [] };
}

export type ProjectAction = "pin" | "unpin" | "hide" | "unhide" | "add" | "forget";
export const PROJECT_ACTIONS: readonly ProjectAction[] = ["pin", "unpin", "hide", "unhide", "add", "forget"];

/**
 * Change one setting. `target` is a project id for every action but `add`,
 * which takes a folder path. Returns the root the action applied to.
 */
export function updateProjectSettings(action: ProjectAction, target: string): string {
  const settings = readProjectSettings();
  let root: string;
  if (action === "add") {
    if (!path.isAbsolute(target)) throw new AmError(`Not an absolute path: ${target}`);
    root = normalizeRoot(target);
    let st: fs.Stats;
    try {
      st = fs.statSync(root);
    } catch {
      throw new AmError(`No such folder: ${root}`, { path: root });
    }
    if (!st.isDirectory()) throw new AmError(`Not a folder: ${root}`, { path: root });
  } else {
    // An id the cache does not know yet (a first run, or a project that just
    // appeared) gets one fresh discovery before it is refused.
    const found = resolveProjectId(target, settings) ?? (discoverProjects(), resolveProjectId(target, settings));
    if (found === null) throw new AmError(`Unknown project id: ${target}`);
    root = found;
  }
  const k = keyOf(root);
  const without = (xs: string[]): string[] => xs.filter((x) => keyOf(x) !== k);
  switch (action) {
    case "pin":
      settings.pinned = [...without(settings.pinned), root];
      break;
    case "unpin":
      settings.pinned = without(settings.pinned);
      break;
    case "hide":
      settings.hidden = [...without(settings.hidden), root];
      break;
    case "unhide":
      settings.hidden = without(settings.hidden);
      break;
    case "add":
      settings.added = [...without(settings.added), root];
      settings.hidden = without(settings.hidden);
      break;
    case "forget":
      settings.added = without(settings.added);
      settings.pinned = without(settings.pinned);
      break;
  }
  ensureDir(path.dirname(projectsSettingsPath()));
  writeJsonAtomic(projectsSettingsPath(), settings);
  return root;
}

/**
 * Turn an id back into a root, from the last discovery (the cache) or the
 * settings file. The API never receives a path for anything but `add`, so the
 * engine only ever reads projects it discovered or was told about.
 */
export function resolveProjectId(id: string, settings?: ProjectSettings): string | null {
  const s = settings ?? safeSettings();
  for (const r of [...s.added, ...s.pinned, ...s.hidden]) if (projectId(r) === id) return normalizeRoot(r);
  const cache = readCache();
  for (const r of cache.roots ?? []) if (projectId(r) === id) return normalizeRoot(r);
  return null;
}

function safeSettings(): ProjectSettings {
  try {
    return readProjectSettings();
  } catch {
    return emptySettings();
  }
}

/* ------------------------------------------------------------------ */
/* Cache: ~/.agent-console/cache/projects.json                         */
/* ------------------------------------------------------------------ */

interface CopilotSessionRecord {
  cwd?: string;
  gitRoot?: string;
}

interface DiscoveryCache {
  version: 1;
  copilot: Record<string, CopilotSessionRecord>;
  /** Roots of the last result, so an id can be resolved without rediscovering. */
  roots?: string[];
}

function readCache(): DiscoveryCache {
  try {
    const doc = JSON.parse(fs.readFileSync(projectsCachePath(), "utf8")) as DiscoveryCache;
    if (doc !== null && typeof doc === "object" && doc.version === 1 && typeof doc.copilot === "object") {
      return doc;
    }
  } catch {
    /* a cache is only ever a shortcut: anything wrong with it means "start over" */
  }
  return { version: 1, copilot: {} };
}

function writeCache(cache: DiscoveryCache): void {
  try {
    ensureDir(path.dirname(projectsCachePath()));
    writeJsonAtomic(projectsCachePath(), cache);
  } catch {
    /* failing to save a cache costs speed next time, nothing else */
  }
}

/* ------------------------------------------------------------------ */
/* Readers                                                             */
/* ------------------------------------------------------------------ */

interface Candidate {
  path: string;
  source: ProjectSource;
  lastUsedMs?: number;
}

/**
 * The two keys discovery needs from `~/.claude.json`. The document is parsed
 * and then dropped; only folder paths leave this function.
 */
function readClaudeRecords(statuses: SourceStatus[]): Candidate[] {
  const file = claudeJsonPath();
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    statuses.push({
      label: "claude.json#projects",
      path: file,
      status: missing ? "missing" : "unreadable",
      ...(missing ? {} : { detail: (err as Error).message }),
    });
    return [];
  }
  let projects: string[] = [];
  let repoPaths: string[] = [];
  try {
    const doc = JSON.parse(text.replace(/^﻿/, "")) as Record<string, unknown>;
    const p = doc["projects"];
    if (p !== null && typeof p === "object" && !Array.isArray(p)) projects = Object.keys(p);
    const g = doc["githubRepoPaths"];
    if (g !== null && typeof g === "object" && !Array.isArray(g)) {
      for (const v of Object.values(g)) {
        if (Array.isArray(v)) {
          for (const x of v) if (typeof x === "string") repoPaths.push(x);
        } else if (typeof v === "string") {
          repoPaths.push(v);
        }
      }
    }
  } catch (err) {
    statuses.push({
      label: "claude.json#projects",
      path: file,
      status: "unreadable",
      detail: `JSON: ${(err as Error).message}`,
    });
    return [];
  }
  statuses.push({ label: "claude.json#projects", path: file, status: "ok", records: projects.length });
  statuses.push({ label: "claude.json#githubRepoPaths", path: file, status: "ok", records: repoPaths.length });
  return [
    ...projects.map((p) => ({ path: p, source: "claude" as const })),
    ...repoPaths.map((p) => ({ path: p, source: "claude" as const })),
  ];
}

/**
 * Last use per Claude project, from the transcript directory names.
 *
 * Claude names a project's transcript directory after its path with every
 * character that is not a letter or digit replaced by `-`. The mapping is
 * lossy, so it is only used to look a known path up, never to recover one.
 */
function readClaudeLastUsed(statuses: SourceStatus[]): Map<string, number> {
  const dir = claudeTranscriptsDir();
  const out = new Map<string, number>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    statuses.push({ label: "claude transcripts", path: dir, status: missing ? "missing" : "unreadable" });
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sub = path.join(dir, e.name);
    let newest = 0;
    try {
      for (const f of fs.readdirSync(sub, { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
        try {
          newest = Math.max(newest, fs.statSync(path.join(sub, f.name)).mtimeMs);
        } catch {
          /* gone between readdir and stat */
        }
      }
    } catch {
      continue;
    }
    if (newest > 0) out.set(e.name.toLowerCase(), newest);
  }
  statuses.push({ label: "claude transcripts", path: dir, status: "ok", records: out.size });
  return out;
}

export function claudeTranscriptName(p: string): string {
  return normalizeRoot(p).replace(/[^A-Za-z0-9]/g, "-").toLowerCase();
}

const FIRST_LINE_BYTES = 64 * 1024;

function readFirstLine(file: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(FIRST_LINE_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString("utf8");
    const nl = text.indexOf("\n");
    return nl === -1 ? (n < buf.length ? text : null) : text.slice(0, nl);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function parseSessionStart(line: string | null): CopilotSessionRecord {
  if (line === null) return {};
  try {
    const o = JSON.parse(line) as { type?: string; data?: { context?: { cwd?: unknown; gitRoot?: unknown } } };
    const c = o.data?.context;
    const rec: CopilotSessionRecord = {};
    if (typeof c?.cwd === "string" && c.cwd !== "") rec.cwd = c.cwd;
    if (typeof c?.gitRoot === "string" && c.gitRoot !== "") rec.gitRoot = c.gitRoot;
    return rec;
  } catch {
    return {};
  }
}

/** `cwd:` and `git_root:` lines of a `workspace.yaml`; every other line is ignored. */
function parseWorkspaceYaml(file: string): CopilotSessionRecord {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const rec: CopilotSessionRecord = {};
  const value = (key: string): string | undefined => {
    const m = new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, "m").exec(text);
    if (m === null || m[1] === undefined) return undefined;
    const v = m[1].replace(/^(['"])(.*)\1$/, "$2");
    return v === "" ? undefined : v;
  };
  const cwd = value("cwd");
  const root = value("git_root");
  if (cwd !== undefined) rec.cwd = cwd;
  if (root !== undefined) rec.gitRoot = root;
  return rec;
}

function readCopilotRecords(
  cache: DiscoveryCache,
  statuses: SourceStatus[],
  refresh: boolean,
): { candidates: Candidate[]; fresh: number; cached: number; changed: boolean } {
  const dir = copilotSessionStateDir();
  const result = { candidates: [] as Candidate[], fresh: 0, cached: 0, changed: false };
  let ids: string[];
  try {
    ids = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    statuses.push({ label: "copilot session-state", path: dir, status: missing ? "missing" : "unreadable" });
    return result;
  }
  const next: Record<string, CopilotSessionRecord> = {};
  let withCwd = 0;
  for (const id of ids) {
    const sessionDir = path.join(dir, id);
    const events = path.join(sessionDir, "events.jsonl");
    const workspace = path.join(sessionDir, "workspace.yaml");
    let mtime: number | undefined;
    let hasEvents = false;
    try {
      mtime = fs.statSync(events).mtimeMs;
      hasEvents = true;
    } catch {
      try {
        mtime = fs.statSync(workspace).mtimeMs;
      } catch {
        mtime = undefined;
      }
    }
    let rec = refresh ? undefined : cache.copilot[id];
    if (rec === undefined) {
      rec = hasEvents ? parseSessionStart(readFirstLine(events)) : {};
      if (rec.cwd === undefined) rec = { ...parseWorkspaceYaml(workspace), ...rec };
      result.fresh++;
      result.changed = true;
    } else {
      result.cached++;
    }
    next[id] = rec;
    const where = rec.gitRoot ?? rec.cwd;
    if (where !== undefined) {
      withCwd++;
      result.candidates.push({ path: where, source: "copilot", ...(mtime !== undefined ? { lastUsedMs: mtime } : {}) });
    }
  }
  if (Object.keys(cache.copilot).some((id) => !(id in next))) result.changed = true;
  cache.copilot = next;
  statuses.push({ label: "copilot session-state", path: dir, status: "ok", records: withCwd });
  return result;
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

export interface DiscoverOptions {
  /** Ignore the cache and read every session again. */
  refresh?: boolean;
}

export function discoverProjects(options: DiscoverOptions = {}): ProjectsJson {
  const started = Date.now();
  const statuses: SourceStatus[] = [];
  let settings: ProjectSettings;
  let settingsError: string | undefined;
  try {
    settings = readProjectSettings();
  } catch (err) {
    settings = emptySettings();
    settingsError = (err as Error).message;
  }

  const cache = readCache();
  const claude = readClaudeRecords(statuses);
  const claudeLastUsed = readClaudeLastUsed(statuses);
  const copilot = readCopilotRecords(cache, statuses, options.refresh === true);
  const manual: Candidate[] = settings.added.map((p) => ({ path: p, source: "manual" }));

  // 1. Distinct folders, with every source that named them and their newest use.
  const folders = new Map<string, { path: string; sources: Set<ProjectSource>; lastUsedMs: number }>();
  for (const c of [...claude, ...copilot.candidates, ...manual]) {
    if (typeof c.path !== "string" || c.path.trim() === "" || !path.isAbsolute(c.path)) continue;
    const k = keyOf(c.path);
    let f = folders.get(k);
    if (f === undefined) {
      f = { path: normalizeRoot(c.path), sources: new Set(), lastUsedMs: 0 };
      folders.set(k, f);
    }
    f.sources.add(c.source);
    let used = c.lastUsedMs ?? 0;
    if (c.source === "claude") used = Math.max(used, claudeLastUsed.get(claudeTranscriptName(c.path)) ?? 0);
    f.lastUsedMs = Math.max(f.lastUsedMs, used);
  }

  const counts: DiscoveryCounts = {
    candidates: folders.size,
    missing: 0,
    excluded: 0,
    nonGit: 0,
    hidden: 0,
    worktreesMerged: 0,
    listed: 0,
  };

  // 2-4. Exists → not excluded → repository root → worktrees folded.
  const projects = new Map<string, ProjectEntry & { lastUsedMs: number; worktreeRoots: Set<string> }>();
  for (const f of folders.values()) {
    if (exclusionReason(f.path) !== null) {
      counts.excluded++;
      continue;
    }
    let isDir = false;
    try {
      isDir = fs.statSync(f.path).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      counts.missing++;
      continue;
    }
    const repo = findRepo(f.path);
    const root = repo?.mainRoot ?? f.path;
    if (repo !== null && exclusionReason(root) !== null) {
      counts.excluded++;
      continue;
    }
    const k = keyOf(root);
    let p = projects.get(k);
    if (p === undefined) {
      p = {
        id: projectId(root),
        root: normalizeRoot(root),
        name: path.basename(root) || root,
        sources: [],
        worktrees: 0,
        git: repo !== null,
        lastUsedMs: 0,
        worktreeRoots: new Set(),
      };
      projects.set(k, p);
    }
    for (const s of f.sources) if (!p.sources.includes(s)) p.sources.push(s);
    p.lastUsedMs = Math.max(p.lastUsedMs, f.lastUsedMs);
    if (repo?.isWorktree === true) p.worktreeRoots.add(keyOf(repo.root));
  }

  const pinned = new Set(settings.pinned.map(keyOf));
  const hidden = new Set(settings.hidden.map(keyOf));
  const order: ProjectSource[] = ["claude", "copilot", "manual"];
  const list: ProjectEntry[] = [...projects.values()]
    .map((p) => {
      const k = keyOf(p.root);
      const entry: ProjectEntry = {
        id: p.id,
        root: p.root,
        name: p.name,
        sources: order.filter((s) => p.sources.includes(s)),
        worktrees: p.worktreeRoots.size,
        git: p.git,
      };
      if (p.lastUsedMs > 0) entry.lastUsed = new Date(p.lastUsedMs).toISOString();
      if (pinned.has(k)) entry.pinned = true;
      if (hidden.has(k)) entry.hidden = true;
      counts.worktreesMerged += p.worktreeRoots.size;
      if (!p.git) counts.nonGit++;
      if (entry.hidden === true) counts.hidden++;
      return entry;
    })
    .sort((a, b) => {
      if ((a.pinned === true) !== (b.pinned === true)) return a.pinned === true ? -1 : 1;
      const la = a.lastUsed ?? "";
      const lb = b.lastUsed ?? "";
      if (la !== lb) return la < lb ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  counts.listed = list.length;

  const roots = list.map((p) => p.root);
  const rootsChanged = JSON.stringify(roots) !== JSON.stringify(cache.roots ?? []);
  if (copilot.changed || rootsChanged) writeCache({ ...cache, roots });

  const result: ProjectsJson = {
    projects: list,
    counts,
    sources: statuses,
    cache: copilot.fresh === 0 ? "hit" : copilot.cached === 0 ? "miss" : "partial",
    elapsedMs: Date.now() - started,
  };
  if (settingsError !== undefined) result.settingsError = settingsError;
  return result;
}
