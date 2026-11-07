import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import * as paths from "./paths.js";

const ORIGINAL_AM_HOME = process.env["AM_HOME"];
const ORIGINAL_AM_APPDATA = process.env["AM_APPDATA"];

function setHome(value: string | undefined): void {
  if (value === undefined) delete process.env["AM_HOME"];
  else process.env["AM_HOME"] = value;
}

afterEach(() => {
  setHome(ORIGINAL_AM_HOME);
  if (ORIGINAL_AM_APPDATA === undefined) delete process.env["AM_APPDATA"];
  else process.env["AM_APPDATA"] = ORIGINAL_AM_APPDATA;
});

describe("homeDir", () => {
  it("falls back to os.homedir() when AM_HOME is unset", () => {
    setHome(undefined);
    expect(paths.homeDir()).toBe(os.homedir());
  });

  it("is overridden by AM_HOME", () => {
    setHome(path.join(os.tmpdir(), "am-fake-home"));
    expect(paths.homeDir()).toBe(path.resolve(path.join(os.tmpdir(), "am-fake-home")));
  });

  it("ignores an empty AM_HOME", () => {
    setHome("   ");
    expect(paths.homeDir()).toBe(os.homedir());
  });

  it("is read lazily so a change takes effect immediately", () => {
    setHome("C:\\one");
    const first = paths.sourceRoot();
    setHome("C:\\two");
    expect(paths.sourceRoot()).not.toBe(first);
  });
});

describe("source layout (SPEC §2)", () => {
  const fake = path.resolve(path.join(os.tmpdir(), "am-home-1"));

  it("resolves every source path under AM_HOME", () => {
    setHome(fake);
    expect(paths.sourceRoot()).toBe(path.join(fake, ".agents-manager"));
    expect(paths.manifestPath()).toBe(path.join(fake, ".agents-manager", "manifest.json"));
    expect(paths.sourceMcpPath()).toBe(
      path.join(fake, ".agents-manager", "mcp", "servers.json"),
    );
    expect(paths.sourceAgentPath("code-reviewer")).toBe(
      path.join(fake, ".agents-manager", "agents", "code-reviewer.md"),
    );
    expect(paths.backupsRoot()).toBe(path.join(fake, ".agents-manager", "backups"));
    expect(paths.sourceSkillDir("style-guide")).toBe(
      path.join(fake, ".agents", "skills", "style-guide"),
    );
  });

  it("puts the skill lock beside skills/, not inside a skill", () => {
    setHome(fake);
    // The one file `npx skills` actually writes. Nesting it under a skill
    // directory is the bug this pins: nothing would ever be found there.
    expect(paths.skillLockPath()).toBe(path.join(fake, ".agents", ".skill-lock.json"));
    expect(paths.skillLockPath()).toBe(
      path.join(path.dirname(paths.sourceSkillsDir()), ".skill-lock.json"),
    );
    expect(paths.skillLockPath().startsWith(paths.sourceSkillsDir())).toBe(false);
  });

  it("sanitizes colons out of backup timestamps (illegal on Windows)", () => {
    setHome(fake);
    const dir = paths.backupDir(new Date("2026-08-16T12:34:56.000Z"));
    expect(path.basename(dir)).toBe("2026-08-16T12-34-56.000Z");
    expect(path.basename(dir)).not.toContain(":");
  });
});

