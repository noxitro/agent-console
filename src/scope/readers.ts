/**
 * Small read-only helpers for the scope layer.
 *
 * Every reader here returns what it found **and** how the read went
 * (`SourceRecorder`), so a missing directory, an unreadable file and an empty
 * one stay three different things on the screen (SPEC §9.7).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { parse as parseJsonc, type ParseError } from "jsonc-parser";

import { parseFrontmatter } from "../core/frontmatter.js";

export interface ReadSource {
  path: string;
  status: "ok" | "missing" | "unreadable";
  detail?: string;
}

export class SourceRecorder {
  readonly list: ReadSource[] = [];
  private readonly seen = new Set<string>();

  record(p: string, status: ReadSource["status"], detail?: string): void {
    const key = `${p}\0${status}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push(detail === undefined ? { path: p, status } : { path: p, status, detail });
  }
}

/** Text of a file, BOM stripped and line endings normalized; `null` when absent. */
export function readText(file: string, rec: SourceRecorder): string | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    rec.record(file, "ok");
    return raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      rec.record(file, "missing");
      return null;
    }
    rec.record(file, "unreadable", (err as Error).message);
    throw new ReadFailure(file, (err as Error).message);
  }
}

export class ReadFailure extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`${file}: ${detail}`);
    this.name = "ReadFailure";
  }
}

/**
 * A JSON / JSONC document, reduced to the listed top-level keys. The rest of
 * the document is never returned (settings files hold `env` and hooks with
 * secrets in them; `~/.claude.json` holds account data).
 */
export function readKeys(
  file: string,
  keys: readonly string[],
  rec: SourceRecorder,
): { status: "ok"; values: Record<string, unknown> } | { status: "missing" } | { status: "unreadable"; detail: string } {
  let text: string | null;
  try {
    text = readText(file, rec);
  } catch (err) {
    return { status: "unreadable", detail: (err as Error).message };
  }
  if (text === null) return { status: "missing" };
  const errors: ParseError[] = [];
  const doc = parseJsonc(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0 || doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    const detail = errors.length > 0 ? `JSON の構文エラー(${errors.length} 件)` : "オブジェクトではない";
    rec.record(file, "unreadable", detail);
    return { status: "unreadable", detail };
  }
  const values: Record<string, unknown> = {};
  for (const k of keys) {
    const v = (doc as Record<string, unknown>)[k];
    if (v !== undefined) values[k] = v;
  }
  return { status: "ok", values };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Directory entries; `[]` when the directory is absent, recorded either way. */
export function listDir(dir: string, rec: SourceRecorder): fs.Dirent[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    rec.record(dir, "ok");
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      rec.record(dir, "missing");
      return [];
    }
    rec.record(dir, "unreadable", (err as Error).message);
    return [];
  }
}

/** Does this entry lead to a directory (a real one, a junction, or a link to one)? */
export function isDirEntry(dir: string, e: fs.Dirent): boolean {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(dir, e.name)).isDirectory();
  } catch {
    return false;
  }
}

export function isFileEntry(dir: string, e: fs.Dirent): boolean {
  if (e.isFile()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(dir, e.name)).isFile();
  } catch {
    return false;
  }
}

/** Files under `dir` (recursively, at most `depth` levels) whose names end in `suffix`. */
export function walkFiles(dir: string, suffix: string, rec: SourceRecorder, depth = 4): string[] {
  const out: string[] = [];
  const visit = (d: string, left: number): void => {
    for (const e of listDir(d, rec)) {
      const full = path.join(d, e.name);
      if (isFileEntry(d, e) && e.name.endsWith(suffix)) out.push(full);
      else if (left > 0 && isDirEntry(d, e)) visit(full, left - 1);
    }
  };
  visit(dir, depth);
  return out;
}

/** The real location of `p` when a link leads elsewhere; `undefined` when it is itself. */
export function realPathIfDifferent(p: string): string | undefined {
  try {
    const real = fs.realpathSync.native(p);
    return path.resolve(real).toLowerCase() === path.resolve(p).toLowerCase() ? undefined : real;
  } catch {
    return undefined;
  }
}

export function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

export interface MarkdownMeta {
  data: Record<string, unknown>;
  body: string;
  text: string;
}

/** A Markdown file with its frontmatter; throws `ReadFailure` when the YAML is broken. */
export function readMarkdown(file: string, rec: SourceRecorder): MarkdownMeta | null {
  const text = readText(file, rec);
  if (text === null) return null;
  try {
    const fm = parseFrontmatter(text, file);
    return { data: fm.data, body: fm.body, text };
  } catch (err) {
    rec.record(file, "unreadable", "frontmatter の YAML が読めない");
    throw new ReadFailure(file, (err as Error).message);
  }
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/**
 * `@path` imports in an instruction file, resolved and followed up to `maxHops`
 * (Claude: four hops, official memory docs). Fenced code blocks and inline code
 * are skipped. Only files that exist are returned; a cycle stops at the first
 * repeat.
 */
export function resolveImports(
  file: string,
  text: string,
  home: string,
  rec: SourceRecorder,
  maxHops = 4,
): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const seen = new Set<string>([path.resolve(file).toLowerCase()]);
  const visit = (from: string, body: string, hop: number): void => {
    if (hop > maxHops) return;
    for (const ref of importRefs(body)) {
      const target = ref.startsWith("~/") || ref.startsWith("~\\")
        ? path.join(home, ref.slice(2))
        : path.resolve(path.dirname(from), ref);
      const key = target.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      let t: string | null;
      try {
        t = readText(target, rec);
      } catch {
        continue;
      }
      if (t === null) continue;
      out.push({ path: target, text: t });
      visit(target, t, hop + 1);
    }
  };
  visit(file, text, 1);
  return out;
}

export function importRefs(body: string): string[] {
  const refs: string[] = [];
  let fenced = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const plain = line.replace(/`[^`]*`/g, "");
    for (const m of plain.matchAll(/(?:^|\s)@((?:~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\/)?[^\s@`]*[^\s@`.,;:)\]])/g)) {
      const ref = m[1];
      if (ref === undefined) continue;
      // An import names a file: it has an extension or a separator. A bare
      // `@someone` mention in prose is not one.
      if (!/[\\/]/.test(ref) && !/\.[A-Za-z0-9]+$/.test(ref)) continue;
      refs.push(ref);
    }
  }
  return refs;
}
