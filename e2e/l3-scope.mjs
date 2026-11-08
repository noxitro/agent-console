/**
 * L3 for P2: read the **real** HOME through the scope layer, and prove that
 * nothing outside `~/.agent-console/` was written (ARCHITECTURE.md「フェーズとゲート」).
 *
 *   npm run build && node e2e/l3-scope.mjs
 *
 * Read-only by intent and by measurement, two ways:
 *
 *  1. **Write guard.** Every write-capable `node:fs` function is wrapped before
 *     the engine is loaded. A call whose path is outside `~/.agent-console/`
 *     is refused and recorded. The run passes only with zero.
 *  2. **Canary.** Every file the readers report as read is hashed and stat-ed
 *     before and after. Files that other programs keep writing (a running
 *     Claude Code session rewrites `~/.claude.json`, Copilot appends to its
 *     session logs) can change during the run; they are reported as such, and
 *     the write guard is what shows the change was not ours.
 *
 * Also measures S16 (discovery: first run without a cache < 10 s, with the
 * cache < 1 s), in-process and through the CLI.
 *
 * Output: a summary on stdout (counts and timings only, no paths) and the full
 * record in `e2e-artifacts/p2/` — which holds this machine's paths and is not
 * tracked. `~/.copilot/config.json` is never opened.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.AC_HOME || process.env.AM_HOME) {
  console.error("l3-scope: unset AC_HOME / AM_HOME — this check is about the real HOME.");
  process.exit(2);
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = os.homedir();
const consoleDir = path.join(home, ".agent-console");
const forbidden = path.join(home, ".copilot", "config.json").toLowerCase();
const outDir = path.join(repo, "e2e-artifacts", "p2");

/* ---- 1. write guard ------------------------------------------------- */

// This script's own report goes through the unguarded originals.
const realWriteFile = fs.writeFileSync;
const realMkdir = fs.mkdirSync;

const refused = [];
const allowedWrites = [];
const inConsoleDir = (p) => {
  const r = path.resolve(String(p)).toLowerCase();
  return r === consoleDir.toLowerCase() || r.startsWith(consoleDir.toLowerCase() + path.sep);
};
const guard = (name, pathArgs, isWrite = () => true) => {
  const orig = fs[name];
  fs[name] = function guarded(...args) {
    if (isWrite(...args)) {
      for (const i of pathArgs) {
        const p = args[i];
        if (typeof p !== "string" && !(p instanceof URL)) continue;
        if (!inConsoleDir(p)) {
          refused.push({ fn: name, path: String(p) });
          throw new Error(`l3-scope write guard: ${name} ${p}`);
        }
        allowedWrites.push({ fn: name, path: String(p) });
      }
    }
    return orig.apply(this, args);
  };
};
const writeFlag = (_p, flags) => typeof flags === "string" && /[wa+]/.test(flags);
for (const n of ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "rmdirSync", "unlinkSync", "utimesSync", "truncateSync", "chmodSync", "mkdtempSync"]) guard(n, [0]);
for (const n of ["renameSync", "copyFileSync", "symlinkSync", "linkSync", "cpSync"]) guard(n, [0, 1]);
guard("openSync", [0], writeFlag);
guard("createWriteStream", [0]);
// Never open the file that holds Copilot's credentials, even for reading.
for (const n of ["readFileSync", "openSync", "statSync", "lstatSync"]) {
  const orig = fs[n];
  fs[n] = function noConfig(...args) {
    if (typeof args[0] === "string" && path.resolve(args[0]).toLowerCase() === forbidden) {
      refused.push({ fn: n, path: "~/.copilot/config.json" });
      throw new Error("l3-scope: ~/.copilot/config.json must not be opened");
    }
    return orig.apply(this, args);
  };
}
syncBuiltinESMExports();

const { discoverProjects } = await import(new URL("../dist/scope/discover.js", import.meta.url).href);
const { readInstalled } = await import(new URL("../dist/scope/installed.js", import.meta.url).href);

/* ---- helpers -------------------------------------------------------- */

