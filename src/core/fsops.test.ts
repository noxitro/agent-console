import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as fsops from "./fsops.js";
import { AmError } from "./model.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-fsops-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function p(...segments: string[]): string {
  return path.join(tmp, ...segments);
}

function writeRaw(target: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

describe("normalizeText", () => {
  it("strips a UTF-8 BOM", () => {
    expect(fsops.normalizeText("﻿hello")).toBe("hello");
  });

  it("normalizes CRLF and lone CR to LF", () => {
    expect(fsops.normalizeText("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
});

describe("writeFileAtomic (SPEC §6.4)", () => {
  it("writes UTF-8 without a BOM and with LF endings", () => {
    const target = p("out", "a.txt");
    fsops.writeFileAtomic(target, "﻿line1\r\nline2\r\n");
    const bytes = fs.readFileSync(target);
    expect(bytes[0]).not.toBe(0xef);
    expect(bytes.toString("utf8")).toBe("line1\nline2\n");
  });

  it("creates missing parent directories", () => {
    const target = p("deep", "nested", "a.txt");
    fsops.writeFileAtomic(target, "x");
    expect(fs.existsSync(target)).toBe(true);
  });

  it("leaves no temp files behind", () => {
    const target = p("a.txt");
    fsops.writeFileAtomic(target, "x");
    expect(fs.readdirSync(tmp).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("replaces existing content wholesale", () => {
    const target = p("a.txt");
    fsops.writeFileAtomic(target, "first");
    fsops.writeFileAtomic(target, "second");
    expect(fs.readFileSync(target, "utf8")).toBe("second");
  });

  it("throws an AmError and cleans up when the destination is a directory", () => {
    const target = p("dir-in-the-way");
    fs.mkdirSync(target);
    expect(() => fsops.writeFileAtomic(target, "x")).toThrow(AmError);
    expect(fs.readdirSync(tmp).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("readJsonFile (SPEC §6.3)", () => {
  it("returns null for a missing file", () => {
    expect(fsops.readJsonFile(p("nope.json"))).toBeNull();
  });

  it("parses valid JSON", () => {
    writeRaw(p("a.json"), '{"a":1}');
    expect(fsops.readJsonFile(p("a.json"))).toEqual({ a: 1 });
  });

  it("throws instead of returning empty data on malformed JSON", () => {
    writeRaw(p("bad.json"), "{ not json ");
    expect(() => fsops.readJsonFile(p("bad.json"))).toThrow(AmError);
    expect(() => fsops.readJsonFile(p("bad.json"))).toThrow(/Failed to parse JSON/);
  });

  it("throws on an empty file rather than treating it as {}", () => {
    writeRaw(p("empty.json"), "   \n");
    expect(() => fsops.readJsonFile(p("empty.json"))).toThrow(AmError);
  });

  it("tolerates a BOM, which some Windows editors add", () => {
    writeRaw(p("bom.json"), "﻿{\"a\":1}");
    expect(fsops.readJsonFile(p("bom.json"))).toEqual({ a: 1 });
  });
});

describe("serializeJson", () => {
  it("uses 2-space indentation and a trailing newline", () => {
    expect(fsops.serializeJson({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });
});

describe("absence is not the same as being refused (SPEC §9.7)", () => {
  /**
   * The rule, tested where it can be tested deterministically.
   *
   * Producing a real EACCES needs an ACL the host may not grant, and the whole
   * point of the distinction is what happens on the machines that do. So the
   * decision is a pure function and this measures it directly: a `lstat` that
   * failed because nothing is there, versus one that failed because we were not
   * allowed to look. Collapsing the second into the first is what drew an
   * ACL-protected skill as 未配布 and had `plan` propose writing over it.
   */
  function errno(code: string): NodeJS.ErrnoException {
    const err = new Error(`${code}: permission denied, lstat`) as NodeJS.ErrnoException;
    err.code = code;
    return err;
  }

  it("counts only ENOENT and ENOTDIR as absence", () => {
    expect(fsops.isAbsentError(errno("ENOENT"))).toBe(true);
    // A file in the middle of the path: nothing can exist below it.
    expect(fsops.isAbsentError(errno("ENOTDIR"))).toBe(true);
  });

  it("refuses to read a permission failure as absence", () => {
    for (const code of ["EACCES", "EPERM", "EIO", "EBUSY", "ELOOP"]) {
      expect(fsops.isAbsentError(errno(code)), code).toBe(false);
    }
  });

  it("keeps the engine's own words for the reason", () => {
    // PRODUCT: 捏造しない — the console prints this verbatim, so it has to carry
    // the code the owner will search for.
    const reason = fsops.statErrorReason(errno("EACCES"));
    expect(reason).toContain("EACCES");
    expect(reason).toContain("permission denied");
  });
});

describe("inspectPath", () => {
  it("reports a missing path", () => {
    const info = fsops.inspectPath(p("nothing"));
    expect(info.exists).toBe(false);
    // Absent, and known to be absent — not the same as unmeasured.
    expect(info.unreadable).toBeUndefined();
  });

  it("leaves `unreadable` unset for everything it could classify", () => {
    writeRaw(p("f.txt"), "x");
    fs.mkdirSync(p("dir"));
    expect(fsops.inspectPath(p("f.txt")).unreadable).toBeUndefined();
    expect(fsops.inspectPath(p("dir")).unreadable).toBeUndefined();
    // A path under a file fails with ENOTDIR, which is still a real absence.
    expect(fsops.inspectPath(p("f.txt", "child")).unreadable).toBeUndefined();
    expect(fsops.inspectPath(p("f.txt", "child")).exists).toBe(false);
  });

  it("distinguishes files from directories", () => {
    writeRaw(p("f.txt"), "x");
    fs.mkdirSync(p("d"));
    expect(fsops.inspectPath(p("f.txt")).isFile).toBe(true);
    expect(fsops.inspectPath(p("d")).isDirectory).toBe(true);
    expect(fsops.inspectPath(p("d")).isLink).toBe(false);
  });
});

describe("hashDirectory (SPEC §6.6)", () => {
  it("returns null for a missing directory", () => {
    expect(fsops.hashDirectory(p("missing"))).toBeNull();
  });

  it("is stable across identical trees regardless of creation order", () => {
    writeRaw(p("a", "one.txt"), "1");
    writeRaw(p("a", "sub", "two.txt"), "2");
    writeRaw(p("b", "sub", "two.txt"), "2");
    writeRaw(p("b", "one.txt"), "1");
    expect(fsops.hashDirectory(p("a"))).toBe(fsops.hashDirectory(p("b")));
    expect(fsops.directoriesIdentical(p("a"), p("b"))).toBe(true);
  });

  it("changes when file content changes", () => {
    writeRaw(p("a", "one.txt"), "1");
    const before = fsops.hashDirectory(p("a"));
    writeRaw(p("a", "one.txt"), "2");
    expect(fsops.hashDirectory(p("a"))).not.toBe(before);
  });

  it("changes when a file is renamed (path is part of the digest)", () => {
    writeRaw(p("a", "one.txt"), "1");
    writeRaw(p("b", "uno.txt"), "1");
    expect(fsops.hashDirectory(p("a"))).not.toBe(fsops.hashDirectory(p("b")));
  });

  it("changes when an extra file is added", () => {
    writeRaw(p("a", "one.txt"), "1");
    writeRaw(p("b", "one.txt"), "1");
    writeRaw(p("b", "extra.txt"), "x");
    expect(fsops.directoriesIdentical(p("a"), p("b"))).toBe(false);
  });

  it("reports false when either side is missing", () => {
    writeRaw(p("a", "one.txt"), "1");
    expect(fsops.directoriesIdentical(p("a"), p("gone"))).toBe(false);
    expect(fsops.directoriesIdentical(p("gone"), p("a"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Bounded hashing (SPEC §9.5)                                         */
/* ------------------------------------------------------------------ */

describe("hashDirectory limits (SPEC §9.5)", () => {
  it("never descends into node_modules, .git or a build output", () => {
    writeRaw(p("a", "SKILL.md"), "s");
    writeRaw(p("b", "SKILL.md"), "s");
    for (const excluded of ["node_modules", ".git", "dist"]) {
      writeRaw(p("b", excluded, "huge.bin"), "x".repeat(1024));
    }
    // The trees differ only inside excluded directories, so they compare equal
    // and — the point of the exclusion — the walk never reads those bytes.
    expect(fsops.compareDirectories(p("a"), p("b")).status).toBe("identical");
    const walked = fsops.hashDirectoryDetailed(p("b"));
    expect(walked.status).toBe("hashed");
    expect(walked.status === "hashed" ? walked.files : -1).toBe(1);
  });

  it("stops at the file-count ceiling and says the tree is over the limit", () => {
    for (let i = 0; i < 5; i += 1) writeRaw(p("a", `f${i}.txt`), "x");
    const result = fsops.hashDirectoryDetailed(p("a"), { maxFiles: 3 });
    expect(result.status).toBe("over-limit");
    expect(result.status === "over-limit" ? result.reason : "").toContain("3 files");
  });

  it("stops at the byte ceiling", () => {
    writeRaw(p("a", "big.bin"), "x".repeat(4096));
    const result = fsops.hashDirectoryDetailed(p("a"), { maxBytes: 1024 });
    expect(result.status).toBe("over-limit");
    expect(result.status === "over-limit" ? result.reason : "").toContain("1024 bytes");
  });

  it("reports an over-limit tree as incomparable, never as different", () => {
    writeRaw(p("a", "one.txt"), "1");
    writeRaw(p("b", "one.txt"), "1");
    const comparison = fsops.compareDirectories(p("a"), p("b"), { maxFiles: 0 });
    // Identical content, but nothing was read: the answer must be neither
    // "identical" (which would let `apply` replace it) nor "different" (which
    // would accuse the user of an edit).
    expect(comparison.status).toBe("incomparable");
    expect(comparison.status === "incomparable" ? comparison.path : "").toBe(p("a"));
    // The boolean shorthand degrades to "not identical", never to "identical".
    expect(fsops.directoriesIdentical(p("a"), p("b"), { maxFiles: 0 })).toBe(false);
  });

  it("keeps a real difference distinguishable from an unreadable tree", () => {
    writeRaw(p("a", "one.txt"), "1");
    writeRaw(p("b", "one.txt"), "2");
    expect(fsops.compareDirectories(p("a"), p("b")).status).toBe("different");
  });

  it("ships ceilings that a documentation-sized skill never reaches", () => {
    expect(fsops.HASH_MAX_FILES).toBeGreaterThan(0);
    expect(fsops.HASH_MAX_BYTES).toBeGreaterThan(0);
    expect(fsops.HASH_EXCLUDED_DIRS).toContain("node_modules");
    expect(fsops.HASH_EXCLUDED_DIRS).toContain(".git");
  });
});

describe("createJunction (SPEC §6.6)", () => {
  it("creates a junction that exposes the source content", () => {
    writeRaw(p("src", "SKILL.md"), "hello");
    const result = fsops.createJunction(p("src"), p("link"));

    // Junction creation can be denied by policy; either outcome is legal, but
    // the fallback must be reported.
    expect(["junction", "copy"]).toContain(result.mode);
    if (result.mode === "copy") {
      expect(result.fellBack).toBe(true);
      expect(result.error).toBeTypeOf("string");
    } else {
      expect(result.fellBack).toBe(false);
      expect(fsops.inspectPath(p("link")).isLink).toBe(true);
      expect(fsops.linkPointsTo(p("link"), p("src"))).toBe(true);
    }
    expect(fs.readFileSync(p("link", "SKILL.md"), "utf8")).toBe("hello");
  });

  it("falls back to a copy when the destination already exists", () => {
    writeRaw(p("src", "SKILL.md"), "hello");
    fs.mkdirSync(p("link"));
    const result = fsops.createJunction(p("src"), p("link"));
    expect(result.mode).toBe("copy");
    expect(result.fellBack).toBe(true);
    expect(result.error).toBeTruthy();
    expect(fs.readFileSync(p("link", "SKILL.md"), "utf8")).toBe("hello");
  });

  it("createCopy makes a physical copy and reports no fallback", () => {
    writeRaw(p("src", "SKILL.md"), "hello");
    const result = fsops.createCopy(p("src"), p("copy"));
    expect(result).toEqual({ mode: "copy", fellBack: false, error: undefined });
    expect(fsops.inspectPath(p("copy")).isLink).toBe(false);
    expect(fsops.directoriesIdentical(p("src"), p("copy"))).toBe(true);
  });

  it("linkPointsTo is false for a plain directory", () => {
    fs.mkdirSync(p("plain"));
    expect(fsops.linkPointsTo(p("plain"), p("plain"))).toBe(false);
  });
});

describe("removePath", () => {
  it("removes a junction without touching the source", () => {
    writeRaw(p("src", "SKILL.md"), "hello");
    const result = fsops.createJunction(p("src"), p("link"));
    fsops.removePath(p("link"));
    expect(fs.existsSync(p("link"))).toBe(false);
    expect(fs.readFileSync(p("src", "SKILL.md"), "utf8")).toBe("hello");
    expect(result.mode).toBeTypeOf("string");
  });

  it("removes a directory tree", () => {
    writeRaw(p("d", "sub", "f.txt"), "x");
    fsops.removePath(p("d"));
    expect(fs.existsSync(p("d"))).toBe(false);
  });

  it("is a no-op for a missing path", () => {
    expect(() => fsops.removePath(p("nope"))).not.toThrow();
  });
});

describe("backups (SPEC §5)", () => {
  it("mirrors the original path structure under the backup root", () => {
    const home = p("home");
    const target = path.join(home, ".claude", "agents", "a.md");
    writeRaw(target, "body");
    const dest = fsops.backupPath(target, p("backup"), home);
    expect(dest).toBe(p("backup", ".claude", "agents", "a.md"));
    expect(fs.readFileSync(dest as string, "utf8")).toBe("body");
  });

  it("quarantines paths outside home under _external instead of escaping", () => {
    const home = p("home");
    fs.mkdirSync(home, { recursive: true });
    const outside = p("other", "mcp.json");
    writeRaw(outside, "{}");
    const dest = fsops.backupPath(outside, p("backup"), home) as string;
    expect(dest).toContain(path.join("backup", "_external"));
    expect(dest.startsWith(p("backup"))).toBe(true);
  });

  it("backs up a directory recursively", () => {
    const home = p("home");
    writeRaw(path.join(home, ".claude", "skills", "s", "SKILL.md"), "x");
    const dest = fsops.backupPath(
      path.join(home, ".claude", "skills", "s"),
      p("backup"),
      home,
    ) as string;
    expect(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8")).toBe("x");
  });

  it("returns null when there is nothing to back up", () => {
    expect(fsops.backupPath(p("home", "gone.md"), p("backup"), p("home"))).toBeNull();
  });

  it("records a link as a note rather than materializing a copy", () => {
    const home = p("home");
    writeRaw(path.join(home, "src", "SKILL.md"), "x");
    const link = path.join(home, ".claude", "skills", "s");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    const result = fsops.createJunction(path.join(home, "src"), link);
    const dest = fsops.backupPath(link, p("backup"), home) as string;
    if (result.mode === "junction") {
      expect(dest.endsWith(".link.txt")).toBe(true);
    }
    expect(fs.existsSync(dest)).toBe(true);
  });
});

describe("listing helpers", () => {
  it("returns [] for a missing directory instead of throwing", () => {
    expect(fsops.listDirNames(p("nope"))).toEqual([]);
    expect(fsops.listFiles(p("nope"))).toEqual([]);
  });

  it("lists subdirectories sorted", () => {
    fs.mkdirSync(p("d", "b"), { recursive: true });
    fs.mkdirSync(p("d", "a"), { recursive: true });
    writeRaw(p("d", "file.txt"), "x");
    expect(fsops.listDirNames(p("d"))).toEqual(["a", "b"]);
  });

  it("filters files by suffix", () => {
    writeRaw(p("d", "a.agent.md"), "x");
    writeRaw(p("d", "b.md"), "x");
    expect(fsops.listFiles(p("d"), ".agent.md")).toEqual(["a.agent.md"]);
    expect(fsops.listFiles(p("d"), ".md")).toEqual(["a.agent.md", "b.md"]);
  });
});

describe("hashText / hashFile", () => {
  it("agree for the same bytes", () => {
    writeRaw(p("f.txt"), "content");
    expect(fsops.hashFile(p("f.txt"))).toBe(fsops.hashText("content"));
  });
});
