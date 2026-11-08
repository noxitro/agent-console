/**
 * Everything the agents-manager GUI could do, done in a browser against the
 * agent-console server (ARCHITECTURE.md「フェーズとゲート」 P1 gate: "am で GUI から出来たことが、ブラウザで
 * 全部できる"). The engine runs against a throwaway AC_HOME, and every write the
 * GUI makes is checked on disk afterwards — the screen is not taken as proof.
 *
 *   node e2e/gui.e2e.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { chromium } from "playwright";

import { assert, checks, makeHome, seedMachine, startServer, writeFile } from "./harness.mjs";

const home = makeHome("ac-e2e-gui-");
seedMachine(home);
// P2「単位とプロジェクト」: one git working tree that Claude Code has recorded,
// with a project skill and a local MCP server, so the scope segment has rows.
const projectRoot = path.join(home, "work", "proj");
fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
writeFile(home, "work/proj/.claude/skills/proj-skill/SKILL.md", "---\nname: proj-skill\ndescription: A project skill\n---\n\n# proj-skill\n");
writeFile(
  home,
  ".claude.json",
  `${JSON.stringify({ projects: { [projectRoot.split(path.sep).join("/")]: { mcpServers: { "local-db": { command: "db" } } } } }, null, 2)}\n`,
);
const server = await startServer(home);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 992 } });
const page = await context.newPage();
const problems = [];
page.on("console", (m) => {
  // G8 provokes the one expected 409 (the stale-plan refusal).
  if (m.type() === "error" && !m.text().includes("status of 409")) problems.push(m.text());
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

const t = checks("gui e2e");
const exists = (rel) => fs.existsSync(path.join(home, rel));
const manifest = () => JSON.parse(fs.readFileSync(path.join(home, ".agents-manager/manifest.json"), "utf8"));
const rowNames = async () =>
  (await page.locator('table[aria-label="資産一覧"] tbody tr').allInnerTexts()).map((s) => s.split(/\s/)[0]);
const idle = () => page.waitForFunction(() => document.querySelectorAll('[aria-busy="true"]').length === 0, null, { timeout: 15000 });

try {
  await t.check("G1 the launch link opens the console and drops the code from the URL", async () => {
    await page.goto(server.launchUrl);
    await page.getByRole("heading", { name: "agent-console" }).waitFor();
    assert(new URL(page.url()).search === "", `url still carries a query: ${page.url()}`);
    return page.url();
  });

  await t.check("G2 the first survey runs the real engine (inventory + doctor), not the fixture", async () => {
    await page.getByText("走査が完了しました").waitFor({ timeout: 15000 });
    assert((await page.getByText("参考データ").count()) === 0, "fixture strip is shown");
    const names = await rowNames();
    assert(names.includes("demo-skill") && names.includes("second-skill"), `rows: ${names}`);
    assert((await page.getByText(home, { exact: false }).count()) > 0, "source root of the fake HOME not shown");
    return `skills=${names.join(",")}`;
  });

  await t.check("G3 the MCP / AGENTS / COMMANDS tabs list the seeded assets", async () => {
    const seen = {};
    for (const [tab, name] of [["MCP", "docs"], ["AGENTS", "code-reviewer"], ["COMMANDS", "run-tests"]]) {
      await page.getByRole("button", { name: tab, exact: true }).click();
      const names = await rowNames();
      assert(names.includes(name), `${tab}: ${names}`);
      seen[tab] = names.join(",");
    }
    await page.getByRole("button", { name: "SKILLS", exact: true }).click();
    return JSON.stringify(seen);
  });

  await t.check("G4 the search box narrows the table", async () => {
    await page.getByRole("searchbox").or(page.getByLabel("資産を絞り込む")).first().fill("second");
    const names = await rowNames();
    assert(names.length === 1 && names[0] === "second-skill", `rows: ${names}`);
    await page.getByLabel("資産を絞り込む").fill("");
    return names.join(",");
  });

  await t.check("G5 the target filter can be selected and reset", async () => {
    const group = page.getByRole("radiogroup", { name: "ターゲットで絞り込む" });
    const count = page.locator(".count");
    const before = await count.innerText();
    await group.getByRole("radio", { name: "claude", exact: true }).click();
    assert((await group.getByRole("radio", { name: "claude", exact: true }).getAttribute("aria-checked")) === "true", "claude not checked");
    // Before a plan, whether a row concerns claude is not decided yet, so the
    // listing answers with its "needs a plan" state instead of the rows.
    const after = (await count.innerText()) + " / " + (await page.locator(".scroller").innerText()).slice(0, 60);
    await group.getByRole("radio", { name: "すべて" }).click();
    assert((await count.innerText()) === before, "すべて did not restore the listing");
    return `${before} → ${after.replace(/\s+/g, " ")}`;
  });

  await t.check("G5b the scope segment defaults to 個人 and switches to the project and local scopes", async () => {
    const group = page.getByRole("radiogroup", { name: "単位で絞り込む" });
    const radio = (name) => group.getByRole("radio", { name, exact: true });
    assert((await radio("個人").getAttribute("aria-checked")) === "true", "個人 is not the default");
    const personal = await rowNames();
    assert(!personal.includes("proj-skill"), `project row shown under 個人: ${personal}`);

    await radio("プロジェクト").click();
    await page.locator('table[aria-label="資産一覧"] tbody tr', { hasText: "proj-skill" }).waitFor();
    const project = await rowNames();
    assert(project.length === 1 && project[0] === "proj-skill", `project rows: ${project}`);
    const table = page.locator('table[aria-label="資産一覧"]');
    // Read-only: no switch and no delete on a project row.
    assert((await table.getByRole("switch").count()) === 0, "a project row draws a switch");
    assert((await table.getByRole("button", { name: /をソースから削除$/ }).count()) === 0, "a project row draws a delete button");
    assert((await table.getByText("読み取りのみ").count()) === 1, "read-only marker missing");
    assert((await page.getByRole("combobox", { name: "プロジェクト" }).count()) === 1, "project picker missing");

    await page.getByRole("button", { name: "MCP", exact: true }).click();
    await radio("ローカル").click();
    const local = await rowNames();
    assert(local.length === 1 && local[0] === "local-db", `local rows: ${local}`);

    await radio("個人").click();
    await page.getByRole("button", { name: "SKILLS", exact: true }).click();
    const back = await rowNames();
    assert(back.join(",") === personal.join(","), `個人 did not restore: ${back}`);
    assert((await page.getByRole("combobox", { name: "プロジェクト" }).count()) === 0, "picker shown under 個人");
    return `個人=${personal.join(",")} プロジェクト=${project.join(",")} ローカル=${local.join(",")}`;
  });

  await t.check("G6 selecting a row fills the detail pane", async () => {
    // The name cell, not the row's centre: since the 単位 column was added the
    // centre of a row is its 状態 switch, and a click there toggles the asset.
    await page.locator('table[aria-label="資産一覧"] tbody tr', { hasText: "demo-skill" }).locator("th").click();
    const detail = page.getByRole("complementary", { name: "資産の詳細" });
    await detail.getByText("A demo skill for the e2e run").waitFor();
    await page.keyboard.press("Escape");
    return "description shown";
  });

  await t.check("G7 差分を取る takes a plan through the server (digest-bound)", async () => {
    await page.getByRole("button", { name: "差分を取る" }).last().click();
    await idle();
    await page.getByRole("button", { name: /^plan の状態/ }).waitFor();
    const label = await page.getByRole("button", { name: /^plan の状態/ }).getAttribute("aria-label");
    assert(label !== null && !label.includes("未取得"), `plan label: ${label}`);
    return label;
  });

  await t.check("G8 a plan that changed behind the dialog is refused, and nothing is written", async () => {
    writeFile(home, ".agents/skills/late-skill/SKILL.md", "---\nname: late-skill\ndescription: Arrived after the plan\n---\n\n# late\n");
    await page.getByRole("button", { name: "一括適用…" }).last().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "適用する" }).click();
    await page.getByText("確認画面を出した後に plan が変わった", { exact: false }).first().waitFor({ timeout: 15000 });
    assert(!exists(".claude/skills/demo-skill"), "apply ran despite a changed plan");
    fs.rmSync(path.join(home, ".agents/skills/late-skill"), { recursive: true });
    const close = page.getByRole("button", { name: "閉じる" });
    if (await close.count()) await close.first().click();
    // The stale plan is dropped, so the screen no longer offers it again.
    const label = await page.getByRole("button", { name: /^plan の状態/ }).getAttribute("aria-label");
    assert(label !== null && label.includes("未取得"), `plan still on screen: ${label}`);
    return `409 shown, demo-skill not delivered, ${label}`;
  });

  await t.check("G9 一括適用 → 適用する writes the plan to the fake HOME and re-reads", async () => {
    await page.getByRole("button", { name: "差分を取る" }).last().click();
    await idle();
    await page.getByRole("button", { name: "一括適用…" }).last().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "適用する" }).click();
    await page.waitForFunction(() => !document.querySelector("dialog[open]"), null, { timeout: 15000 });
    await idle();
    for (const rel of [".claude/skills/demo-skill/SKILL.md", ".claude/skills/second-skill/SKILL.md", ".claude/agents/code-reviewer.md"]) {
      assert(exists(rel), `${rel} missing after apply`);
    }
    const label = await page.getByRole("button", { name: /^plan の状態/ }).getAttribute("aria-label");
    return label;
  });

  await t.check("G10 the toggle disables and re-enables an asset in manifest.json", async () => {
    const toggle = page.getByRole("switch").first();
    await toggle.click();
    await page.getByText("demo-skill を無効にしました。").waitFor({ timeout: 15000 });
    assert(manifest().skills.exclude.includes("demo-skill"), `exclude: ${JSON.stringify(manifest().skills)}`);
    await page.getByRole("switch").first().click();
    await page.getByText("demo-skill を有効にしました。").waitFor({ timeout: 15000 });
    assert(!manifest().skills.exclude.includes("demo-skill"), "still excluded");
    return "exclude toggled both ways";
  });

  await t.check("G11 ソースから削除 asks, then removes the skill and names the backup", async () => {
    await page.getByRole("button", { name: "second-skill をソースから削除" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "取消" }).click();
    assert(exists(".agents/skills/second-skill/SKILL.md"), "cancel removed the skill");
    await page.getByRole("button", { name: "second-skill をソースから削除" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "削除する" }).click();
    await page.getByText("second-skill をソースから削除しました。", { exact: false }).waitFor({ timeout: 15000 });
    assert(!exists(".agents/skills/second-skill"), "skill still in the source");
    const backups = fs.readdirSync(path.join(home, ".agents-manager/backups"));
    assert(backups.length > 0, "no backup directory");
    return `backups=${backups.length}`;
  });

  await t.check("G12 the map view renders", async () => {
    await page.getByRole("button", { name: "マップ" }).click();
    assert((await page.getByRole("button", { name: "マップ" }).getAttribute("aria-pressed")) === "true", "not pressed");
    assert((await page.locator("svg").count()) > 0, "no svg");
    await page.getByRole("button", { name: "マップ" }).click();
    return "map on/off";
  });

  await t.check("G13 the doctor drawer opens and closes", async () => {
    await page.getByRole("button", { name: /^doctor 所見/ }).click();
    await page.getByRole("button", { name: "閉じる" }).first().click();
    return "drawer toggled";
  });

  await t.check("G14 no console errors and no CSP violations during the run", async () => {
    assert(problems.length === 0, problems.join("\n"));
    return "0";
  });

  await t.check("G16 narrow windows reflow instead of scrolling the page sideways (WCAG 1.4.10)", async () => {
    const widths = {};
    for (const width of [320, 640, 860]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(150);
      const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      widths[width] = scroll;
      assert(scroll <= inner + 1, `${width}px: the page is ${scroll}px wide`);
    }
    await page.setViewportSize({ width: 1400, height: 992 });
    return JSON.stringify(widths);
  });

  await t.check("G15 終了 stops the server, says so, moves focus to the notice, and freezes the console", async () => {
    const exited = new Promise((resolve) => server.child.once("exit", (code) => resolve(code)));
    await page.getByRole("button", { name: "終了" }).click();
    const notice = page.locator(".strip", { hasText: "サーバーを終了しました。再び使うときは" });
    await notice.waitFor({ timeout: 10000 });
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("still running"), 5000))]);
    assert(code !== "still running", "server process did not exit");
    assert((await page.locator("main.workspace[inert]").count()) === 1, "workspace not inert");
    const focused = await page.evaluate(() => document.activeElement?.textContent ?? "");
    assert(focused.includes("サーバーを終了しました"), `focus is on: ${focused.slice(0, 40)}`);
    assert((await page.title()).startsWith("(終了)"), `title: ${await page.title()}`);
    // Pressing what is still visible does nothing: no fault plate about a dead server.
    await page.getByRole("button", { name: "再走査" }).click({ force: true }).catch(() => {});
    assert((await page.getByText("エンジンが停止しました").count()) === 0, "a fault plate appeared after 終了");
    return `server exit code ${code}; focus on the notice; title marked`;
  });
} finally {
  await browser.close();
  await server.stop();
  fs.rmSync(home, { recursive: true, force: true });
}

// A server that is already gone when a write is pressed: nothing was written,
// and the console must say exactly that — not that a write may be half-done.
{
  const goneHome = makeHome("ac-e2e-gone-");
  seedMachine(goneHome);
  const gone = await startServer(goneHome);
  const b2 = await chromium.launch();
  try {
    await t.check("G17 a write pressed after the server stopped says nothing was written", async () => {
      const p2 = await b2.newPage({ viewport: { width: 1400, height: 992 } });
      await p2.goto(gone.launchUrl);
      await p2.getByText("走査が完了しました").first().waitFor({ timeout: 15000 });
      await gone.stop();
      await p2.getByRole("switch").first().click();
      await p2.getByText("何も書き込んでいません", { exact: false }).first().waitFor({ timeout: 10000 });
      const halfDone = await p2.getByText("書き込みの途中で", { exact: false }).count();
      assert(halfDone === 0, "the console claims a write may be half-done");
      const manifest = JSON.parse(fs.readFileSync(path.join(goneHome, ".agents-manager/manifest.json"), "utf8"));
      assert(manifest.skills.exclude.length === 0, "something was written");
      return "「何も書き込んでいません」, no half-write warning, manifest untouched";
    });
  } finally {
    await b2.close();
    await gone.stop();
    fs.rmSync(goneHome, { recursive: true, force: true });
  }
}

process.exitCode = t.finish();
