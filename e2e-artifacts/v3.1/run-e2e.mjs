/**
 * L3 — 実測ゲート (SPEC v3.1 / §10.7).
 *
 * テストランナーではなく、ビルド済みの CLI (`dist/cli.js`) を子プロセスとして
 * 実際に起動して測る。HOME は `AC_HOME` と `AM_HOME` の両方で使い捨ての一時
 * ディレクトリに差し替えるので、開発者本人の設定は読まれも書かれもしない
 * (src/core/paths.ts の設計どおり)。
 *
 * 生の出力は本ディレクトリの *.txt に保存する(一時 HOME の実パスを含むので
 * .gitignore で追跡から外してある)。判定は最後にまとめて表示する。
 *
 * 使い方: node e2e-artifacts/v3.1/run-e2e.mjs
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const CLI = path.join(REPO, "dist", "cli.js");

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail ? ` — ${detail}` : ""}`);
}

function makeHome(label) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `am-e2e-${label}-`));
  return home;
}

function write(home, relative, content) {
  const full = path.join(home, ...relative.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

/**
 * The child's environment: HOME isolated under both names. `AC_HOME` wins over
 * `AM_HOME` in src/core/paths.ts, so setting only the legacy name would let a
 * developer's own `AC_HOME` decide where the CLI reads and writes. The other
 * overrides are dropped so they fall back to the fake HOME as well.
 */
function childEnv(home) {
  const env = { ...process.env, AM_HOME: home, AC_HOME: home };
  for (const name of ["AC_APPDATA", "AC_CONFIG_HOME", "AM_APPDATA", "AM_CONFIG_HOME"]) delete env[name];
  return env;
}

function run(home, args, artifactName) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: childEnv(home),
  });
  const record = {
    argv: ["am", ...args],
    AM_HOME: home,
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
  fs.writeFileSync(
    path.join(HERE, artifactName),
    `$ AM_HOME=${home} node dist/cli.js ${args.join(" ")}\n` +
      `# exit status: ${res.status}\n` +
      `# ---------------- stdout ----------------\n${record.stdout}` +
      `# ---------------- stderr ----------------\n${record.stderr}`,
    "utf8",
  );
  return record;
}

function json(record) {
  try {
    return JSON.parse(record.stdout);
  } catch (err) {
    return { __parseError: String(err), raw: record.stdout.slice(0, 400) };
  }
}

const SKILL_MD = (name) =>
  `---\nname: ${name}\ndescription: A skill used by the v3.1 measurement gate.\n---\n\n# ${name}\n\nInstructions.\n`;

/* ================================================================== */
/* Scenario A — positive: ~/.agents/skills exists and holds a skill    */
/* ================================================================== */

console.log("\n=== Scenario A (positive) ===");
const homeA = makeHome("pos");

// The source of truth: one skill in the cross-agent standard root.
write(homeA, ".agents/skills/demo-skill/SKILL.md", SKILL_MD("demo-skill"));
// opencode's own assets, so the target is not empty in every dimension.
write(
  homeA,
  ".config/opencode/opencode.jsonc",
  `{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    "demo": { "type": "local", "command": ["node", "server.js"], "enabled": true }\n  }\n}\n`,
);
write(
  homeA,
  ".config/opencode/command/greet.md",
  `---\ndescription: Say hello.\n---\n\nSay hello to $ARGUMENTS.\n`,
);

const importA = run(homeA, ["import", "--json"], "A1-import.json.txt");
check("A0 import exits 0", importA.status === 0, `exit ${importA.status}`);

const invA = json(run(homeA, ["inventory", "--json"], "A2-inventory.json.txt"));
const ocA = (invA.targets ?? []).find((t) => t.id === "opencode");
const expectedSkillsDir = path.join(homeA, ".agents", "skills");

