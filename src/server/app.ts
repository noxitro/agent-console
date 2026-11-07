/**
 * The HTTP surface of agent-console (ARCHITECTURE.md「全体構成」).
 *
 * Routes:
 *
 *  - `GET /launch?code=…` — redeem a one-time launch code. Sets the cookie
 *    token and answers a tiny page carrying the **header** token, which
 *    `/launch.js` moves into the tab's `sessionStorage` before going to `/`.
 *    The only place the header token ever leaves the server.
 *  - `GET /launch.js` — that script (public code, no secret, no cookie needed).
 *  - `GET /`, `GET /<static>` — the Svelte UI from `ui/dist`. Needs the cookie.
 *    `index.html` gets `<meta name="ac-served">` (no secret) so the page knows it
 *    is the real console even when its tab holds no header token.
 *  - `POST /api/run` — `{ args, digest? }` → `{ stdout, stderr, code, digest? }`.
 *    Needs cookie + header. `args` is checked against the fixed vocabulary.
 *  - `POST /api/ping` — `{ ok: true }`. Needs cookie + header. The UI calls it
 *    right before a write, so a server that is already gone is reported as
 *    "nothing was written" rather than as a write that may be incomplete.
 *  - `POST /api/shutdown` — stop the server. Needs cookie + header. Refused
 *    with 409 while a write is running (a write is never cut off).
 *  - `GET /control/ping?nonce=…`, `POST /control/open` — for a second launcher
 *    run: "are you agent-console?" and "open a browser window on yourself".
 *    The control secret lives only in the lock file. Ping does not ask for it,
 *    but answers with HMAC(secret, nonce), so only a launcher that read the lock
 *    can tell the real server from an impostor on the port. Open does need the
 *    secret (`X-Console-Control`) and opens at most one tab every few seconds.
 *    Anything that looks like a browser request is refused.
 *
 * Every request passes the `Host` check first. No CORS header is ever sent.
 * A malformed request is answered with 400, and nothing a request does can
 * throw past the handler (a crash would cut a running write in half).
 */

import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";

import { planDigest, type AmOutput } from "./engine-runner.js";
import { InlineEngine, type EngineRunner } from "./engine-queue.js";
import {
  controlProof,
  crossOriginReason,
  hasCookieToken,
  hasHeaderToken,
  header,
  isAllowedHost,
  LaunchCodes,
  looksLikeBrowser,
  RateLimit,
  safeEqual,
  securityHeaders,
  tokenCookie,
} from "./security.js";
import { boundPlanArgs, isWrite, planArgsOf, validateArgs } from "./vocabulary.js";

export interface ConsoleAppOptions {
  /** Secret carried by the HttpOnly cookie. */
  cookieToken: string;
  /** Secret carried by the `X-Console-Token` header. Never derivable from the cookie. */
  headerToken: string;
  /** The port actually bound; read per request because it is known only after listen. */
  port: () => number;
  /** `ui/dist`. `null` serves a placeholder page (API-only tests). */
  staticRoot: string | null;
  /** ARCHITECTURE.md「リスク」: write APIs stay off until the S15 gate is green. */
  allowWrites: boolean;
  launchCodes: LaunchCodes;
  /** Secret for `/control/*`; written only to the lock file. */
  controlKey: string;
  /** Minimum interval between `/control/open` tabs (ms). */
  openIntervalMs?: number;
  /** Called on every authenticated API request (idle timer). Static files do not count. */
  onActivity?: () => void;
  /** True once shutdown has begun: the API answers 503, ping says so. */
  isStopping?: () => boolean;
  onShutdown?: () => void;
  /** `/control/open`: open a browser at a fresh launch URL. */
  onOpenRequest?: () => void;
  /** Where engine jobs run. Defaults to the calling thread (tests). */
  engine?: EngineRunner;
}

/** Phrase in the stale-plan refusal; `ui/src/lib/engine.ts` keys off it. */
export const STALE_PLAN_MARK = "確認画面を出した後に plan が変わった";

