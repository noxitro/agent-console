import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  defaultManifest,
  enabledTargets,
  isTargetEnabled,
  MANIFEST_VERSION,
  readManifest,
  serializeManifest,
  validateManifest,
  writeManifest,
} from "./manifest.js";
import { AmError } from "./model.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-manifest-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(content: string): string {
  const file = path.join(tmp, "manifest.json");
  fs.writeFileSync(file, content);
  return file;
}

describe("defaultManifest (SPEC §2)", () => {
  it("enables all five targets and defaults to junction link mode", () => {
    const m = defaultManifest();
    expect(m.version).toBe(MANIFEST_VERSION);
    expect(enabledTargets(m)).toEqual([
      "claude",
      "copilot-cli",
      "vscode",
      "vs2026",
      "opencode",
    ]);
    expect(m.skills).toEqual({ linkMode: "junction", exclude: [] });
    // SPEC §9.1: the v2 keys exist on every manifest this build hands out.
    expect(m.mcp).toEqual({ exclude: [] });
    expect(m.agents).toEqual({ exclude: [] });
  });
});

describe("readManifest", () => {
  it("returns defaults when the file does not exist", () => {
    expect(readManifest(path.join(tmp, "absent.json"))).toEqual(defaultManifest());
  });

  it("throws on malformed JSON instead of falling back to defaults", () => {
    const file = write("{ broken");
    expect(() => readManifest(file)).toThrow(AmError);
  });

  it("reads a partial manifest and fills defaults", () => {
    const file = write(JSON.stringify({ version: 1, targets: { vs2026: { enabled: false } } }));
    const m = readManifest(file);
    expect(enabledTargets(m)).toEqual(["claude", "copilot-cli", "vscode", "opencode"]);
    expect(m.skills.linkMode).toBe("junction");
  });
});

describe("validateManifest", () => {
  it("accepts the documented example", () => {
    const m = validateManifest({
      version: 1,
      targets: {
        claude: { enabled: true },
        "copilot-cli": { enabled: true },
        vscode: { enabled: true },
        vs2026: { enabled: true },
      },
      skills: { linkMode: "junction", exclude: [] },
    });
    // SPEC §9.1: a v1 file is accepted, completed with empty exclude lists,
    // and keeps its version until something writes it back out.
    expect(m).toEqual({ ...defaultManifest(), version: 1 });
  });

  it("rejects a non-object", () => {
    expect(() => validateManifest([])).toThrow(/must be a JSON object/);
    expect(() => validateManifest(null)).toThrow(/must be a JSON object/);
  });

  it("rejects an unsupported version", () => {
    // SPEC §10.5 made 3 a version this build reads; 4 is the next unknown one.
    expect(() => validateManifest({ version: 4 })).toThrow(/Unsupported manifest version/);
  });

  it("rejects an unknown target id", () => {
    expect(() => validateManifest({ targets: { emacs: { enabled: true } } })).toThrow(
      /Unknown target "emacs"/,
    );
  });

  it("rejects a non-boolean enabled", () => {
    expect(() => validateManifest({ targets: { claude: { enabled: "yes" } } })).toThrow(
      /must be a boolean/,
    );
  });

  it("rejects an invalid linkMode", () => {
    expect(() => validateManifest({ skills: { linkMode: "hardlink" } })).toThrow(/linkMode/);
  });

  it("accepts copy linkMode", () => {
    expect(validateManifest({ skills: { linkMode: "copy" } }).skills.linkMode).toBe("copy");
  });

  it("rejects a non-string-array exclude", () => {
    expect(() => validateManifest({ skills: { exclude: [1] } })).toThrow(/array of strings/);
  });

  it("keeps exclude entries", () => {
    expect(validateManifest({ skills: { exclude: ["a", "b"] } }).skills.exclude).toEqual(["a", "b"]);
  });
});

describe("serializeManifest / writeManifest", () => {
  it("produces stable, key-ordered JSON with a trailing newline", () => {
    const text = serializeManifest(defaultManifest());
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf('"version"')).toBeLessThan(text.indexOf('"targets"'));
    expect(text.indexOf('"targets"')).toBeLessThan(text.indexOf('"skills"'));
  });

  it("round-trips through the file system", () => {
    const file = path.join(tmp, "sub", "manifest.json");
    const m = defaultManifest();
    m.skills.linkMode = "copy";
    m.targets.vs2026.enabled = false;
    writeManifest(m, file);
    expect(readManifest(file)).toEqual(m);
    expect(fs.readFileSync(file, "utf8")).not.toContain("\r");
  });
});

describe("target helpers", () => {
  it("isTargetEnabled reflects the manifest", () => {
    const m = defaultManifest();
    m.targets.vscode.enabled = false;
    expect(isTargetEnabled(m, "vscode")).toBe(false);
    expect(isTargetEnabled(m, "claude")).toBe(true);
  });

  it("enabledTargets preserves canonical order", () => {
    const m = defaultManifest();
    m.targets.claude.enabled = false;
    expect(enabledTargets(m)).toEqual(["copilot-cli", "vscode", "vs2026", "opencode"]);
  });
});
