/**
 * The server's guards at the HTTP level (ARCHITECTURE.md「守り」「テスト」): every negative is
 * refused, and only the right combination gets through (positive control). The
 * engine is the real one, run against a throwaway `AC_HOME`.
 *
 * Node's `http.request` is used rather than `fetch` because the point is to
 * send headers a browser would never let a page forge (`Host`, a missing
 * `Origin`) — the browser-side half of S15 is `e2e/s15.spec.mjs`.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createConsoleApp, STALE_PLAN_MARK } from "./app.js";
import { planDigest } from "./engine-runner.js";
import type { EngineRunner, JobResult } from "./engine-queue.js";
import { controlProof, LaunchCodes, newToken } from "./security.js";
import { STALE_PLAN_MARK as UI_STALE_PLAN_MARK } from "../../ui/src/lib/engine.js";

const cookieToken = newToken();
const token = newToken();
const controlKey = newToken();
const launchCodes = new LaunchCodes();
let activity = 0;
let opened = 0;
let server: http.Server;
let port = 0;
let home: string;
let staticRoot: string;
const saved = process.env["AC_HOME"];

function write(rel: string, content: string): void {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function seed(): void {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  write(
    ".agents-manager/manifest.json",
    `${JSON.stringify({ version: 1, targets: { claude: { enabled: true } }, skills: { linkMode: "copy", exclude: [] } }, null, 2)}\n`,
  );
  write(".agents/skills/demo/SKILL.md", "---\nname: demo\ndescription: A demo skill\n---\n\n# demo\n");
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-server-"));
  staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-static-"));
  fs.writeFileSync(path.join(staticRoot, "index.html"), "<!doctype html><html><head><title>t</title></head><body></body></html>");
  fs.writeFileSync(path.join(staticRoot, "app.js"), "console.log(1)");
  process.env["AC_HOME"] = home;
  server = http.createServer(
    createConsoleApp({
      cookieToken,
      headerToken: token,
      controlKey,
      openIntervalMs: 200,
      port: () => port,
      staticRoot,
      allowWrites: true,
      launchCodes,
      onActivity: () => {
        activity++;
      },
      onOpenRequest: () => {
        opened++;
      },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (saved === undefined) delete process.env["AC_HOME"];
  else process.env["AC_HOME"] = saved;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(staticRoot, { recursive: true, force: true });
});

beforeEach(seed);

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function send(
  method: string,
  pathname: string,
  headers: Record<string, string | undefined>,
  body?: string,
): Promise<Reply> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) clean[k] = v;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers: clean }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const good = (): Record<string, string> => ({
  Host: `127.0.0.1:${port}`,
  Origin: `http://127.0.0.1:${port}`,
  Cookie: `ac_token_${port}=${cookieToken}`,
  "X-Console-Token": token,
  "Content-Type": "application/json",
});

function run(args: unknown, extra: Record<string, string | undefined> = {}, digest?: string): Promise<Reply> {
  return send("POST", "/api/run", { ...good(), ...extra }, JSON.stringify({ args, ...(digest !== undefined ? { digest } : {}) }));
}

describe("S15 at the HTTP level: what is refused", () => {
  it("refuses a forged Host (DNS rebinding), even with the right token", async () => {
    for (const host of ["evil.example:" + port, `127.0.0.1:${port + 1}`, "127.0.0.1", "[::1]:" + port]) {
      const reply = await run(["inventory"], { Host: host });
      expect(reply.status, host).toBe(403);
    }
  });

  it("refuses a foreign Origin, even with the right token", async () => {
    for (const origin of ["https://evil.example", "null", `http://127.0.0.1:${port + 1}`]) {
      expect((await run(["inventory"], { Origin: origin })).status, origin).toBe(403);
    }
  });

  it("refuses a cross-site Sec-Fetch-Site", async () => {
    expect((await run(["inventory"], { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await run(["inventory"], { "Sec-Fetch-Site": "same-site" })).status).toBe(403);
  });

  it("refuses a missing or wrong token in the cookie or the header", async () => {
    expect((await run(["inventory"], { Cookie: undefined })).status).toBe(401);
    expect((await run(["inventory"], { "X-Console-Token": undefined })).status).toBe(401);
    expect((await run(["inventory"], { Cookie: `ac_token_${port}=${"0".repeat(64)}` })).status).toBe(401);
    expect((await run(["inventory"], { "X-Console-Token": "x" })).status).toBe(401);
  });

  it("refuses the UI without the cookie", async () => {
    const reply = await send("GET", "/", { Host: `127.0.0.1:${port}` });
    expect(reply.status).toBe(401);
    expect(reply.body).not.toContain(token);
  });

  it("refuses a non-JSON body type (no simple-request CSRF) and GET on the API", async () => {
    expect((await run(["inventory"], { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await send("GET", "/api/run", good())).status).toBe(405);
  });

  it("refuses words outside the vocabulary", async () => {
    for (const args of [["rm"], ["plan", "--exec"], ["remove", "skill", "../x", "--yes"], "inventory", ["plan", "--json"]]) {
      expect((await run(args)).status, JSON.stringify(args)).toBe(400);
    }
  });

  it("refuses import over the API (there is no plan to confirm)", async () => {
    expect((await run(["import"])).status).toBe(403);
  });

  it("says the stale-plan refusal in the words the UI listens for", () => {
    expect(STALE_PLAN_MARK).toBe(UI_STALE_PLAN_MARK);
  });

  it("refuses an apply without a digest, and with a stale one — and writes nothing", async () => {
    expect((await run(["apply", "--yes"])).status).toBe(428);
    expect((await run(["apply", "--yes"], {}, "f".repeat(64))).status).toBe(409);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "demo"))).toBe(false);
  });

  it("refuses an apply whose plan changed after it was shown", async () => {
    const plan = JSON.parse((await run(["plan"])).body) as { digest: string };
    write(".agents/skills/other/SKILL.md", "---\nname: other\ndescription: Another\n---\n\n# other\n");
    const reply = await run(["apply", "--yes"], {}, plan.digest);
    expect(reply.status).toBe(409);
    expect((JSON.parse(reply.body) as { code: number }).code).toBe(2);
    expect(reply.body).toContain(STALE_PLAN_MARK);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "demo"))).toBe(false);
  });

  it("refuses browser requests on the control endpoints", async () => {
    const h = { Host: `127.0.0.1:${port}`, Origin: "https://evil.example" };
    expect((await send("POST", "/control/open", h)).status).toBe(403);
    expect((await send("GET", "/control/ping", { Host: `127.0.0.1:${port}`, "Sec-Fetch-Mode": "cors" })).status).toBe(403);
  });

  it("never sends a CORS header, and sends the CSP", async () => {
    const reply = await run(["inventory"], { Origin: "https://evil.example" });
    expect(Object.keys(reply.headers).some((k) => k.startsWith("access-control-"))).toBe(false);
    expect(reply.headers["content-security-policy"]).toContain("default-src 'self'");
  });

  it("refuses a launch code twice, and a made-up one", async () => {
    const code = launchCodes.issue();
    const h = { Host: `127.0.0.1:${port}` };
    expect((await send("GET", `/launch?code=${code}`, h)).status).toBe(200);
    expect((await send("GET", `/launch?code=${code}`, h)).status).toBe(401);
    expect((await send("GET", `/launch?code=${"a".repeat(64)}`, h)).status).toBe(401);
  });

  it("refuses to serve files outside the UI directory", async () => {
    const h = { Host: `127.0.0.1:${port}`, Cookie: `ac_token_${port}=${cookieToken}` };
    expect((await send("GET", "/..%2f..%2fwindows%2fwin.ini", h)).status).toBeGreaterThanOrEqual(403);
  });
});

describe("S15 at the HTTP level: what gets through (positive control)", () => {
  it("answers the right combination with the engine's own JSON contract", async () => {
    const reply = await run(["inventory"]);
    expect(reply.status).toBe(200);
    const out = JSON.parse(reply.body) as { stdout: string; code: number };
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toHaveProperty("targets");
  });

  it("works without Origin (a local, non-browser client) and on localhost", async () => {
    expect((await run(["doctor"], { Origin: undefined })).status).toBe(200);
    expect((await run(["doctor"], { Host: `localhost:${port}`, Origin: `http://localhost:${port}` })).status).toBe(200);
  });

  it("redeems a launch code for the cookie token, and hands the header token to that one page", async () => {
    const reply = await send("GET", `/launch?code=${launchCodes.issue()}`, { Host: `127.0.0.1:${port}` });
    expect(reply.status).toBe(200);
    const cookie = String(reply.headers["set-cookie"]);
    expect(cookie).toContain(`ac_token_${port}=${cookieToken}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain(token);
    expect(reply.body).toContain(`<meta name="ac-launch-token" content="${token}">`);
    expect(reply.body).toContain('<script src="/launch.js">');
    const js = await send("GET", "/launch.js", { Host: `127.0.0.1:${port}` });
    expect(js.status).toBe(200);
    expect(js.body).toContain("sessionStorage.setItem");
    expect(js.body).not.toContain(token);
  });

  it("never gives the header token to a holder of the cookie alone (the cookie reaches every port)", async () => {
    const reply = await send("GET", "/", { Host: `127.0.0.1:${port}`, Cookie: `ac_token_${port}=${cookieToken}` });
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('<meta name="ac-served" content="1" />');
    expect(reply.body).not.toContain(token);
    expect(reply.body).not.toContain(cookieToken);
    // …and the cookie value is not accepted as the header token either.
    expect((await run(["inventory"], { "X-Console-Token": cookieToken })).status).toBe(401);
  });

  it("serves the UI with the cookie", async () => {
    const reply = await send("GET", "/", { Host: `127.0.0.1:${port}`, Cookie: `ac_token_${port}=${cookieToken}` });
    expect(reply.status).toBe(200);
    const js = await send("GET", "/app.js", { Host: `127.0.0.1:${port}`, Cookie: `ac_token_${port}=${cookieToken}` });
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toContain("text/javascript");
  });

  it("applies exactly the plan whose digest it is given", async () => {
    const planReply = JSON.parse((await run(["plan"])).body) as { digest: string; code: number };
    expect(planReply.code).toBe(1);
    expect(planReply.digest).toMatch(/^[0-9a-f]{64}$/);
    // The same machine answers with the same digest (it is not time-stamped).
    expect((JSON.parse((await run(["plan"])).body) as { digest: string }).digest).toBe(planReply.digest);
    const reply = await run(["apply", "--yes"], {}, planReply.digest);
    expect(reply.status).toBe(200);
    expect((JSON.parse(reply.body) as { code: number }).code).toBe(0);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "demo", "SKILL.md"))).toBe(true);
  });

  it("runs the asset toggles the console offers", async () => {
    const off = JSON.parse((await run(["disable", "skill", "demo"])).body) as { code: number; stdout: string };
    expect(off.code).toBe(0);
    expect(JSON.parse(off.stdout)).toMatchObject({ changed: true });
  });
});

describe("a read-only server", () => {
  it("refuses every write while still answering reads", async () => {
    const ro = http.createServer(
      createConsoleApp({ cookieToken, headerToken: token, controlKey, port: () => roPort, staticRoot: null, allowWrites: false, launchCodes }),
    );
    let roPort = 0;
    await new Promise<void>((resolve) => ro.listen(0, "127.0.0.1", resolve));
    roPort = (ro.address() as { port: number }).port;
    const call = (args: string[]): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: roPort,
            method: "POST",
            path: "/api/run",
            headers: {
              ...good(),
              Host: `127.0.0.1:${roPort}`,
              Origin: `http://127.0.0.1:${roPort}`,
              Cookie: `ac_token_${roPort}=${cookieToken}`,
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify({ args }));
      });
    try {
      expect(await call(["inventory"])).toBe(200);
      for (const args of [["apply", "--yes"], ["disable", "skill", "demo"], ["remove", "skill", "demo", "--yes"]]) {
        expect(await call(args), args.join(" ")).toBe(403);
      }
    } finally {
      await new Promise<void>((resolve) => ro.close(() => resolve()));
    }
  });
});

/* ------------------------------------------------------------------ */
/* Hardening: each defect pinned by a test                           */
/* ------------------------------------------------------------------ */