check("A1 inventory reports an opencode target", ocA !== undefined);
if (ocA) {
  const dirMatches =
    typeof ocA.skillsDir === "string" &&
    path.resolve(ocA.skillsDir) === path.resolve(expectedSkillsDir);
  check(
    "A2 opencode.skillsDir is the source of truth (~/.agents/skills), not 'unsupported'",
    dirMatches,
    `skillsDir=${JSON.stringify(ocA.skillsDir)}`,
  );

  const listed = Array.isArray(ocA.skills) ? ocA.skills : null;
  check(
    "A3 opencode.skills is a real listing containing demo-skill (shared discovery, visible)",
    listed !== null && listed.some((s) => s.name === "demo-skill"),
    `skills=${JSON.stringify(ocA.skills)}`,
  );

  const reasons = ocA.unsupportedReasons ?? [];
  check(
    "A4 unsupportedReasons carries agent but NOT skill",
    reasons.some((r) => r.assetType === "agent") && !reasons.some((r) => r.assetType === "skill"),
    `assetTypes=${JSON.stringify(reasons.map((r) => r.assetType))}`,
  );

  check(
    "A5 opencode does NOT claim sharesDiscoveryWith (§10.7: it owns mcp and command)",
    ocA.sharesDiscoveryWith === undefined,
    `sharesDiscoveryWith=${JSON.stringify(ocA.sharesDiscoveryWith)}`,
  );

  // SPEC §5: two views of one directory must not disagree.
  const vscodeA = (invA.targets ?? []).find((t) => t.id === "vscode");
  if (vscodeA && Array.isArray(vscodeA.skills) && Array.isArray(ocA.skills)) {
    check(
      "A6 opencode and vscode agree about the shared directory (SPEC §5)",
      JSON.stringify(vscodeA.skills) === JSON.stringify(ocA.skills),
      `vscode=${JSON.stringify(vscodeA.skills)} opencode=${JSON.stringify(ocA.skills)}`,
    );
  }
}

const planA = json(run(homeA, ["plan", "--json"], "A3-plan.json.txt"));
const planActions = planA.actions ?? [];
const skillActionsForOpencode = planActions.filter(
  (a) => a.target === "opencode" && a.assetType === "skill",
);
check(
  "A7 plan contains ZERO skill actions for opencode (planSkills() === [])",
  skillActionsForOpencode.length === 0,
  `found ${skillActionsForOpencode.length}: ${JSON.stringify(skillActionsForOpencode)}`,
);
const deleteAgainstSource = planActions.filter(
  (a) =>
    a.kind === "delete" &&
    typeof a.path === "string" &&
    path.resolve(a.path).startsWith(path.resolve(expectedSkillsDir)),
);
check(
  "A8 no plan action derives a delete against the source of truth (SPEC §6)",
  deleteAgainstSource.length === 0,
  JSON.stringify(deleteAgainstSource),
);

const applyA = run(homeA, ["apply", "--yes"], "A4-apply.txt");
check("A9 apply exits 0", applyA.status === 0, `exit ${applyA.status}`);

// The source skill must survive apply untouched.
check(
  "A10 the source skill still exists after apply",
  fs.existsSync(path.join(homeA, ".agents", "skills", "demo-skill", "SKILL.md")),
);

const planA2 = json(run(homeA, ["plan", "--json"], "A5-plan-after-apply.json.txt"));
const pending = (planA2.actions ?? []).filter((a) => a.kind !== "unsupported");
check(
  "A11 fixed point: plan after apply has no remaining work (SPEC §8)",
  pending.length === 0,
  `${pending.length} remaining: ${JSON.stringify(pending.map((a) => `${a.target}/${a.assetType}/${a.kind}`))}`,
);

const docA = json(run(homeA, ["doctor", "--json"], "A6-doctor.json.txt"));
const findings = docA.findings ?? [];
const opencodeSkillFindings = findings.filter(
  (f) => f.target === "opencode" && (f.asset === "skill" || f.assetType === "skill"),
);
check(
  "A12 doctor raises no skill-link finding for opencode (link check skipped when skillsDir == source)",
  opencodeSkillFindings.length === 0,
  JSON.stringify(opencodeSkillFindings),
);

/* ================================================================== */
/* Scenario B — negative: ~/.agents/skills does not exist              */
/* ================================================================== */

console.log("\n=== Scenario B (negative) ===");
const homeB = makeHome("neg");
write(
  homeB,
  ".config/opencode/opencode.jsonc",
  `{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {}\n}\n`,
);

const invB = json(run(homeB, ["inventory", "--json"], "B1-inventory-no-skills-dir.json.txt"));
const ocB = (invB.targets ?? []).find((t) => t.id === "opencode");
check("B1 inventory still exits and reports opencode", ocB !== undefined);
if (ocB) {
  check(
    "B2 with no skills directory, opencode.skills is empty — it does not invent entries",
    Array.isArray(ocB.skills) && ocB.skills.length === 0,
    `skills=${JSON.stringify(ocB.skills)}`,
  );
  check(
    "B3 skillsDir still names the path it would discover (honest about where it looks)",
    typeof ocB.skillsDir === "string" &&
      path.resolve(ocB.skillsDir) === path.resolve(path.join(homeB, ".agents", "skills")),
    `skillsDir=${JSON.stringify(ocB.skillsDir)}`,
  );
}
const docB = json(run(homeB, ["doctor", "--json"], "B2-doctor-no-skills-dir.json.txt"));
check(
  "B4 doctor does not crash when the skills directory is absent",
  docB.__parseError === undefined,
  docB.__parseError ?? "",
);

