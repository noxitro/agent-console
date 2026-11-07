#!/usr/bin/env node
/**
 * `node dist/server/main.js` — start the agent-console server and open the UI
 * (ARCHITECTURE.md「起動と終了」). `agent-console.bat` runs this.
 *
 *  - Listens on 127.0.0.1 only. Port 47821 by default; the next free one if taken.
 *  - The lock file `~/.agent-console/server.json` is created **exclusively**
 *    before anything listens, so two launches started together cannot both
 *    become servers. It holds the port, the PID, a hash of the header token, and
 *    the control secret (the lock lives in the owner's profile, which other
 *    users cannot read).
 *  - If a server is already running — the lock's PID is alive and its ping
 *    answers with HMAC(control secret, nonce) — this asks it to open a browser
 *    window and exits.
 *  - Exits after 30 idle minutes (authenticated API calls count as activity),
 *    when the UI's 終了 button is pressed, or on Ctrl+C. A write that is running
 *    is always allowed to finish first.
 *
 * Flags: `--port <n>`, `--no-open`, `--read-only`, `--idle-minutes <n>`.
 * With `--no-open` the one-time launch URL is printed (a JSON line on stdout),
 * which is how the end-to-end tests attach a browser.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { consoleRoot, serverLockPath } from "../core/paths.js";
import { createConsoleApp } from "./app.js";
import { WorkerEngine } from "./engine-queue.js";
import { openInBrowser } from "./exec.js";
import { controlProof, LaunchCodes, newToken, safeEqual, tokenHash } from "./security.js";

export const DEFAULT_PORT = 47821;
const PORT_ATTEMPTS = 20;
/** One week. setTimeout cannot hold more than ~24.8 days, and nothing needs more. */
const MAX_IDLE_MINUTES = 7 * 24 * 60;
/** How long a second launch waits for a server that is still starting. */
const STARTING_WAIT_MS = 10_000;
/** How long a launch waits for a server that is shutting down (it may be finishing a write). */
const STOPPING_WAIT_MS = 60_000;

interface Flags {
  port: number;
  open: boolean;
  allowWrites: boolean;
  idleMinutes: number;
}

interface LockFile {
  app: "agent-console";
  /** 0 while the server is still starting (the lock is taken before listening). */
  port: number;
  pid: number;
  tokenHash: string;
  controlKey: string;
  writes: boolean;
  startedAt: string;
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = { port: DEFAULT_PORT, open: true, allowWrites: true, idleMinutes: 30 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-open") flags.open = false;
    else if (arg === "--read-only") flags.allowWrites = false;
    else if (arg === "--port" || arg === "--idle-minutes") {
      const value = Number(argv[++i]);
      const max = arg === "--port" ? 65535 : MAX_IDLE_MINUTES;
      if (!Number.isInteger(value) || value < 0 || value > max) {
        throw new Error(`${arg} needs a whole number from 0 to ${max}`);
      }
      if (arg === "--port") flags.port = value;
      else flags.idleMinutes = value;
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return flags;
}

function readLock(): LockFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(serverLockPath(), "utf8")) as Partial<LockFile>;
    if (
      parsed.app !== "agent-console" ||
      typeof parsed.port !== "number" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.controlKey !== "string"
    ) {
      return null;
    }
    return parsed as LockFile;
  } catch {
    return null;
  }
}

/** The lock as raw text (to tell "the same stale lock" from "a new one"). */
function readLockText(): string | null {
  try {
    return fs.readFileSync(serverLockPath(), "utf8");
  } catch {
    return null;
  }
}

/**
 * Replace the lock's content atomically (temp file + rename). The lock holds
 * the control secret, so it is created readable by its owner only (`0o600`;
 * on Windows the profile's ACL already keeps other users out).
 */