/** Send raw bytes, so a request target Node's client would refuse can be sent. */
function sendRaw(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Write without half-closing: a FIN right after the request can make the
    // server drop the connection before it answers.
    const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
    let out = "";
    socket.setEncoding("utf8");
    socket.setTimeout(3000, () => socket.destroy());
    socket.on("data", (c: string) => (out += c));
    socket.on("close", () => resolve(out));
    socket.on("error", reject);
  });
}

describe("the handler cannot be crashed", () => {
  it("answers a malformed request target with 400 and keeps serving", async () => {
    const reply = await sendRaw("GET http://[ HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n");
    expect(reply).toMatch(/^HTTP\/1\.1 (400|403)/);
    const again = await sendRaw(`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    expect(again).toMatch(/^HTTP\/1\.1 400/);
    // It reached the handler (Node's own parser did not reject it first), which
    // is where `new URL` used to throw and take the process down.
    expect(again).toContain("Bad request target.");
    // Positive control: the server is still there.
    expect((await run(["inventory"])).status).toBe(200);
  });
});

describe("cookies and the idle timer", () => {
  it("accepts the real cookie even when a planted same-name cookie comes first", async () => {
    const cookie = `ac_token_${port}=${"0".repeat(64)}; ac_token_${port}=${cookieToken}`;
    expect((await run(["inventory"], { Cookie: cookie })).status).toBe(200);
    expect((await run(["inventory"], { Cookie: `ac_token_${port}=${"0".repeat(64)}` })).status).toBe(401);
  });

  it("counts only authenticated API calls as activity, not static files", async () => {
    const before = activity;
    await send("GET", "/", { Host: `127.0.0.1:${port}`, Cookie: `ac_token_${port}=${cookieToken}` });
    await send("GET", "/app.js", { Host: `127.0.0.1:${port}`, Cookie: `ac_token_${port}=${cookieToken}` });
    expect(activity).toBe(before);
    await run(["inventory"], { "X-Console-Token": "wrong" });
    expect(activity).toBe(before);
    await run(["inventory"]);
    expect(activity).toBe(before + 1);
  });

  it("marks every spelling of the page as served, so a keyless tab never shows the fixture", async () => {
    let checked = 0;
    for (const p of ["/", "/index.html", "/INDEX.HTML", "/Index.Html"]) {
      const reply = await send("GET", p, { Host: `127.0.0.1:${port}`, Cookie: `ac_token_${port}=${cookieToken}` });
      if (reply.status === 200 && String(reply.headers["content-type"]).startsWith("text/html")) {
        expect(reply.body, p).toContain('<meta name="ac-served" content="1" />');
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it("answers /api/ping for the pre-write reachability check", async () => {
    const reply = await send("POST", "/api/ping", good(), "{}");
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ ok: true });
    expect((await send("POST", "/api/ping", { ...good(), "X-Console-Token": undefined }, "{}")).status).toBe(401);
  });
});

describe("the control endpoints: ping proves, open needs the secret", () => {
  const host = (): Record<string, string> => ({ Host: `127.0.0.1:${port}` });

  it("ping answers with HMAC(secret, nonce), and refuses without a nonce", async () => {
    const nonce = "0123456789abcdef0123456789abcdef";
    const reply = await send("GET", `/control/ping?nonce=${nonce}`, host());
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.body) as { app: string; proof: string; writes: boolean };
    expect(body.app).toBe("agent-console");
    expect(body.writes).toBe(true);
    expect(body.proof).toBe(controlProof(controlKey, nonce));
    expect(body.proof).not.toBe(controlProof(newToken(), nonce));
    expect((await send("GET", "/control/ping", host())).status).toBe(400);
    expect(reply.body).not.toContain(controlKey);
  });

  it("open needs the secret and opens at most one tab per interval", async () => {
    const before = opened;
    expect((await send("POST", "/control/open", host())).status).toBe(403);
    expect((await send("POST", "/control/open", { ...host(), "X-Console-Control": "x".repeat(64) })).status).toBe(403);
    expect(opened).toBe(before);
    await new Promise((r) => setTimeout(r, 250));
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await send("POST", "/control/open", { ...host(), "X-Console-Control": controlKey })).status);
    expect(statuses[0]).toBe(200);
    expect(statuses.slice(1).every((s) => s === 429)).toBe(true);
    expect(opened).toBe(before + 1);
  });

  it("keeps a bounded number of launch codes", () => {
    const codes = new LaunchCodes();
    for (let i = 0; i < 100; i++) codes.issue();
    expect(codes.outstanding()).toBe(LaunchCodes.MAX_OUTSTANDING);
    const expired = new LaunchCodes(1);
    expired.issue(0);
    expect(expired.outstanding(10)).toBe(0);
  });
});

describe("shutdown while a write runs", () => {
  it("is refused with 409, and allowed once the write is done", async () => {
    let writing = true;
    const fake: EngineRunner = {
      submit: (): Promise<JobResult> => Promise.resolve({ kind: "output", output: { stdout: "{}", stderr: "", code: 0 } }),
      isWriting: () => writing,
      close: () => Promise.resolve(),
    };
    let stopped = 0;
    let fakePort = 0;
    const s = http.createServer(
      createConsoleApp({
        cookieToken,
        headerToken: token,
        controlKey,
        port: () => fakePort,
        staticRoot: null,
        allowWrites: true,
        launchCodes,
        engine: fake,
        onShutdown: () => {
          stopped++;
        },
      }),
    );
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    fakePort = (s.address() as { port: number }).port;
    const shut = (): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: fakePort,
            method: "POST",
            path: "/api/shutdown",
            headers: {
              ...good(),
              Host: `127.0.0.1:${fakePort}`,
              Origin: `http://127.0.0.1:${fakePort}`,
              Cookie: `ac_token_${fakePort}=${cookieToken}`,
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end("{}");
      });
    try {
      expect(await shut()).toBe(409);
      await new Promise((r) => setImmediate(r));
      expect(stopped).toBe(0);
      writing = false;
      expect(await shut()).toBe(200);
      await new Promise((r) => setImmediate(r));
      expect(stopped).toBe(1);
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });
});