describe("target paths (SPEC §4)", () => {
  const fake = path.resolve(path.join(os.tmpdir(), "am-home-2"));

  it("matches the adapter matrix", () => {
    setHome(fake);
    expect(paths.claudeSkillPath("x")).toBe(path.join(fake, ".claude", "skills", "x"));
    expect(paths.claudeAgentPath("x")).toBe(path.join(fake, ".claude", "agents", "x.md"));
    expect(paths.claudeJsonPath()).toBe(path.join(fake, ".claude.json"));
    expect(paths.copilotSkillPath("x")).toBe(path.join(fake, ".copilot", "skills", "x"));
    expect(paths.copilotAgentPath("x")).toBe(
      path.join(fake, ".copilot", "agents", "x.agent.md"),
    );
    expect(paths.copilotMcpConfigPath()).toBe(path.join(fake, ".copilot", "mcp-config.json"));
    expect(paths.vs2026AgentPath("x")).toBe(path.join(fake, ".github", "agents", "x.agent.md"));
  });

  it("keeps %APPDATA% inside the fake home when AM_HOME is set", () => {
    setHome(fake);
    delete process.env["AM_APPDATA"];
    expect(paths.vscodeMcpPath()).toBe(
      path.join(fake, "AppData", "Roaming", "Code", "User", "mcp.json"),
    );
  });

  it("honours an explicit AM_APPDATA override", () => {
    setHome(fake);
    process.env["AM_APPDATA"] = "C:\\custom\\Roaming";
    expect(paths.vscodeUserDir()).toBe(path.resolve("C:\\custom\\Roaming", "Code", "User"));
  });
});

describe("relativeToHome", () => {
  it("returns a POSIX relative path for paths under the root", () => {
    const root = path.resolve("C:\\home\\u");
    expect(paths.relativeToHome(path.join(root, ".claude", "agents", "a.md"), root)).toBe(
      ".claude/agents/a.md",
    );
  });

  it("returns null for paths outside the root", () => {
    const root = path.resolve("C:\\home\\u");
    expect(paths.relativeToHome(path.resolve("C:\\elsewhere\\a.md"), root)).toBeNull();
  });

  it("returns null for the root itself", () => {
    const root = path.resolve("C:\\home\\u");
    expect(paths.relativeToHome(root, root)).toBeNull();
  });
});

describe("AC_HOME (agent-console) with AM_HOME as the legacy fallback", () => {
  const ORIGINAL_AC_HOME = process.env["AC_HOME"];
  afterEach(() => {
    if (ORIGINAL_AC_HOME === undefined) delete process.env["AC_HOME"];
    else process.env["AC_HOME"] = ORIGINAL_AC_HOME;
  });

  it("AC_HOME wins over AM_HOME", () => {
    process.env["AC_HOME"] = path.join(os.tmpdir(), "ac-home");
    setHome(path.join(os.tmpdir(), "am-home"));
    expect(paths.homeDir()).toBe(path.resolve(path.join(os.tmpdir(), "ac-home")));
  });

  it("AM_HOME is still read when AC_HOME is unset", () => {
    delete process.env["AC_HOME"];
    setHome(path.join(os.tmpdir(), "am-home"));
    expect(paths.homeDir()).toBe(path.resolve(path.join(os.tmpdir(), "am-home")));
  });

  it("a blank AC_HOME falls through to AM_HOME", () => {
    process.env["AC_HOME"] = "  ";
    setHome(path.join(os.tmpdir(), "am-home"));
    expect(paths.homeDir()).toBe(path.resolve(path.join(os.tmpdir(), "am-home")));
  });

  it("AC_HOME also isolates APPDATA and the XDG config root", () => {
    const fake = path.resolve(path.join(os.tmpdir(), "ac-home-2"));
    process.env["AC_HOME"] = fake;
    setHome(undefined);
    delete process.env["AM_APPDATA"];
    expect(paths.appDataDir()).toBe(path.join(fake, "AppData", "Roaming"));
    expect(paths.configHomeDir()).toBe(path.join(fake, ".config"));
  });

  it("PC-local state lives under ~/.agent-console/", () => {
    const fake = path.resolve(path.join(os.tmpdir(), "ac-home-3"));
    process.env["AC_HOME"] = fake;
    expect(paths.consoleRoot()).toBe(path.join(fake, ".agent-console"));
    expect(paths.serverLockPath()).toBe(path.join(fake, ".agent-console", "server.json"));
    expect(paths.legacyCommandsPath()).toBe(
      path.join(fake, ".agent-console", "legacy-commands.json"),
    );
    // the distribution source keeps its legacy name for compatibility (ARCHITECTURE.md「am から引き継いだもの」)
    expect(paths.sourceRoot()).toBe(path.join(fake, ".agents-manager"));
  });
});