function writeLock(lock: LockFile): void {
  const tmp = `${serverLockPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, serverLockPath());
}

function request(
  port: number,
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: pathname, timeout: 3000, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Running {
  lock: LockFile;
  writes: boolean;
  /** Shutting down (finishing a write, perhaps): not usable, and not stale either. */
  stopping: boolean;
}

/**
 * Is the server the lock names alive, and really ours?
 *
 *  - A dead PID means a stale lock, whatever answers on that port now (another
 *    process may have taken the port after a crash).
 *  - A live PID whose lock still says port 0 is a server that is starting: wait.
 *  - Otherwise the ping must answer with HMAC(control secret, nonce). A live PID
 *    that does not answer is given a few tries: the engine runs on its own
 *    thread, so the ping should always answer, but a busy machine is not a dead
 *    server, and starting a second one beside it is what this guards against.
 */
async function runningServer(): Promise<Running | null> {
  const deadline = Date.now() + STARTING_WAIT_MS;
  for (;;) {
    const lock = readLock();
    if (lock === null || !pidAlive(lock.pid)) return null;
    if (lock.port === 0) {
      if (Date.now() > deadline) return null;
      await sleep(200);
      continue;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const nonce = randomBytes(16).toString("hex");
      try {
        const { status, body } = await request(lock.port, "GET", `/control/ping?nonce=${nonce}`);
        const parsed = JSON.parse(body) as { app?: string; pid?: number; writes?: boolean; stopping?: boolean; proof?: string };
        const proven =
          status === 200 &&
          parsed.app === "agent-console" &&
          parsed.pid === lock.pid &&
          typeof parsed.proof === "string" &&
          safeEqual(parsed.proof, controlProof(lock.controlKey, nonce));
        return proven ? { lock, writes: parsed.writes === true, stopping: parsed.stopping === true } : null;
      } catch {
        /* not answering (yet) */
      }
    }
    return null;
  }
}

/**
 * Take the lock, or find the server that holds it.
 *
 * `wx` makes the creation exclusive: of two launches racing, exactly one
 * creates the file. A lock left by a dead server is removed and taken again.
 */
async function acquireLock(placeholder: LockFile): Promise<{ acquired: true } | { acquired: false; running: Running }> {
  fs.mkdirSync(consoleRoot(), { recursive: true });
  const stoppingDeadline = Date.now() + STOPPING_WAIT_MS;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const fd = fs.openSync(serverLockPath(), "wx", 0o600);
      fs.writeSync(fd, `${JSON.stringify(placeholder, null, 2)}\n`);
      fs.closeSync(fd);
      return { acquired: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const judged = readLockText();
    const running = await runningServer();
    if (running !== null && !running.stopping) return { acquired: false, running };
    if (running !== null) {
      // The previous server is shutting down — perhaps finishing a write. It
      // removes its lock when it is done; starting beside it is what must not happen.
      if (Date.now() > stoppingDeadline) {
        throw new Error(
          "前のサーバーが終了処理中です(書き込みの完了を待っています)。少し待ってから、もう一度起動してください。",
        );
      }
      await sleep(500);
      attempt--;
      continue;
    }
    // Stale: the lock's owner is gone (or never proved itself). Take it over —
    // but only the very lock that was judged stale: another launch may have
    // replaced it with a live one in the meantime.
    if (readLockText() === judged) {
      try {
        fs.rmSync(serverLockPath(), { force: true });
      } catch {
        /* another launch removed it first; try again */
      }
    }
  }
  throw new Error(`Could not take the lock file ${serverLockPath()}.`);
}

/** Open a browser; a failure is reported, never fatal to the server. */
function tryOpen(url: string): void {
  try {
    openInBrowser(url);
  } catch (err) {
    process.stderr.write(`agent-console: could not open the browser (${(err as Error).message}). Open this link yourself: ${url}\n`);
  }
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export async function startServer(argv: readonly string[]): Promise<number> {
  const flags = parseFlags(argv);

  // Two secrets for the browser — the cookie's, and the header's (handed out
  // once per tab on the launch page) — and one for the launcher (`/control/*`).
  const cookieToken = newToken();
  const headerToken = newToken();
  const controlKey = newToken();
  const lock: LockFile = {
    app: "agent-console",
    port: 0,
    pid: process.pid,
    tokenHash: tokenHash(headerToken),
    controlKey,
    writes: flags.allowWrites,
    startedAt: new Date().toISOString(),
  };

  const taken = await acquireLock(lock);
  if (!taken.acquired) {
    const { lock: other, writes } = taken.running;
    if (!flags.allowWrites && writes) {
      // Asked for a read-only console, but the running one can write: opening it
      // would quietly hand over the writes the flag was meant to keep away.
      emit({ event: "already-running-conflict", port: other.port, pid: other.pid, writes });
      process.stderr.write(
        "agent-console: 書き込みのできるサーバーがすでに動いているので、--read-only では開きません。画面の「終了」でいったん止めてから起動し直してください。\n",
      );
      return 1;
    }
    if (flags.allowWrites && !writes) {
      process.stderr.write(
        "agent-console: 動いているサーバーは --read-only で起動されているので、このタブからは書き込めません。書き込むときは画面の「終了」で止めてから起動し直してください。\n",
      );
    }
    if (flags.port !== DEFAULT_PORT && flags.port !== 0 && flags.port !== other.port) {
      process.stderr.write(`agent-console: すでに ${other.port} 番で動いているサーバーを開きます(--port ${flags.port} は使いません)。\n`);
    }
    if (flags.open) await request(other.port, "POST", "/control/open", { "X-Console-Control": other.controlKey });
    emit({ event: "already-running", port: other.port, pid: other.pid, writes });
    return 0;
  }

  const launchCodes = new LaunchCodes();
  const engine = new WorkerEngine();
  let boundPort = 0;
  let idleTimer: NodeJS.Timeout | null = null;
  let stopping: Promise<void> | null = null;

  const staticRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "dist");
  const launchUrl = (): string => `http://127.0.0.1:${boundPort}/launch?code=${launchCodes.issue()}`;

  const server = http.createServer();

  /**
   * Stop: refuse new work, let a running write finish, then close everything.
   *
   * The server keeps listening until the engine is closed, answering the API
   * with 503 and the ping with `stopping: true`: a launch made meanwhile must
   * see a server that is going away, not a dead one whose lock it may take.
   */
  const shutdown = (): Promise<void> => {
    stopping ??= (async () => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      await engine.close();
      server.close();
      server.closeAllConnections();
      const current = readLock();
      if (current !== null && current.pid === process.pid) {
        try {
          fs.rmSync(serverLockPath(), { force: true });
        } catch {
          /* leave it; the next start sees a dead PID and ignores it */
        }
      }
      emit({ event: "stopped" });
    })();
    return stopping;
  };
  const touch = (): void => {
    if (flags.idleMinutes === 0) return;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // Idle, but a write is still running: look again later instead of cutting it off.
      if (engine.isWriting()) touch();
      else void shutdown();
    }, flags.idleMinutes * 60_000);
    idleTimer.unref();
  };

  server.on(
    "request",
    createConsoleApp({
      cookieToken,
      headerToken,
      controlKey,
      engine,
      port: () => boundPort,
      staticRoot: fs.existsSync(path.join(staticRoot, "index.html")) ? staticRoot : null,
      allowWrites: flags.allowWrites,
      launchCodes,
      onActivity: touch,
      isStopping: () => stopping !== null,
      onShutdown: () => void shutdown(),
      onOpenRequest: () => tryOpen(launchUrl()),
    }),
  );

  try {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
      const port = flags.port === 0 ? 0 : flags.port + attempt;
      try {
        boundPort = await listen(server, port);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || flags.port === 0) break;
      }
    }
    if (lastError !== null) throw lastError;
    writeLock({ ...lock, port: boundPort });
    // The lock must still be ours: if another launch replaced it while this one
    // was starting, two servers would each believe they are the one.
    if (readLock()?.pid !== process.pid) throw new Error("Another agent-console server took the lock while this one was starting.");
  } catch (err) {
    // Remove the lock only if it is still this process's own.
    if (readLock()?.pid === process.pid || readLockText()?.includes(`"pid": ${process.pid},`) === true) {
      fs.rmSync(serverLockPath(), { force: true });
    }
    await engine.close();
    throw err;
  }
  touch();

  // Ctrl+C, and closing the console window (Windows sends SIGHUP and kills the
  // process about ten seconds later): stop properly, so the lock goes away.
  for (const signal of ["SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      void shutdown().then(() => process.exit(0));
    });
  }

  const url = launchUrl();
  emit({ event: "listening", port: boundPort, pid: process.pid, writes: flags.allowWrites, ...(flags.open ? {} : { launchUrl: url }) });
  process.stdout.write(
    `agent-console: http://127.0.0.1:${boundPort}/ で待ち受けています。このウィンドウを閉じるとサーバーが止まります。\n`,
  );
  if (flags.open) tryOpen(url);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && /(^|[\\/])server[\\/]main\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  startServer(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`agent-console: ${(err as Error).message ?? String(err)}\n`);
      process.exitCode = 2;
    });
}