describe("the plan digest is about operations", () => {
  const plan = (before: string, after: string, assetType = "mcp"): string =>
    JSON.stringify({
      actions: [{ kind: "update", target: "claude", assetType, asset: "", path: "/h/.claude.json", detail: "add docs", before, after }],
    });

  it("ignores another program's edits inside a shared MCP file", () => {
    const a = planDigest(["plan"], { stdout: plan('{"n":1}', '{"n":1,"m":2}'), stderr: "", code: 1 });
    const b = planDigest(["plan"], { stdout: plan('{"n":2}', '{"n":2,"m":2}'), stderr: "", code: 1 });
    expect(a).toBe(b);
    const c = planDigest(["plan"], { stdout: plan('{"n":1}', '{"n":1,"mcpServers":{"docs":{"command":"a"}}}'), stderr: "", code: 1 });
    const d = planDigest(["plan"], { stdout: plan('{"n":7}', '{"n":7,"mcpServers":{"docs":{"command":"a"}}}'), stderr: "", code: 1 });
    expect(c).toBe(d);
  });

  it("notices a changed definition of a managed MCP server", () => {
    const a = planDigest(["plan"], { stdout: plan("{}", '{"n":1,"mcpServers":{"docs":{"command":"a"}}}'), stderr: "", code: 1 });
    const b = planDigest(["plan"], { stdout: plan("{}", '{"n":1,"mcpServers":{"docs":{"command":"b"}}}'), stderr: "", code: 1 });
    expect(a).not.toBe(b);
    // opencode.json may carry comments; its table is `mcp`.
    const c = planDigest(["plan"], { stdout: plan("{}", '{\n  // note\n  "mcp": {"docs": {"type": "local"}}\n}'), stderr: "", code: 1 });
    const d = planDigest(["plan"], { stdout: plan("{}", '{\n  "mcp": {"docs": {"type": "remote"}}\n}'), stderr: "", code: 1 });
    expect(c).not.toBe(d);
  });

  it("still notices a different operation, and a different text for a file the tool owns", () => {
    const base = planDigest(["plan"], { stdout: plan("x", "y"), stderr: "", code: 1 });
    const other = JSON.stringify({
      actions: [{ kind: "update", target: "claude", assetType: "mcp", asset: "", path: "/h/.claude.json", detail: "add docs, add web", before: "x", after: "y" }],
    });
    expect(planDigest(["plan"], { stdout: other, stderr: "", code: 1 })).not.toBe(base);
    const owned1 = planDigest(["plan"], { stdout: plan("x", "agent v1", "agent"), stderr: "", code: 1 });
    const owned2 = planDigest(["plan"], { stdout: plan("x", "agent v2", "agent"), stderr: "", code: 1 });
    expect(owned1).not.toBe(owned2);
    expect(planDigest(["plan", "--prune"], { stdout: plan("x", "y"), stderr: "", code: 1 })).not.toBe(base);
  });
});

