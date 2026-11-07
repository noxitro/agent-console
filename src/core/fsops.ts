/**
 * File-system primitives: atomic writes, backups, junctions, directory hashing.
 *
 * SPEC §6.3: JSON parse failures are never treated as empty data — they throw.
 * SPEC §6.4: every write is temp-file → `fs.rename`, UTF-8 without BOM, LF.
 * SPEC §6.6: junctions via `fs.symlinkSync(target, path, "junction")` with a
 *            copy fallback that must be reported.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { AmError } from "./model.js";
import { relativeToHome, homeDir } from "./paths.js";

/* ------------------------------------------------------------------ */
/* Text normalization                                                  */
/* ------------------------------------------------------------------ */

const BOM = "﻿";

/** Strip a leading UTF-8 BOM and normalize CRLF/CR line endings to LF. */
export function normalizeText(text: string): string {
  const withoutBom = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  return withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export function pathExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/** Read a UTF-8 text file, normalized. Returns `null` when it does not exist. */
export function readTextFile(target: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw new AmError(`Failed to read file: ${target}`, { path: target, cause: err });
  }
  return normalizeText(raw);
}

/**
 * Read and parse a JSON file.
 *
 * SPEC §6.3: a parse failure is a hard error — it must never be swallowed into
 * "empty data", because that would let `apply` overwrite a corrupt-but-real
 * config with a fabricated empty one. Missing files return `null`, which is a
 * genuinely different condition from "present but unparseable".
 */
export function readJsonFile<T = unknown>(target: string): T | null {
  const text = readTextFile(target);
  if (text === null) return null;
  if (text.trim() === "") {
    throw new AmError(`JSON file is empty: ${target}`, { path: target });
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new AmError(
      `Failed to parse JSON: ${target} (${(err as Error).message})`,
      { path: target, cause: err },
    );
  }
}

/** List immediate subdirectory names (including links to directories), sorted. */
export function listDirNames(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return [];
    throw new AmError(`Failed to read directory: ${dir}`, { path: dir, cause: err });
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      names.push(entry.name);
    } else if (entry.isSymbolicLink()) {
      // Junctions/symlinks report as symbolic links; keep them if they point
      // at a directory (or are broken — the caller classifies that).
      const full = path.join(dir, entry.name);
      try {
        if (fs.statSync(full).isDirectory()) names.push(entry.name);
      } catch {
        names.push(entry.name);
      }
    }
  }
  return names.sort();
}

/** List immediate file names matching `suffix`, sorted. */
export function listFiles(dir: string, suffix?: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return [];
    throw new AmError(`Failed to read directory: ${dir}`, { path: dir, cause: err });
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => suffix === undefined || n.endsWith(suffix))
    .sort();
}

/* ------------------------------------------------------------------ */
/* Writes (atomic)                                                     */
/* ------------------------------------------------------------------ */

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Atomically write a text file: write to a sibling temp file, fsync, then
 * `fs.rename` over the destination (SPEC §6.4).
 *
 * Content is normalized to LF and written as UTF-8 without a BOM. The temp
 * file lives in the destination directory so the rename stays on one volume
 * (a cross-volume rename is a copy+delete and loses atomicity).
 */
export function writeFileAtomic(target: string, content: string): void {
  const dir = path.dirname(target);
  ensureDir(dir);
  const normalized = normalizeText(content);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomSuffix()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "wx");
    fs.writeFileSync(fd, normalized, { encoding: "utf8" });
    try {
      fs.fsyncSync(fd);
    } catch {
      // fsync is best-effort; some filesystems/handles reject it.
    }
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, target);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw new AmError(`Failed to write file: ${target}`, { path: target, cause: err });
  }
}

/** Serialize `value` as pretty JSON (2 spaces, trailing newline) and write it atomically. */
export function writeJsonAtomic(target: string, value: unknown): void {
  writeFileAtomic(target, serializeJson(value));
}

/** Canonical JSON serialization used for every JSON file this tool owns. */
export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/* ------------------------------------------------------------------ */
/* Path inspection                                                     */
/* ------------------------------------------------------------------ */

