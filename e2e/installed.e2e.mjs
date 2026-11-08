/**
 * The Installed view against a throwaway AC_HOME (ARCHITECTURE.md「単位とプロジェクト」).
 *
 *   node e2e/installed.e2e.mjs      (after `npm run build` and `npm run build:ui`)
 *
 * A fictional machine: a Claude record naming one repository, a Copilot
 * session naming the same one, user-level skills and instructions for both
 * harnesses, and a Copilot plugin from a marketplace that brings a skill and an
 * MCP server. The screen is the Copilot app's structure (sections by kind, a
 * name over where it came from, search and a type filter, the project chosen
 * in the header). The checks read the screen and then the disk — the only file the
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
writeFile(home, ".copilot/settings.json", JSON.stringify({ enabledPlugins: { "tool-pack@demo-market": true } }));
writeFile(home, ".copilot/installed-plugins/demo-market/tool-pack/plugin.json", JSON.stringify({ name: "tool-pack", version: "1.2.3" }));
writeFile(home, ".copilot/installed-plugins/demo-market/tool-pack/skills/pack-skill/SKILL.md", "---\nname: pack-skill\ndescription: From the pack\n---\nbody\n");
writeFile(home, ".copilot/installed-plugins/demo-market/tool-pack/.mcp.json", JSON.stringify({ mcpServers: { "pack-search": { command: "node" } } }));

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
  // I7 provokes the one expected 400: the vocabulary refusing a relative folder.
  if (m.type() === "error" && !m.text().includes("status of 400")) problems.push(m.text());
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

const t = checks("installed e2e");
const rowNames = async () => (await page.locator(".sections li.row .name").allInnerTexts()).map((s) => s.trim());
const row = (name) => page.locator(".sections li.row").filter({ has: page.locator(".name", { hasText: new RegExp(`^${name.replace(/[.@]/g, "\\$&")}$`) }) });
const sectionTitles = async () => (await page.locator(".sections .sec__head h3").allInnerTexts()).map((s) => s.replace(/\s*[(\d][\s\S]*$/, "").trim());
const settings = () => JSON.parse(fs.readFileSync(path.join(home, ".agent-console", "projects.json"), "utf8"));

try {
  await t.check("I1 Installed is the default view: sections by kind for the user unit, from the real engine", async () => {
    await page.goto(server.launchUrl);
    await page.getByRole("heading", { name: "個人", level: 2, exact: true }).waitFor({ timeout: 15000 });
    await page.locator(".sections").waitFor({ timeout: 15000 });
    assert((await page.getByText("参考データ").count()) === 0, "fixture strip is shown");
    const names = await rowNames();
    assert(names.includes("demo-skill") && names.includes("CLAUDE.md"), `rows: ${names}`);
    const titles = await sectionTitles();
    const expected = ["Plugins", "MCP Servers", "Skills", "指示ファイル"];
    assert(JSON.stringify(titles.filter((x) => expected.includes(x))) === JSON.stringify(expected), `sections: ${titles}`);
    // Read-only until P4: nothing in the list is a switch, a checkbox or a button.
    assert((await page.locator('.sections [role="switch"], .sections input, .sections button').count()) === 0, "an operable control in the list");
    return `user rows=${names.length}, sections=${titles.join("/")}`;
  });

  await t.check("I2 a plugin's parts are rows that name the plugin; the plugin names its marketplace", async () => {
    const origin = async (name) => (await row(name).locator(".row__origin").innerText()).trim();
    assert((await origin("pack-skill")) === "Plugin: tool-pack", `pack-skill: ${await origin("pack-skill")}`);
    assert((await origin("pack-search")) === "Plugin: tool-pack", `pack-search: ${await origin("pack-search")}`);
    assert((await origin("tool-pack@demo-market")) === "Marketplace: demo-market", `plugin: ${await origin("tool-pack@demo-market")}`);
    assert((await origin("demo-skill")) === "個人", `demo-skill: ${await origin("demo-skill")}`);
    await row("pack-skill").click();
    const detail = await page.locator("aside.detail").innerText();
    assert(detail.includes("tool-pack@demo-market") && detail.includes("プラグインの行で数える"), `detail: ${detail.slice(0, 300)}`);
    return "Plugin: tool-pack / Marketplace: demo-market";
  });

  await t.check("I3 the type filter narrows to one section, and search finds a part by its plugin", async () => {
    await page.getByLabel("種類").selectOption("mcp");
    assert(JSON.stringify(await sectionTitles()) === JSON.stringify(["MCP Servers"]), `sections: ${await sectionTitles()}`);
    assert((await rowNames()).includes("pack-search"), "pack-search missing under MCP");
    await page.getByLabel("種類").selectOption("all");
    await page.getByLabel("資産を検索").fill("tool-pack");
    const names = await rowNames();
    assert(names.length === 3 && ["tool-pack@demo-market", "pack-skill", "pack-search"].every((n) => names.includes(n)), `search: ${names}`);
    await page.getByLabel("資産を検索").fill("");
    return "mcp only; search by plugin = 3 rows";
  });

  await t.check("I4 one tab stop for the list; ArrowDown crosses into the next section, PageDown skips one", async () => {
    const stops = await page.locator('.sections li.row[tabindex="0"]').count();
    assert(stops === 1, `tab stops in the list: ${stops}`);
    await page.locator(".sections .sec").first().locator("li.row").last().focus();
    const sectionOfFocus = () => page.evaluate(() => document.activeElement?.closest(".sec")?.querySelector("h3")?.textContent?.trim() ?? "");
    await page.keyboard.press("ArrowDown");
    assert((await sectionOfFocus()).startsWith("MCP Servers"), `ArrowDown went to: ${await sectionOfFocus()}`);
    await page.keyboard.press("PageDown");
    assert((await sectionOfFocus()).startsWith("Skills"), `PageDown went to: ${await sectionOfFocus()}`);
    return "ArrowDown -> MCP Servers, PageDown -> Skills";
  });

  await t.check("I5 the project is chosen in the header, and brings its project unit", async () => {
    await page.getByRole("button", { name: /^プロジェクト/ }).click();
    await page.getByRole("button", { name: /sample-repo/ }).click();
    await page.getByRole("heading", { name: "sample-repo", level: 2, exact: true }).waitFor();
    await row("sample-skill").waitFor({ timeout: 15000 });
    const names = await rowNames();
    for (const n of ["sample-skill", "copilot-instructions.md", "sample-mcp"]) assert(names.includes(n), `${n} missing: ${names}`);
    const origin = (await row("sample-skill").locator(".row__origin").innerText()).trim();
    assert(origin === "プロジェクト: sample-repo", `sample-skill: ${origin}`);
    await row("sample-skill").click();
    const detail = await page.locator("aside.detail").innerText();
    assert(detail.includes("Claude") && detail.includes("Copilot"), "detail does not list both harnesses");
    const body = await page.locator("body").innerText();
    assert(!body.includes("E2E-SECRET") && !body.includes("nobody@example.invalid"), "a secret reached the screen");
    return `rows=${names.length}`;
  });

  await t.check("I6 pinning (in the project panel) writes ~/.agent-console/projects.json and nothing else", async () => {
    await page.getByRole("button", { name: /^プロジェクト/ }).click();
    await page.getByRole("button", { name: "上に固定" }).click();
    await page.getByRole("button", { name: "固定を外す" }).waitFor();
    const s = settings();
    assert(s.pinned.length === 1 && s.pinned[0].toLowerCase() === repo.toLowerCase(), JSON.stringify(s));
    return "pinned";
  });

  await t.check("I7 adding a folder: a relative path is refused beside the field, an absolute one is added", async () => {
    await page.getByLabel("フォルダを手で足す").fill("relative\\path");
    await page.getByRole("button", { name: "追加", exact: true }).click();
    await page.locator("#add-error").waitFor();
    assert(settings().added.length === 0, "a refused folder was saved");
    await page.getByLabel("git 外のフォルダも出す", { exact: false }).check();
    await page.getByLabel("フォルダを手で足す").fill(extra);
    await page.getByRole("button", { name: "追加", exact: true }).click();
    await page.getByRole("button", { name: /loose-folder/ }).waitFor();
    assert(settings().added.some((p) => p.toLowerCase() === extra.toLowerCase()), JSON.stringify(settings()));
    await page.getByLabel("フォルダを手で足す").focus();
    await page.keyboard.press("Escape");
    assert((await page.locator("#project-panel").count()) === 0, "Escape did not close the project panel");
    return "added; Escape closes the panel";
  });

  await t.check("I8 canary: no file outside ~/.agent-console changed (hash and mtime)", async () => {
    const after = { ...canary(home), ...canary(work) };
    const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
    assert(changed.length === 0, `changed: ${changed.join(", ")}`);
    return `${Object.keys(before).length} files unchanged`;
  });

  await t.check("I9 no console errors", async () => {
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
