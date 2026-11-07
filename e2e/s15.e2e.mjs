/**
 * S15 (ARCHITECTURE.md「守りの検証(S15)」): the local server's guards hold against a real browser.
 *
 *  - A page on another origin, in the same browser profile where the owner has
 *    already opened the console (so a valid cookie exists), cannot read from or
 *    write through the API — not with `fetch`, not with `no-cors`, not with a
 *    form post, not by framing the console.
 *  - DNS rebinding: a name the attacker controls, resolved to 127.0.0.1
 *    (`--host-resolver-rules`), reaches the port but is refused on `Host`.
 *  - No token: a fresh profile gets neither the UI nor the API.
 *  - Positive control: the console itself, with cookie + header, gets through.
 *
 * Every write attempt is checked on disk: `manifest.json` must be unchanged.
 *
 *   node e2e/s15.e2e.mjs
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { chromium } from "playwright";

import { assert, checks, makeHome, seedMachine, startServer } from "./harness.mjs";

const home = makeHome("ac-e2e-s15-");
seedMachine(home);
const manifestPath = path.join(home, ".agents-manager/manifest.json");
const manifestBefore = fs.readFileSync(manifestPath, "utf8");
const server = await startServer(home);
const port = server.port;
const api = `http://127.0.0.1:${port}/api/run`;

// The attacker's site: another origin on loopback, serving whatever we put here.
const evilSawCookies = [];
const evil = http.createServer((req, res) => {
  if (req.headers.cookie) evilSawCookies.push(req.headers.cookie);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><body><h1>evil</h1>
    <form id="f" method="POST" action="${api}" enctype="text/plain">
      <input name='{"args":["disable","skill","demo-skill"],"x":"' value='"}'>
    </form>
    <iframe id="frame" src="http://127.0.0.1:${port}/"></iframe>
  </body></html>`);
});
await new Promise((r) => evil.listen(0, "127.0.0.1", r));
const evilPort = evil.address().port;

const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP rebind.test 127.0.0.1`] });
const t = checks("S15");
const unchanged = () => fs.readFileSync(manifestPath, "utf8") === manifestBefore;

try {
  // The owner's profile: the console is open, so the token cookie exists.
  const owner = await browser.newContext();
  const consolePage = await owner.newPage();
  await consolePage.goto(server.launchUrl);
  await consolePage.getByRole("heading", { name: "agent-console" }).waitFor();
  const cookies = await owner.cookies(`http://127.0.0.1:${port}`);
  const cookie = cookies.find((c) => c.name === `ac_token_${port}`);
  const headerToken = await consolePage.evaluate(() => sessionStorage.getItem("ac-token"));

  await t.check("S15-0 precondition: the owner's profile holds an HttpOnly SameSite=Strict token cookie", async () => {
    assert(cookie !== undefined, "no cookie");
    assert(cookie.httpOnly && cookie.sameSite === "Strict", JSON.stringify({ httpOnly: cookie.httpOnly, sameSite: cookie.sameSite }));
    assert(typeof headerToken === "string" && headerToken.length === 64, "the tab holds no header token");
    assert(headerToken !== cookie.value, "the header token equals the cookie token");
    return `httpOnly=${cookie.httpOnly} sameSite=${cookie.sameSite}; header token in sessionStorage, distinct from the cookie`;
  });

  const evilPage = await owner.newPage();
  await evilPage.goto(`http://127.0.0.1:${evilPort}/`);

  await t.check("S15-1 cross-origin fetch with credentials cannot read the API", async () => {
    const result = await evilPage.evaluate(async (url) => {
      try {
        const r = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ args: ["inventory"] }),
        });
        return `read ${r.status} ${await r.text()}`;
      } catch (e) {
        return `blocked: ${e}`;
      }
    }, api);
    assert(result.startsWith("blocked"), result);
    return result;
  });

  await t.check("S15-2 cross-origin no-cors writes (fetch and form post) change nothing", async () => {
    await evilPage.evaluate(async (url) => {
      for (const body of [
        JSON.stringify({ args: ["disable", "skill", "demo-skill"] }),
        JSON.stringify({ args: ["remove", "skill", "demo-skill", "--yes"] }),
      ]) {
        await fetch(url, { method: "POST", mode: "no-cors", credentials: "include", headers: { "Content-Type": "text/plain" }, body }).catch(() => {});
      }
    }, api);
    await Promise.all([evilPage.waitForEvent("load").catch(() => {}), evilPage.evaluate(() => document.getElementById("f").submit())]);
    const landed = await evilPage.content();
    await evilPage.goto(`http://127.0.0.1:${evilPort}/`);
    assert(unchanged(), "manifest.json changed");
    assert(fs.existsSync(path.join(home, ".agents/skills/demo-skill/SKILL.md")), "skill removed");
    return `manifest unchanged; form post answered: ${landed.replace(/<[^>]+>/g, "").slice(0, 80)}`;
  });

  await t.check("S15-3 a cross-origin page cannot frame the console (frame-ancestors / X-Frame-Options)", async () => {
    const frame = evilPage.frames().find((f) => f.url().includes(`:${port}`));
    let text = "";
    try {
      text = frame ? await frame.locator("body").innerText({ timeout: 2000 }) : "";
    } catch {
      text = "";
    }
    assert(!text.includes("agent-console") || text.includes("agent-console.bat"), `framed: ${text.slice(0, 80)}`);
    return frame ? `frame body: "${text.slice(0, 40)}"` : "frame not created";
  });

  await t.check("S15-4 DNS rebinding: a foreign Host reaching 127.0.0.1 gets 403 for the page and the API", async () => {
    const rebound = await owner.newPage();
    const response = await rebound.goto(`http://rebind.test:${port}/`);
    assert(response.status() === 403, `page status ${response.status()}`);
    const apiStatus = await rebound.evaluate(async () => {
      const r = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: ["disable", "skill", "demo-skill"] }),
      });
      return r.status;
    });
    assert(apiStatus === 403, `api status ${apiStatus}`);
    assert(unchanged(), "manifest.json changed");
    await rebound.close();
    return `page 403, api ${apiStatus}`;
  });

  await t.check("S15-5 a forged Host header from a non-browser client gets 403 even with the token", async () => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/api/run",
          headers: {
            Host: `evil.example:${port}`,
            Cookie: `ac_token_${port}=${cookie.value}`,
            "X-Console-Token": headerToken,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ args: ["disable", "skill", "demo-skill"] }));
    });
    assert(status === 403, `status ${status}`);
    assert(unchanged(), "manifest.json changed");
    return `status ${status}`;
  });

  await t.check("S15-6 no token: a fresh profile gets a 401 page without the token, and the API 401", async () => {
    const stranger = await browser.newContext();
    const page = await stranger.newPage();
    const response = await page.goto(`http://127.0.0.1:${port}/`);
    const html = await page.content();
    assert(response.status() === 401, `page ${response.status()}`);
    assert(!html.includes(cookie.value) && !html.includes(headerToken), "token leaked into the 401 page");
    const statuses = await page.evaluate(async (token) => {
      const call = (headers) =>
        fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ args: ["inventory"] }) }).then((r) => r.status);
      // The header alone (an attacker who somehow learnt the token) is not enough without the cookie.
      return [await call({}), await call({ "X-Console-Token": token })];
    }, headerToken);
    assert(statuses.every((s) => s === 401), `api ${statuses}`);
    const reused = await page.goto(server.launchUrl);
    assert(reused.status() === 401, `a spent launch link opened the console (${reused.status()})`);
    await stranger.close();
    return `page 401, api ${statuses.join("/")}, spent launch link 401`;
  });

  await t.check("S15-7 cookie without the header is refused", async () => {
    const status = await consolePage.evaluate(async () => {
      const r = await fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ args: ["inventory"] }) });
      return r.status;
    });
    assert(status === 401, `status ${status}`);
    return `status ${status}`;
  });

  await t.check("S15-8 positive control: the console with cookie + header gets through", async () => {
    const result = await consolePage.evaluate(async () => {
      const token = sessionStorage.getItem("ac-token");
      const r = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Console-Token": token },
        body: JSON.stringify({ args: ["inventory"] }),
      });
      const body = await r.json();
      return { status: r.status, code: body.code };
    });
    assert(result.status === 200 && result.code === 0, JSON.stringify(result));
    assert(unchanged(), "manifest.json changed");
    return JSON.stringify(result);
  });

  await t.check("S15-9 the cookie reaches another port on 127.0.0.1, but with it alone nothing can be learnt or run", async () => {
    // Cookies are not port-scoped: the owner visiting any other local service hands it the cookie.
    const visit = await owner.newPage();
    await visit.goto(`http://127.0.0.1:${evilPort}/`);
    await visit.close();
    const caught = evilSawCookies.find((c) => c.includes(`ac_token_${port}=`));
    assert(caught !== undefined, "precondition: the other port did not receive the cookie");
    const ask = (method, pathname, headers, body) =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode, body: text }));
        });
        req.on("error", reject);
        req.end(body);
      });
    const index = await ask("GET", "/", { Cookie: caught });
    assert(index.status === 200, `index ${index.status}`);
    assert(!index.body.includes(headerToken), "index.html carries the header token");
    const api = { Cookie: caught, "Content-Type": "application/json" };
    const body = JSON.stringify({ args: ["disable", "skill", "demo-skill"] });
    const noHeader = await ask("POST", "/api/run", api, body);
    const cookieAsHeader = await ask("POST", "/api/run", { ...api, "X-Console-Token": cookie.value }, body);
    assert(noHeader.status === 401 && cookieAsHeader.status === 401, `${noHeader.status}/${cookieAsHeader.status}`);
    assert(unchanged(), "manifest.json changed");
    return `other port saw the cookie; index without header token; api ${noHeader.status}/${cookieAsHeader.status}`;
  });

  await t.check("S15-11 a tab holding a key from an earlier server is refused and switches to the keyless state", async () => {
    const old = await owner.newPage();
    await old.goto(`http://127.0.0.1:${port}/`);
    // What a tab left over from a previous start holds: a well-formed but stale key.
    await old.evaluate(() => sessionStorage.setItem("ac-token", "0".repeat(64)));
    await old.reload();
    await old.locator(".strip", { hasText: "このタブでは操作できません" }).first().waitFor({ timeout: 10000 });
    const plates = await old.getByText("エンジンが停止しました").count();
    const workspaceInert = await old.locator("main.workspace[inert]").count();
    await old.close();
    assert(plates === 0, "a stale-key tab shows an engine fault plate");
    assert(workspaceInert === 1, "a stale-key tab can still be operated");
    assert(unchanged(), "manifest.json changed");
    return "401 → keyless notice, console frozen, no fault plate";
  });

  await t.check("S15-10 a tab opened by typing the address (cookie, no key) says so instead of showing fake data", async () => {
    const typed = await owner.newPage();
    await typed.goto(`http://127.0.0.1:${port}/`);
    await typed.getByText("このタブでは操作できません", { exact: false }).first().waitFor({ timeout: 10000 });
    const stopButton = await typed.getByRole("button", { name: "終了" }).count();
    const plates = await typed.getByText("エンジンが停止しました").count();
    const fixture = await typed.getByText("参考データ").count();
    await typed.close();
    assert(fixture === 0, "fixture strip shown");
    assert(stopButton === 0, "a keyless tab offers 終了");
    assert(plates === 0, "a keyless tab shows an engine fault plate");
    return "keyless notice shown; no fixture, no 終了, no fault plate";
  });
} finally {
  await browser.close();
  await server.stop();
  await new Promise((r) => evil.close(r));
  fs.rmSync(home, { recursive: true, force: true });
}

process.exitCode = t.finish();
