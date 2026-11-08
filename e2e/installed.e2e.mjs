/**
 * The Installed view against a throwaway AC_HOME (ARCHITECTURE.md「単位とプロジェクト」).
 *
 *   node e2e/installed.e2e.mjs      (after `npm run build` and `npm run build:ui`)
 *
 * A fictional machine: a Claude record naming one repository, a Copilot
 * session naming the same one, user-level skills and instructions for both
 * harnesses. The checks read the screen and then the disk — the only file the
 * view may change is `~/.agent-console/projects.json`, and every other file
 * under the fake HOME and the repository is compared before and after.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { chromium } from "playwright";

import { assert, checks, makeHome, seedMachine, startServer, writeFile } from "./harness.mjs";

const home = makeHome("ac-e2e-inst-");
seedMachine(home);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ac-e2e-inst-work-"));
const repo = path.join(work, "sample-repo");
const extra = path.join(work, "loose-folder");
fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
fs.mkdirSync(extra, { recursive: true });
writeFile(repo, "CLAUDE.md", "Project rules for the sample.\n");
writeFile(repo, ".github/copilot-instructions.md", "Copilot rules for the sample.\n");
writeFile(repo, ".claude/skills/sample-skill/SKILL.md", "---\nname: sample-skill\ndescription: Read by both harnesses\n---\nbody\n");
writeFile(repo, ".mcp.json", JSON.stringify({ mcpServers: { "sample-mcp": { command: "node", env: { TOKEN: "E2E-SECRET" } } } }));
writeFile(home, ".claude.json", JSON.stringify({ oauthAccount: { emailAddress: "nobody@example.invalid" }, projects: { [repo]: {} } }));
writeFile(home, ".copilot/session-state/s1/events.jsonl", `${JSON.stringify({ type: "session.start", data: { context: { cwd: repo, gitRoot: repo } } })}\n`);
writeFile(home, ".claude/CLAUDE.md", "User rules for Claude.\n");
writeFile(home, ".copilot/config.json", '{"secret":"E2E-SECRET"}');

/** Hash and mtime of every file under `root`, except agent-console's own directory. */
function canary(root) {
  const out = {};
  for (const e of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    const p = path.join(e.parentPath, e.name);
    if (p.includes(`${path.sep}.agent-console`) || !e.isFile()) continue;
    out[p] = `${fs.statSync(p).mtimeMs}:${createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`;
  }
  return out;
}
const before = { ...canary(home), ...canary(work) };

const server = await startServer(home);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const problems = [];
page.on("console", (m) => {
  // I4 provokes the one expected 400: the vocabulary refusing a relative folder.
  if (m.type() === "error" && !m.text().includes("status of 400")) problems.push(m.text());
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

const t = checks("installed e2e");
const rowNames = async () =>
  (await page.locator('table[aria-label="読み込まれる資産"] tbody .row-name').allInnerTexts()).map((s) => s.trim());
const settings = () => JSON.parse(fs.readFileSync(path.join(home, ".agent-console", "projects.json"), "utf8"));

try {
  await t.check("I1 Installed is the default view and shows the user unit from the real engine", async () => {
    await page.goto(server.launchUrl);
    await page.getByRole("heading", { name: "個人" }).waitFor({ timeout: 15000 });
    await page.locator('table[aria-label="読み込まれる資産"]').waitFor({ timeout: 15000 });
    assert((await page.getByText("参考データ").count()) === 0, "fixture strip is shown");
    const names = await rowNames();
    assert(names.includes("demo-skill") && names.includes("CLAUDE.md"), `rows: ${names}`);
    return `user rows=${names.length}`;
  });

  await t.check("I2 the discovered project is in the rail, and choosing it adds its project unit", async () => {
    await page.getByRole("button", { name: /sample-repo/ }).click();
    await page.getByRole("heading", { name: "sample-repo" }).waitFor();
    await page.getByRole("columnheader", { name: "このプロジェクトで開くと" }).waitFor();
    // The heading follows the click at once; the rows follow the engine.
    await page.getByRole("button", { name: "sample-skill" }).waitFor({ timeout: 15000 });
    const names = await rowNames();
    for (const n of ["sample-skill", "copilot-instructions.md", "sample-mcp"]) assert(names.includes(n), `${n} missing: ${names}`);
    await page.getByRole("button", { name: "sample-skill" }).click();
    const detail = await page.locator("aside.detail").innerText();
    assert(detail.includes("Claude") && detail.includes("Copilot"), "detail does not list both harnesses");
    const body = await page.locator("body").innerText();
    assert(!body.includes("E2E-SECRET") && !body.includes("nobody@example.invalid"), "a secret reached the screen");
    return `rows=${names.length}`;
  });

  await t.check("I3 pinning writes ~/.agent-console/projects.json and nothing else", async () => {
    await page.getByRole("button", { name: "上に固定" }).click();
    await page.getByRole("button", { name: "固定を外す" }).waitFor();
    const s = settings();
    assert(s.pinned.length === 1 && s.pinned[0].toLowerCase() === repo.toLowerCase(), JSON.stringify(s));
    return "pinned";
  });

  await t.check("I4 adding a folder: a relative path is refused beside the field, an absolute one is added", async () => {
    await page.getByLabel("フォルダを手で足す").fill("relative\\path");
    await page.getByRole("button", { name: "追加", exact: true }).click();
    await page.locator("#add-error").waitFor();
    assert(settings().added.length === 0, "a refused folder was saved");
    await page.getByLabel("隠したものも出す", { exact: false }).isVisible();
    await page.getByLabel("git 外のフォルダも出す", { exact: false }).check();
    await page.getByLabel("フォルダを手で足す").fill(extra);
    await page.getByRole("button", { name: "追加", exact: true }).click();
    await page.getByRole("button", { name: /loose-folder/ }).waitFor();
    assert(settings().added.some((p) => p.toLowerCase() === extra.toLowerCase()), JSON.stringify(settings()));
    return "added";
  });

  await t.check("I5 canary: no file outside ~/.agent-console changed (hash and mtime)", async () => {
    const after = { ...canary(home), ...canary(work) };
    const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
    assert(changed.length === 0, `changed: ${changed.join(", ")}`);
    return `${Object.keys(before).length} files unchanged`;
  });

  await t.check("I6 no console errors", async () => {
    assert(problems.length === 0, problems.join("\n"));
    return "0";
  });
} finally {
  await browser.close();
  await server.stop();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
}
process.exit(t.finish());
