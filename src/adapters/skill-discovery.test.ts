/**
 * SPEC §5 — the shared skill discovery root has exactly one reading.
 *
 * VS Code (SPEC §4), VS 2026 (SPEC §4) and opencode (SPEC §10.7) all discover
 * skills straight from `~/.agents/skills`. `inventory` answers "who sees what"
 * from those readings, so if the adapters read the directory differently the
 * console shows one directory holding several different sets of things.
 *
 * vs2026 joined this list last (SPEC §10.7, resolved 2026-09-04). Until then it
 * answered `"unsupported"` while naming the same directory as its `skillsDir` —
 * a third reading of one directory, disagreeing with the other two by refusing
 * to read at all.
 *
 * That is not hypothetical: the two adapters once carried copied classifiers
 * that drifted — one listed loose files, the other listed only directories —
 * and `am inventory --json` reported a stray `notes.txt` as something opencode
 * saw and VS Code did not. These tests measure the invariant on contents built
 * to break it, not on a directory holding one tidy skill.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sourceSkillsDir } from "../core/paths.js";
import { createOpencodeAdapter } from "./opencode.js";
import { readSharedSkillLinks } from "./skill-discovery.js";
import { createVs2026Adapter } from "./vs2026.js";
import { vscodeAdapter } from "./vscode.js";

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env["AM_HOME"];
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "am-skill-discovery-")));
  process.env["AM_HOME"] = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["AM_HOME"];
  else process.env["AM_HOME"] = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function skillDir(name: string): string {
  const dir = path.join(sourceSkillsDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: A skill.\n---\n\nBody.\n`,
    "utf8",
  );
  return dir;
}

/** Every adapter that reads the shared root rather than owning a directory. */
const SHARED_READERS = [
  { id: "vscode", read: () => vscodeAdapter.readSkillLinks() },
  { id: "vs2026", read: () => createVs2026Adapter().readSkillLinks() },
  { id: "opencode", read: () => createOpencodeAdapter().readSkillLinks() },
] as const;

describe("SPEC §5: the shared discovery root reads the same for every target", () => {
  it("agrees on a directory holding a mix of skills, loose files and links", () => {
    skillDir("alpha");
    skillDir("beta");
    fs.writeFileSync(path.join(sourceSkillsDir(), "notes.txt"), "not a skill\n", "utf8");
    fs.writeFileSync(path.join(sourceSkillsDir(), "README.md"), "not a skill either\n", "utf8");

    const readings = SHARED_READERS.map((r) => ({ id: r.id, links: r.read() }));
    const [first, ...rest] = readings;
    for (const other of rest) {
      expect(other.links, `${other.id} disagrees with ${first!.id}`).toEqual(first!.links);
    }
  });

  it("lists the skill directories and omits what no target discovers", () => {
    skillDir("alpha");
    fs.writeFileSync(path.join(sourceSkillsDir(), "notes.txt"), "x", "utf8");

    for (const reader of SHARED_READERS) {
      const links = reader.read();
      expect(links.map((l) => l.name), reader.id).toEqual(["alpha"]);
      expect(links[0]?.kind, reader.id).toBe("directory");
    }
  });

  it("orders entries the same way regardless of how the file system enumerates them", () => {
    // Mixed case is where a code-point sort and a locale sort part company —
    // the exact drift that made two readings of one directory differ in order.
    for (const name of ["Zulu", "alpha", "Beta", "charlie"]) skillDir(name);

    const readings = SHARED_READERS.map((r) => r.read().map((l) => l.name));
    const [first, ...rest] = readings;
    for (const other of rest) expect(other).toEqual(first);
    expect(first).toEqual([...first!].sort((a, b) => a.localeCompare(b)));
  });

  it("reports an empty listing — not a failure — when the root does not exist", () => {
    expect(fs.existsSync(sourceSkillsDir())).toBe(false);
    for (const reader of SHARED_READERS) expect(reader.read(), reader.id).toEqual([]);
  });

  it("classifies a broken link as broken, in every reading", () => {
    fs.mkdirSync(sourceSkillsDir(), { recursive: true });
    try {
      fs.symlinkSync(
        path.join(sourceSkillsDir(), "gone"),
        path.join(sourceSkillsDir(), "dangling"),
        "junction",
      );
    } catch {
      return; // no privilege to create links on this machine
    }
    for (const reader of SHARED_READERS) {
      const dangling = reader.read().find((l) => l.name === "dangling");
      expect(dangling?.kind, reader.id).toBe("broken");
    }
  });

  it(
    "positive control: the agreement test can fail — a reader that included loose " +
      "files would be caught",
    () => {
      skillDir("alpha");
      fs.writeFileSync(path.join(sourceSkillsDir(), "notes.txt"), "x", "utf8");

      const shared = readSharedSkillLinks();
      // The pre-fix opencode reading, reconstructed: directories ∪ files.
      const withLooseFiles = fs
        .readdirSync(sourceSkillsDir(), { withFileTypes: true })
        .map((e) => e.name)
        .sort();

      expect(withLooseFiles).toContain("notes.txt");
      expect(shared.map((l) => l.name)).not.toEqual(withLooseFiles);
    },
  );
});