const MAX_BODY = 64 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** Moves the launch page's header token into this tab's sessionStorage, then opens the console. */
const LAUNCH_JS = `"use strict";
try {
  var meta = document.querySelector('meta[name="ac-launch-token"]');
  if (meta) sessionStorage.setItem("ac-token", meta.getAttribute("content") || "");
} catch (e) {
  /* storage refused: the console will say the tab holds no key */
}
location.replace("/");
`;

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export function createConsoleApp(options: ConsoleAppOptions): Handler {
  const engine = options.engine ?? new InlineEngine();
  const openLimit = new RateLimit(options.openIntervalMs ?? 3000);

  return (req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      // Nothing a request carries may take the process (and a running write) down.
      if (!res.headersSent) deny(res, 500, `Internal error: ${(err as Error).message ?? String(err)}`);
      else res.destroy();
    }
  };

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const port = options.port();
    const method = req.method ?? "GET";

    // 1. Host — DNS rebinding stops here, before the request target is even parsed.
    if (!isAllowedHost(header(req, "host"), port)) {
      return deny(res, 403, "Host not allowed.");
    }

    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      return deny(res, 400, "Bad request target.");
    }

    if (url.pathname.startsWith("/control/")) {
      return control(req, res, url, method);
    }

    // 2. Cross-origin signals.
    const crossOrigin = crossOriginReason(req, port);
    if (crossOrigin !== null) return deny(res, 403, `Cross-origin request refused (${crossOrigin}).`);

    if (url.pathname === "/launch.js") {
      if (method !== "GET") return deny(res, 405, "Method not allowed.");
      res.writeHead(200, { ...securityHeaders(), "Content-Type": MIME[".js"] as string, "Cache-Control": "no-store" });
      res.end(LAUNCH_JS);
      return;
    }

    if (url.pathname === "/launch") {
      if (method !== "GET") return deny(res, 405, "Method not allowed.");
      const code = url.searchParams.get("code") ?? "";
      if (!options.launchCodes.redeem(code)) {
        return page(res, 401, "起動リンクが無効です", "このリンクは使用済みか期限切れです。agent-console.bat をもう一度実行してください。");
      }
      res.writeHead(200, {
        ...securityHeaders(),
        "Set-Cookie": tokenCookie(port, options.cookieToken),
        "Content-Type": MIME[".html"] as string,
        "Cache-Control": "no-store",
      });
      res.end(
        `<!doctype html><html lang="ja"><head><meta charset="utf-8">` +
          `<meta name="ac-launch-token" content="${options.headerToken}">` +
          `<title>agent-console</title><script src="/launch.js"></script></head>` +
          `<body><p>agent-console を開いています…</p></body></html>`,
      );
      return;
    }

    // 3. Token. Pages need the cookie; the API needs cookie and header.
    if (!hasCookieToken(req, port, options.cookieToken)) {
      if (url.pathname.startsWith("/api/")) return deny(res, 401, "Missing or wrong token.");
      return page(res, 401, "agent-console", "agent-console.bat から開いてください(この画面は起動時のリンクでのみ開けます)。");
    }

    if (url.pathname.startsWith("/api/")) {
      if (!hasHeaderToken(req, options.headerToken)) return deny(res, 401, "Missing or wrong token.");
      if (method !== "POST") return deny(res, 405, "Method not allowed.");
      const type = header(req, "content-type") ?? "";
      if (!type.toLowerCase().startsWith("application/json")) {
        return deny(res, 415, "Content-Type must be application/json.");
      }
      if (options.isStopping?.() === true) {
        return deny(res, 503, "サーバーは終了処理中です。agent-console.bat で起動し直してください。");
      }
      options.onActivity?.();
      if (url.pathname === "/api/run") return apiRun(req, res);
      if (url.pathname === "/api/ping") return json(res, 200, { ok: true });
      if (url.pathname === "/api/shutdown") {
        if (engine.isWriting()) {
          return deny(res, 409, "書き込みの実行中なので終了できません。終わってからもう一度押してください。");
        }
        json(res, 200, { ok: true });
        setImmediate(() => options.onShutdown?.());
        return;
      }
      return deny(res, 404, "Not found.");
    }

    if (method !== "GET" && method !== "HEAD") return deny(res, 405, "Method not allowed.");
    return serveStatic(res, url.pathname);
  }

  function control(req: IncomingMessage, res: ServerResponse, url: URL, method: string): void {
    if (looksLikeBrowser(req)) return deny(res, 403, "Control endpoints are not for browsers.");
    if (url.pathname === "/control/ping" && method === "GET") {
      const nonce = url.searchParams.get("nonce") ?? "";
      if (!/^[0-9a-f]{16,128}$/.test(nonce)) return deny(res, 400, "ping needs a hex nonce.");
      return json(res, 200, {
        app: "agent-console",
        pid: process.pid,
        writes: options.allowWrites,
        stopping: options.isStopping?.() === true,
        proof: controlProof(options.controlKey, nonce),
      });
    }
    if (url.pathname === "/control/open" && method === "POST") {
      const presented = header(req, "x-console-control") ?? "";
      if (!safeEqual(presented, options.controlKey)) return deny(res, 403, "Missing or wrong control secret.");
      if (!openLimit.allow()) return deny(res, 429, "A tab was opened a moment ago.");
      options.onOpenRequest?.();
      return json(res, 200, { ok: true });
    }
    return deny(res, 404, "Not found.");
  }

  function apiRun(req: IncomingMessage, res: ServerResponse): void {
    readBody(req, (err, body) => {
      try {
        runBody(res, err, body);
      } catch (e) {
        if (!res.headersSent) deny(res, 500, `Internal error: ${(e as Error).message ?? String(e)}`);
      }
    });
  }

  function runBody(res: ServerResponse, err: string | null, body: string): void {
    {
      if (err !== null) return deny(res, 413, err);
      let request: { args?: unknown; digest?: unknown };
      try {
        request = JSON.parse(body) as typeof request;
      } catch {
        return deny(res, 400, "Body is not JSON.");
      }
      if (typeof request !== "object" || request === null) return deny(res, 400, "Body is not an object.");
      const checked = validateArgs(request.args);
      if (!checked.ok) return deny(res, 400, checked.message);
      const args = checked.args;
      const writes = isWrite(args);

      if (writes) {
        if (!options.allowWrites) return deny(res, 403, "Write commands are disabled on this server.");
        if (args[0] === "import") {
          // No plan describes an import, so there is nothing to bind a
          // confirmation to. The GUI never offered import; it stays a CLI verb.
          return deny(res, 403, "import is not available over the API; run `ac import` from a terminal.");
        }
      }

      const bound = boundPlanArgs(args);
      let job: Promise<unknown>;
      if (bound !== null) {
        const presented = typeof request.digest === "string" ? request.digest : "";
        if (presented === "") {
          return engineRefusal(res, 428, "適用する plan が示されていないため、何も適用していません。差分を取ってから確認してください。");
        }
        // The fresh plan and the apply run back-to-back on the engine thread.
        job = engine.submit({ kind: "bound", args, planArgs: bound, digest: presented }).then((result) => {
          if (result.kind === "stale") {
            return engineRefusal(
              res,
              409,
              `${STALE_PLAN_MARK}ため、何も適用していません。差分を取り直して、新しい plan を確認してください。`,
            );
          }
          json(res, 200, result.output);
        });
      } else {
        job = engine.submit({ kind: "run", args, writes }).then((result) => {
          if (result.kind !== "output") return deny(res, 500, "Unexpected engine result.");
          const planArgs = planArgsOf(args);
          json(res, 200, planArgs !== null ? { ...result.output, digest: planDigest(planArgs, result.output) } : result.output);
        });
      }
      job.catch((e: unknown) => {
        if (!res.headersSent) deny(res, 500, `Engine failure: ${(e as Error).message ?? String(e)}`);
      });
    }
  }

  function serveStatic(res: ServerResponse, pathname: string): void {
    if (options.staticRoot === null) {
      return page(res, 200, "agent-console", "UI が組み込まれていません(ui/dist なし)。", true);
    }
    const root = path.resolve(options.staticRoot);
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return deny(res, 400, "Bad path.");
    }
    if (rel.includes("\0")) return deny(res, 400, "Bad path.");
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = path.resolve(root, `.${rel}`);
    if (file !== root && !file.startsWith(root + path.sep)) return deny(res, 403, "Outside the UI.");
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return deny(res, 404, "Not found.");
    }
    if (!stat.isFile()) return deny(res, 404, "Not found.");
    const ext = path.extname(file).toLowerCase();
    if (ext === ".html") {
      // Every page carries the mark, whatever spelling reached it (`/INDEX.HTML`,
      // `/index.html/` resolve to the same file on Windows): a keyless tab must
      // never fall back to the fixture machine.
      const html = fs
        .readFileSync(file, "utf8")
        .replace("<head>", `<head>\n    <meta name="ac-served" content="1" />`);
      res.writeHead(200, {
        ...securityHeaders(),
        "Content-Type": MIME[".html"] as string,
        "Cache-Control": "no-store",
      });
      res.end(html);
      return;
    }
    res.writeHead(200, {
      ...securityHeaders(),
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(fs.readFileSync(file));
  }
}

function readBody(req: IncomingMessage, done: (err: string | null, body: string) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let failed = false;
  req.on("data", (chunk: Buffer) => {
    if (failed) return;
    size += chunk.length;
    if (size > MAX_BODY) {
      failed = true;
      done("Body too large.", "");
      req.resume();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (!failed) done(null, Buffer.concat(chunks).toString("utf8"));
  });
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function deny(res: ServerResponse, status: number, message: string): void {
  json(res, status, { error: message });
}

/** A refusal the UI shows like an engine failure (exit 2 with the error envelope). */
function engineRefusal(res: ServerResponse, status: number, message: string): void {
  json(res, status, {
    stdout: JSON.stringify({ error: { message } }),
    stderr: `error: ${message}`,
    code: 2,
  } satisfies AmOutput);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(res: ServerResponse, status: number, title: string, message: string, plain = false): void {
  res.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  const body = plain ? escapeHtml(message) : `<p>${escapeHtml(message)}</p>`;
  res.end(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
      `<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
  );
}
