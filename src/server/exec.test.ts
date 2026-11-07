/**
 * `exec.ts` never starts a script interpreter (ARCHITECTURE.md「守り」) — the
 * former desktop shell's script checks, carried over and widened.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertLaunchable, ExecRefused, openInBrowser, resolveExecutable } from "./exec.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-exec-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("exec.ts refuses shims", () => {
  it("refuses .cmd / .bat / .ps1 / .com in any case", () => {
    for (const file of ["C:/tools/node.cmd", "C:/tools/node.CMD", "C:/tools/x.bat", "C:/tools/x.ps1", "C:/tools/x.com"]) {
      expect(() => assertLaunchable(file), file).toThrow(ExecRefused);
    }
  });

  it.runIf(process.platform === "win32")("accepts a real .exe (positive control)", () => {
    expect(() => assertLaunchable("C:/tools/node.exe")).not.toThrow();
    expect(() => assertLaunchable("C:/tools/node")).toThrow(ExecRefused);
  });

  it.runIf(process.platform === "win32")("finds name.exe on PATH and ignores a name.cmd next to it", () => {
    fs.writeFileSync(path.join(dir, "tool.cmd"), "@echo off\r\n");
    expect(() => resolveExecutable("tool", dir)).toThrow(ExecRefused);
    fs.writeFileSync(path.join(dir, "tool.exe"), "");
    expect(resolveExecutable("tool", dir)).toBe(path.join(dir, "tool.exe"));
  });

  it("refuses a .cmd asked for by name, and a relative path", () => {
    expect(() => resolveExecutable("tool.cmd", dir)).toThrow(ExecRefused);
    expect(() => resolveExecutable("bin/tool", dir)).toThrow(ExecRefused);
  });

  it("opens only this server's own URLs", () => {
    expect(() => openInBrowser("https://example.com/")).toThrow(ExecRefused);
    expect(() => openInBrowser("http://127.0.0.1:47821/launch?code=x&\"calc")).toThrow(ExecRefused);
    expect(() => openInBrowser("http://localhost:47821/")).toThrow(ExecRefused);
  });
});