export interface PathInfo {
  path: string;
  exists: boolean;
  /** True for junctions and symlinks alike (Windows junctions report as symlinks). */
  isLink: boolean;
  isDirectory: boolean;
  isFile: boolean;
  /** Raw link destination when `isLink`. */
  linkTarget: string | undefined;
  /** True when the path is a link whose destination does not resolve. */
  isBroken: boolean;
  /**
   * Why the path could not be classified, when `lstat` failed for a reason that
   * is **not** "there is nothing here".
   *
   * `exists` stays `false` alongside it, because we genuinely cannot say that it
   * does — every write path already treats "cannot confirm" as "do not touch",
   * and that is the safe reading. What `exists: false` must not do on its own is
   * let a *display* path assert 「無い」. That is a claim about the machine, and
   * an item whose ACL denies us a `stat` is one we did not measure.
   */
  unreadable: string | undefined;
}

/**
 * Which `lstat` failures mean 「そこには何も無い」.
 *
 * ENOENT is the plain answer; ENOTDIR means a component of the path is a file,
 * so nothing can exist below it. Everything else — EACCES and EPERM above all —
 * means the entry may be sitting there in perfect health while the process is
 * not allowed to look, and reporting that as absence is the same fabrication as
 * a 「一致」 badge with no plan behind it.
 *
 * Exported so the rule can be tested directly: producing a real EACCES needs an
 * ACL the test host may not grant, and the decision is worth pinning either way.
 */
export function isAbsentError(err: unknown): boolean {
  return isEnoent(err);
}

/** The reason string a caller may show, for a failure that is not absence. */
export function statErrorReason(err: unknown): string {
  const e = err as NodeJS.ErrnoException | undefined;
  const code = e?.code;
  const message = e?.message ?? String(err);
  return code === undefined ? message : `${code}: ${message}`;
}

/** Classify a path without following links at the top level. */
export function inspectPath(target: string): PathInfo {
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(target);
  } catch (err) {
    return {
      path: target,
      exists: false,
      isLink: false,
      isDirectory: false,
      isFile: false,
      linkTarget: undefined,
      isBroken: false,
      unreadable: isAbsentError(err) ? undefined : statErrorReason(err),
    };
  }

  if (lstat.isSymbolicLink()) {
    let linkTarget: string | undefined;
    try {
      linkTarget = fs.readlinkSync(target);
    } catch {
      linkTarget = undefined;
    }
    let isDirectory = false;
    let isFile = false;
    let broken = false;
    try {
      const st = fs.statSync(target);
      isDirectory = st.isDirectory();
      isFile = st.isFile();
    } catch {
      broken = true;
    }
    return {
      path: target,
      exists: true,
      isLink: true,
      isDirectory,
      isFile,
      linkTarget,
      isBroken: broken,
      unreadable: undefined,
    };
  }

  return {
    path: target,
    exists: true,
    isLink: false,
    isDirectory: lstat.isDirectory(),
    isFile: lstat.isFile(),
    linkTarget: undefined,
    unreadable: undefined,
    isBroken: false,
  };
}

/**
 * Last-modified time of **one file**, as ISO8601, or `undefined` when the path
 * does not exist.
 *
 * SPEC §9.3 requires the console's 「最終更新」 column to come from a single
 * file's mtime rather than from a directory walk: the inventory runs on every
 * window open, under the 30 s read ceiling of SPEC §9.5, and stat-ing a whole
 * skill tree per row is exactly the unbounded work that ceiling exists to keep
 * out. A missing value is left absent so the interface can draw 「—」 instead of
 * inventing a date.
 */
export function modifiedAt(target: string): string | undefined {
  try {
    return fs.statSync(target).mtime.toISOString();
  } catch {
    return undefined;
  }
}

/** Fully resolved destination of a link, or `null` when not a link / unresolvable. */
export function readLinkTarget(target: string): string | null {
  const info = inspectPath(target);
  if (!info.isLink) return null;
  try {
    return fs.realpathSync(target);
  } catch {
    return info.linkTarget ?? null;
  }
}