describe("while the server is shutting down", () => {
  it("answers the API with 503 and the ping with stopping: true", async () => {
    let stoppingNow = false;
    let sPort = 0;
    const s = http.createServer(
      createConsoleApp({
        cookieToken,
        headerToken: token,
        controlKey,
        port: () => sPort,
        staticRoot: null,
        allowWrites: true,
        launchCodes,
        isStopping: () => stoppingNow,
      }),
    );
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    sPort = (s.address() as { port: number }).port;
    const call = (method: string, pathname: string, body?: string): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: sPort,
            method,
            path: pathname,
            headers: {
              ...(pathname.startsWith("/api/") ? { ...good(), Origin: `http://127.0.0.1:${sPort}`, Cookie: `ac_token_${sPort}=${cookieToken}` } : {}),
              Host: `127.0.0.1:${sPort}`,
            },
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (c: string) => (text += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    try {
      const nonce = "a".repeat(32);
      expect((await call("POST", "/api/run", JSON.stringify({ args: ["inventory"] }))).status).toBe(200);
      expect(JSON.parse((await call("GET", `/control/ping?nonce=${nonce}`)).body)).toMatchObject({ stopping: false });
      stoppingNow = true;
      expect((await call("POST", "/api/run", JSON.stringify({ args: ["inventory"] }))).status).toBe(503);
      expect(JSON.parse((await call("GET", `/control/ping?nonce=${nonce}`)).body)).toMatchObject({ stopping: true });
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });
});