/* ================================================================== */
/* Scenario C — negative: an unreadable/odd entry in the skills dir    */
/* ================================================================== */

console.log("\n=== Scenario C (hostile directory contents) ===");
const homeC = makeHome("hostile");
write(homeC, ".agents/skills/demo-skill/SKILL.md", SKILL_MD("demo-skill"));
// A plain file where a skill directory is expected.
write(homeC, ".agents/skills/stray.txt", "not a skill\n");
// A broken symlink, when the platform lets us make one without elevation.
let brokenLinkMade = false;
try {
  fs.symlinkSync(
    path.join(homeC, ".agents", "skills", "does-not-exist"),
    path.join(homeC, ".agents", "skills", "dangling"),
    "junction",
  );
  brokenLinkMade = true;
} catch {
  /* no privilege for links on this machine — recorded below, not fatal */
}

const invC = json(run(homeC, ["inventory", "--json"], "C1-inventory-hostile.json.txt"));
const ocC = (invC.targets ?? []).find((t) => t.id === "opencode");
check(
  "C1 inventory survives a stray file (and a broken link) in the skills directory",
  ocC !== undefined && Array.isArray(ocC.skills),
  `brokenLinkCreated=${brokenLinkMade} skills=${JSON.stringify(ocC?.skills)}`,
);
if (ocC && Array.isArray(ocC.skills)) {
  const kinds = Object.fromEntries(ocC.skills.map((s) => [s.name, s.kind]));
  check(
    "C2 a loose file in the skills root is not listed as something opencode discovers",
    kinds["stray.txt"] === undefined && kinds["demo-skill"] === "directory",
    JSON.stringify(kinds),
  );
  if (brokenLinkMade) {
    check(
      "C3 a dangling link is classified as 'broken' or 'missing', never silently as a directory",
      kinds["dangling"] === "broken" || kinds["dangling"] === "missing",
      JSON.stringify(kinds),
    );
  }
}
// SPEC §5 under adversarial contents: vscode, vs2026 and opencode read the SAME
// directory, so their listings must not disagree. vs2026 joined the check when
// §10.7's open question was resolved (2026-09-04) — until then it answered
// "unsupported" while naming that directory as its own skillsDir, which is the
// disagreement this check exists to catch, in its most literal form.
const SHARED_C = ["vscode", "vs2026", "opencode"].map((id) => ({
  id,
  target: (invC.targets ?? []).find((t) => t.id === id),
}));
const listedC = SHARED_C.filter((t) => Array.isArray(t.target?.skills));
if (listedC.length === SHARED_C.length) {
  const shape = (t) => JSON.stringify(t.target.skills);
  const first = listedC[0];
  check(
    "C5 every shared-discovery target agrees about the directory when it holds a stray file and a broken link (SPEC §5)",
    listedC.every((t) => shape(t) === shape(first)),
    listedC
      .map((t) => `${t.id}=${JSON.stringify(t.target.skills.map((s) => `${s.name}:${s.kind}`))}`)
      .join(" "),
  );
} else {
  check(
    "C5 every shared-discovery target reports a listing for the shared directory (SPEC §5)",
    false,
    `not listed: ${SHARED_C.filter((t) => !Array.isArray(t.target?.skills))
      .map((t) => `${t.id}=${JSON.stringify(t.target?.skills)}`)
      .join(" ")}`,
  );
}

const docC = json(run(homeC, ["doctor", "--json"], "C2-doctor-hostile.json.txt"));
check(
  "C4 doctor survives the hostile directory",
  docC.__parseError === undefined,
  docC.__parseError ?? "",
);

/* ================================================================== */

const failed = results.filter((r) => !r.ok);
const summary =
  `# L3 measurement gate — SPEC v3.1 (§10.7)\n` +
  `# CLI: node dist/cli.js  (built from the working tree)\n` +
  `# node ${process.version} on ${os.platform()} ${os.release()}\n` +
  `# fake HOMEs: A=${homeA}  B=${homeB}  C=${homeC}\n\n` +
  results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.id}${r.detail ? ` — ${r.detail}` : ""}`).join("\n") +
  `\n\n${results.length} checks, ${failed.length} failed\n`;
fs.writeFileSync(path.join(HERE, "L3-summary.txt"), summary, "utf8");

console.log(`\n${results.length} checks, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