/* ------------------------------------------------------------------ */
/* Hashing                                                             */
/* ------------------------------------------------------------------ */

/** SHA-256 of a file's raw bytes, hex-encoded. */
export function hashFile(target: string): string {
  const buf = fs.readFileSync(target);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** SHA-256 of a string's UTF-8 bytes, hex-encoded. */
export function hashText(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Directory names never descended into while hashing (SPEC §9.5).
 *
 * A skill is documentation plus small scripts; a `node_modules` or `.git` tree
 * that happens to sit inside one is not part of "内容がソースと同一" in any
 * useful sense, and walking it is what turned a comparison into an unbounded
 * scan. Matched case-insensitively against a directory's own name.
 */
export const HASH_EXCLUDED_DIRS: readonly string[] = [
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "__pycache__",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
];

/** SPEC §9.5: ceiling on the number of files one directory hash may read. */
export const HASH_MAX_FILES = 5_000;

/** SPEC §9.5: ceiling on the total bytes one directory hash may read. */
export const HASH_MAX_BYTES = 64 * 1024 * 1024;

export interface HashLimits {
  maxFiles?: number;
  maxBytes?: number;
  /** Directory names to skip; defaults to {@link HASH_EXCLUDED_DIRS}. */
  exclude?: readonly string[];
}

/** Outcome of hashing a directory tree under the SPEC §9.5 limits. */
export type DirectoryHashResult =
  | { status: "hashed"; hash: string; files: number; bytes: number }
  /** The path does not exist, or is not a directory. */
  | { status: "missing" }
  /** A limit was hit: the tree is **not comparable**, which is not "different". */
  | { status: "over-limit"; reason: string; files: number; bytes: number };

/**
 * Content hash of a directory tree (SPEC §6.6), bounded per SPEC §9.5.
 *
 * Deterministic and path-sensitive: relative POSIX paths are sorted, then each
 * contributes `path\0<sha256 of bytes>\n` to the digest. Two directories hash
 * equal iff they hold the same file names with the same bytes — which is what
 * "内容がソースと同一(ハッシュ一致)" must mean before we replace a real
 * directory with a junction. Symlinks inside the tree are hashed by their
 * destination string rather than followed, so link farms cannot masquerade as
 * physical copies.
 *
 * The walk is bounded because the GUI's read-side sidecar ceiling (30 s) is a
 * promise this function has to be able to keep: `plan` and `doctor` hash every
 * physical skill copy, and a single `copy`-mode skill carrying a dependency
 * tree used to be enough to make the console permanently unusable. Excluded
 * directories are skipped, and a tree that still exceeds the file/byte ceiling
 * comes back as `over-limit` — a reportable "cannot compare", never a silent
 * success and never a silent failure.
 */
export function hashDirectoryDetailed(dir: string, limits: HashLimits = {}): DirectoryHashResult {
  const info = inspectPath(dir);
  if (!info.exists || !info.isDirectory) return { status: "missing" };

  const maxFiles = limits.maxFiles ?? HASH_MAX_FILES;
  const maxBytes = limits.maxBytes ?? HASH_MAX_BYTES;
  const exclude = new Set(
    (limits.exclude ?? HASH_EXCLUDED_DIRS).map((name) => name.toLowerCase()),
  );

  const walk = walkDirectory(dir, { maxFiles, maxBytes, exclude });
  if (walk.overLimit !== undefined) {
    return {
      status: "over-limit",
      reason: walk.overLimit,
      files: walk.files,
      bytes: walk.bytes,
    };
  }

  const hash = crypto.createHash("sha256");
  for (const entry of walk.entries) {
    hash.update(entry.relPath, "utf8");
    hash.update("\0");
    hash.update(entry.digest, "utf8");
    hash.update("\n");
  }
  return { status: "hashed", hash: hash.digest("hex"), files: walk.files, bytes: walk.bytes };
}

/**
 * The digest alone. `null` means "no hash exists for this path" — the directory
 * is missing *or* the tree is over the SPEC §9.5 limits. Callers that have to
 * tell those apart (every caller that reports to a user) use
 * {@link compareDirectories} or {@link hashDirectoryDetailed} instead.
 */
export function hashDirectory(dir: string, limits: HashLimits = {}): string | null {
  const result = hashDirectoryDetailed(dir, limits);
  return result.status === "hashed" ? result.hash : null;
}

interface WalkEntry {
  relPath: string;
  digest: string;
}

interface WalkResult {
  entries: WalkEntry[];
  files: number;
  bytes: number;
  /** Set when a ceiling was hit; the walk stopped there. */
  overLimit?: string;
}

interface WalkBounds {
  maxFiles: number;
  maxBytes: number;
  exclude: ReadonlySet<string>;
}

function walkDirectory(root: string, bounds: WalkBounds): WalkResult {
  const out: WalkEntry[] = [];
  let files = 0;
  let bytes = 0;
  let overLimit: string | undefined;

  const visit = (dir: string, prefix: string): void => {
    if (overLimit !== undefined) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of sorted) {
      if (overLimit !== undefined) return;
      const full = path.join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        let dest = "";
        try {
          dest = fs.readlinkSync(full);
        } catch {
          dest = "";
        }
        out.push({ relPath: rel, digest: `link:${hashText(dest.split(path.sep).join("/"))}` });
      } else if (entry.isDirectory()) {
        // SPEC §9.5: dependency and VCS trees are never descended into.
        if (bounds.exclude.has(entry.name.toLowerCase())) continue;
        visit(full, rel);
      } else if (entry.isFile()) {
        files += 1;
        if (files > bounds.maxFiles) {
          overLimit = `more than ${bounds.maxFiles} files`;
          return;
        }
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          size = 0;
        }
        bytes += size;
        if (bytes > bounds.maxBytes) {
          overLimit = `more than ${bounds.maxBytes} bytes`;
          return;
        }
        out.push({ relPath: rel, digest: hashFile(full) });
      }
    }
  };
  visit(root, "");
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return overLimit === undefined
    ? { entries: out, files, bytes }
    : { entries: out, files, bytes, overLimit };
}

