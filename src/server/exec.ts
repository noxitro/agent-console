/**
 * The only place agent-console starts another program (ARCHITECTURE.md「守り」).
 *
 * No shell ever participates: the program is spawned with `shell: false` and
 * must resolve to a real executable. On Windows a `.cmd` / `.bat` is run by
 * cmd.exe, which re-parses the argument string with rules Node's quoting does
 * not model (CVE-2024-27980 / "BatBadBut"), so an argument array is *not* safe
 * once a batch file is in the path. `.ps1` and `.com` are refused for the same
 * reason (an interpreter, or a legacy format nothing here needs). The caller
 * gets an error instead of a launch.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Extensions that are scripts for a command interpreter, never launched. */
export const FORBIDDEN_EXTENSIONS = [".cmd", ".bat", ".ps1", ".com", ".vbs", ".js", ".wsf"];

export class ExecRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecRefused";
  }
}

/** Throw unless `file` is something this module may start directly. */
export function assertLaunchable(file: string): void {
  const ext = path.extname(file).toLowerCase();
  if (FORBIDDEN_EXTENSIONS.includes(ext)) {
    throw new ExecRefused(
      `Refusing to run ${file}: a ${ext} file is executed by an interpreter that re-parses its arguments. Point at the .exe itself.`,
    );
  }
  if (process.platform === "win32" && ext !== ".exe") {
    throw new ExecRefused(`Refusing to run ${file}: only .exe files are started on Windows.`);
  }
}

/**
 * Find `name` on PATH as a real executable. On Windows only `<name>.exe` is
 * considered — PATHEXT is deliberately ignored, because honouring it is how a
 * `name.cmd` shim would be picked up.
 */
export function resolveExecutable(name: string, envPath = process.env["PATH"] ?? ""): string {
  if (path.isAbsolute(name)) {
    assertLaunchable(name);
    if (!fs.existsSync(name)) throw new ExecRefused(`${name} does not exist.`);
    return name;
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new ExecRefused(`Refusing a relative program path: ${name}`);
  }
  const fileName = process.platform === "win32" && path.extname(name) === "" ? `${name}.exe` : name;
  assertLaunchable(fileName);
  for (const dir of envPath.split(path.delimiter)) {
    if (dir.trim() === "") continue;
    const candidate = path.join(dir, fileName);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* not here */
    }
  }
  throw new ExecRefused(`Could not find ${fileName} on PATH.`);
}

/** Start a program without a shell. Arguments are passed as an array, untouched. */
export function launch(file: string, args: readonly string[]): ChildProcess {
  assertLaunchable(file);
  const child = spawn(file, [...args], {
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: "ignore",
  });
  // A program that fails to start (missing, refused) emits `error`; unheard,
  // that event would take the whole server down with it.
  child.on("error", (err) => {
    process.stderr.write(`agent-console: could not start ${file}: ${err.message}\n`);
  });
  return child;
}

/**
 * Open a URL in the default browser.
 *
 * Windows: `rundll32.exe url.dll,FileProtocolHandler <url>` from System32 —
 * an executable, so no `cmd /c start` is involved. Only our own
 * `http://127.0.0.1:<port>/…` URLs are ever passed.
 */
export function openInBrowser(url: string): void {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9/?=&._-]*$/.test(url)) {
    throw new ExecRefused(`Refusing to open a URL that is not this server's: ${url}`);
  }
  let child: ChildProcess;
  if (process.platform === "win32") {
    const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
    child = launch(path.join(systemRoot, "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", url]);
  } else if (process.platform === "darwin") {
    child = launch("/usr/bin/open", [url]);
  } else {
    child = launch(resolveExecutable("xdg-open"), [url]);
  }
  child.unref();
}