const realRead = fs.readFileSync;
function stamp(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { kind: "dir", mtimeMs: st.mtimeMs };
    return { kind: "file", mtimeMs: st.mtimeMs, size: st.size, sha256: createHash("sha256").update(realRead(file)).digest("hex") };
  } catch (err) {
    return { kind: "absent", code: err.code };
  }
}
const ms = (t0) => Math.round(performance.now() - t0);

/* ---- 2. first pass: what is read ------------------------------------ */

const cacheFile = path.join(consoleDir, "cache", "projects.json");
const hadCache = fs.existsSync(cacheFile);
const cacheBackup = hadCache ? realRead(cacheFile) : null;

// S16 cold: no cache. (The cache is agent-console's own file; it is restored at the end.)
if (hadCache) fs.rmSync(cacheFile);
let t0 = performance.now();
const cold = discoverProjects();
const coldMs = ms(t0);
t0 = performance.now();
const warm = discoverProjects();
const warmMs = ms(t0);

const projects = cold.projects;
const gitProjects = projects.filter((p) => p.git && !p.hidden);
const userUnit = readInstalled();
const perProject = gitProjects.map((p) => ({ p, r: readInstalled({ root: p.root }) }));

const read = new Set();
for (const s of [...userUnit.sources, ...perProject.flatMap((x) => x.r.sources)]) if (s.status === "ok") read.add(s.path);
for (const s of cold.sources) if (s.status === "ok") read.add(s.path);
const before = new Map([...read].map((f) => [f, stamp(f)]));

/* ---- 3. second pass, then compare ----------------------------------- */

t0 = performance.now();
discoverProjects();
const warm2Ms = ms(t0);
t0 = performance.now();
readInstalled();
for (const p of gitProjects) readInstalled({ root: p.root });
const installedAllMs = ms(t0);

// S16 through the CLI (node startup included).
const cli = path.join(repo, "dist", "cli.js");
const env = { ...process.env };
fs.rmSync(cacheFile, { force: true });
t0 = performance.now();
execFileSync(process.execPath, [cli, "projects", "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
const cliColdMs = ms(t0);
t0 = performance.now();
execFileSync(process.execPath, [cli, "projects", "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
const cliWarmMs = ms(t0);

const changed = [];
for (const [f, b] of before) {
  const a = stamp(f);
  if (JSON.stringify(a) !== JSON.stringify(b)) changed.push({ path: f, before: b, after: a });
}

if (cacheBackup !== null) fs.writeFileSync(cacheFile, cacheBackup);

/* ---- report ---------------------------------------------------------- */

const tally = (rows) => {
  const t = {};
  for (const r of rows) t[`${r.scope}/${r.kind}`] = (t[`${r.scope}/${r.kind}`] ?? 0) + 1;
  return t;
};
const summary = {
  writeGuard: { refused: refused.length, allowedWrites: allowedWrites.length, allowedUnder: "~/.agent-console/" },
  canary: { filesRead: before.size, changed: changed.length, changedLabels: changed.map((c) => labelOf(c.path)) },
  s16: { coldMs, warmMs, warm2Ms, cliColdMs, cliWarmMs, coldCache: cold.cache, warmCache: warm.cache, pass: coldMs < 10_000 && warmMs < 1_000 && cliColdMs < 10_000 && cliWarmMs < 1_000 },
  discovery: cold.counts,
  installed: { user: tally(userUnit.rows), projects: gitProjects.length, allProjectsMs: installedAllMs, userTotals: userUnit.totals },
};

function labelOf(p) {
  const rel = path.relative(home, p);
  if (rel.startsWith("..")) return "(project file)";
  return "~/" + rel.split(path.sep).slice(0, 2).join("/");
}

realMkdir(outDir, { recursive: true });
realWriteFile(path.join(outDir, "l3-scope.json"), JSON.stringify({ summary, changed, refused, allowedWrites, projects: cold, userUnit }, null, 1));
console.log(JSON.stringify(summary, null, 1));
process.exit(refused.length === 0 && summary.s16.pass ? 0 : 1);