/**
 * Three-valued directory comparison (SPEC §9.5).
 *
 * `incomparable` is the value that must not be collapsed into `different`: the
 * callers turn `different` into a `drift` error *about the user's edits*, and
 * saying that about a tree we simply refused to read would be a lie. A missing
 * directory is reported as `different` — there is nothing to compare, and every
 * caller already treats "not there" as "does not match".
 */
export type DirectoryComparison =
  | { status: "identical" }
  | { status: "different" }
  | { status: "incomparable"; reason: string; path: string };

export function compareDirectories(
  a: string,
  b: string,
  limits: HashLimits = {},
): DirectoryComparison {
  const ha = hashDirectoryDetailed(a, limits);
  if (ha.status === "over-limit") {
    return { status: "incomparable", reason: ha.reason, path: a };
  }
  const hb = hashDirectoryDetailed(b, limits);
  if (hb.status === "over-limit") {
    return { status: "incomparable", reason: hb.reason, path: b };
  }
  if (ha.status === "missing" || hb.status === "missing") return { status: "different" };
  return ha.hash === hb.hash ? { status: "identical" } : { status: "different" };
}

/**
 * True when both directories exist and hash identically.
 *
 * A tree that could not be hashed is **not** identical, but it is not
 * "different" either; anything that reports to a user must call
 * {@link compareDirectories} so the third outcome survives.
 */
export function directoriesIdentical(a: string, b: string, limits: HashLimits = {}): boolean {
  return compareDirectories(a, b, limits).status === "identical";
}

/* ------------------------------------------------------------------ */
/* Copy / remove                                                       */
/* ------------------------------------------------------------------ */

/** Recursively copy a directory tree, dereferencing links. */
export function copyDirectory(src: string, dest: string): void {
  ensureDir(path.dirname(dest));
  fs.cpSync(src, dest, { recursive: true, dereference: true, force: true });
}

/** Remove a file, directory, or link. Links are unlinked, never followed. */
export function removePath(target: string): void {
  const info = inspectPath(target);
  if (!info.exists) return;
  if (info.isLink) {
    // A junction must be removed with rmdir, a file symlink with unlink.
    try {
      fs.unlinkSync(target);
      return;
    } catch {
      fs.rmdirSync(target);
      return;
    }
  }
  fs.rmSync(target, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* Backups (SPEC §2, §5)                                               */
/* ------------------------------------------------------------------ */

/**
 * Map an absolute path to its location inside a backup directory, preserving
 * the original path structure. Paths under HOME keep their relative structure;
 * anything else is stored under `_external/<drive>/...` so absolute paths from
 * other roots (e.g. `%APPDATA%`) cannot escape the backup directory.
 */
export function backupPathFor(target: string, backupRoot: string, root: string = homeDir()): string {
  const rel = relativeToHome(target, root);
  if (rel !== null) return path.join(backupRoot, ...rel.split("/"));
  const parsed = path.parse(path.resolve(target));
  const drive = parsed.root.replace(/[:\\/]/g, "") || "root";
  const tail = path.resolve(target).slice(parsed.root.length);
  return path.join(backupRoot, "_external", drive, tail);
}

/**
 * Copy an existing file or directory into `backupRoot`, preserving its
 * original path structure. Returns the backup path, or `null` when the source
 * does not exist (nothing to preserve). Links are recorded as a `.link.txt`
 * note rather than copied, so restoring never silently materializes a copy
 * where a junction used to be.
 */
export function backupPath(
  target: string,
  backupRoot: string,
  root: string = homeDir(),
): string | null {
  const info = inspectPath(target);
  if (!info.exists) return null;
  const dest = backupPathFor(target, backupRoot, root);
  ensureDir(path.dirname(dest));
  if (info.isLink) {
    const note = `${info.linkTarget ?? ""}\n`;
    writeFileAtomic(`${dest}.link.txt`, note);
    return `${dest}.link.txt`;
  }
  if (info.isDirectory) {
    copyDirectory(target, dest);
    return dest;
  }
  fs.copyFileSync(target, dest);
  return dest;
}

/* ------------------------------------------------------------------ */
/* Junctions (SPEC §6.6)                                               */
/* ------------------------------------------------------------------ */

export type LinkResultMode = "junction" | "copy";

export interface LinkResult {
  mode: LinkResultMode;
  /** True when a junction was attempted and failed, forcing the copy path. */
  fellBack: boolean;
  /** Reason for the fallback; must be surfaced in CLI output (SPEC §6.6). */
  error: string | undefined;
}

/**
 * Create a directory junction at `linkPath` pointing at `sourceDir`.
 *
 * SPEC §6.6: on failure, fall back to a recursive copy and report it. The
 * caller is responsible for having cleared `linkPath` (and for having backed
 * up anything that was there) before calling.
 */
export function createJunction(sourceDir: string, linkPath: string): LinkResult {
  ensureDir(path.dirname(linkPath));
  try {
    fs.symlinkSync(path.resolve(sourceDir), path.resolve(linkPath), "junction");
    return { mode: "junction", fellBack: false, error: undefined };
  } catch (err) {
    copyDirectory(sourceDir, linkPath);
    return { mode: "copy", fellBack: true, error: (err as Error).message };
  }
}

/** Copy `sourceDir` to `linkPath` (used when `linkMode` is `"copy"`). */
export function createCopy(sourceDir: string, linkPath: string): LinkResult {
  copyDirectory(sourceDir, linkPath);
  return { mode: "copy", fellBack: false, error: undefined };
}

/**
 * True when `linkPath` is a link that already resolves to `sourceDir`.
 * Used to recognise an already-correct junction as a no-op.
 */
export function linkPointsTo(linkPath: string, sourceDir: string): boolean {
  const resolved = readLinkTarget(linkPath);
  if (resolved === null) return false;
  let expected = path.resolve(sourceDir);
  try {
    expected = fs.realpathSync(expected);
  } catch {
    /* source may not exist; compare against the literal path */
  }
  return path.resolve(resolved).toLowerCase() === expected.toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

function isEnoent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function randomSuffix(): string {
  return crypto.randomBytes(6).toString("hex");
}
